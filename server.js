const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PIN = process.env.APP_PIN;
const SESSION_COOKIE = "finanse_session";
const sessions = new Map();

if (!APP_PIN) {
  console.warn("APP_PIN is not set. Login will be unavailable until it is configured.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireAuth(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token || !sessions.has(token)) {
    return sendError(res, 401, "Brak autoryzacji");
  }
  next();
}

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is not set. Database routes will not work.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subcategories (
      id SERIAL PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(category_id, name)
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
      category_id INTEGER REFERENCES categories(id),
      subcategory_id INTEGER REFERENCES subcategories(id),
      description VARCHAR(300),
      expense_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
    CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);
  `);
}

app.post("/api/login", (req, res) => {
  if (!APP_PIN) return sendError(res, 503, "PIN nie został skonfigurowany na serwerze");

  const pin = String(req.body?.pin || "");
  if (pin !== APP_PIN) return sendError(res, 401, "Nieprawidłowy PIN");

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now() });

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
  });

  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/auth", requireAuth, (req, res) => {
  res.json({ authenticated: true });
});

app.get("/api/categories", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.created_at,
        COALESCE(
          json_agg(
            json_build_object('id', s.id, 'name', s.name)
            ORDER BY s.name
          ) FILTER (WHERE s.id IS NOT NULL),
          '[]'::json
        ) AS subcategories
      FROM categories c
      LEFT JOIN subcategories s ON s.category_id = c.id
      GROUP BY c.id
      ORDER BY c.name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Nie udało się pobrać kategorii");
  }
});

app.post("/api/categories", requireAuth, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return sendError(res, 400, "Podaj nazwę kategorii");

  try {
    const result = await pool.query(
      "INSERT INTO categories(name) VALUES($1) RETURNING *",
      [name]
    );
    res.status(201).json({ ...result.rows[0], subcategories: [] });
  } catch (error) {
    if (error.code === "23505") return sendError(res, 409, "Taka kategoria już istnieje");
    console.error(error);
    sendError(res, 500, "Nie udało się dodać kategorii");
  }
});

app.patch("/api/categories/:id", requireAuth, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return sendError(res, 400, "Podaj nazwę kategorii");

  try {
    const result = await pool.query(
      "UPDATE categories SET name=$1 WHERE id=$2 RETURNING *",
      [name, req.params.id]
    );
    if (!result.rowCount) return sendError(res, 404, "Nie znaleziono kategorii");
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") return sendError(res, 409, "Taka kategoria już istnieje");
    console.error(error);
    sendError(res, 500, "Nie udało się zmienić kategorii");
  }
});

app.delete("/api/categories/:id", requireAuth, async (req, res) => {
  try {
    const used = await pool.query(
      "SELECT 1 FROM expenses WHERE category_id=$1 LIMIT 1",
      [req.params.id]
    );
    if (used.rowCount) {
      return sendError(res, 409, "Kategoria jest używana w wydatkach. Najpierw zmień kategorię tych wydatków.");
    }

    const result = await pool.query("DELETE FROM categories WHERE id=$1", [req.params.id]);
    if (!result.rowCount) return sendError(res, 404, "Nie znaleziono kategorii");
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Nie udało się usunąć kategorii");
  }
});

app.post("/api/categories/:categoryId/subcategories", requireAuth, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return sendError(res, 400, "Podaj nazwę podkategorii");

  try {
    const result = await pool.query(
      "INSERT INTO subcategories(category_id, name) VALUES($1, $2) RETURNING *",
      [req.params.categoryId, name]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") return sendError(res, 409, "Taka podkategoria już istnieje");
    if (error.code === "23503") return sendError(res, 404, "Nie znaleziono kategorii");
    console.error(error);
    sendError(res, 500, "Nie udało się dodać podkategorii");
  }
});

app.patch("/api/subcategories/:id", requireAuth, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return sendError(res, 400, "Podaj nazwę podkategorii");

  try {
    const result = await pool.query(
      "UPDATE subcategories SET name=$1 WHERE id=$2 RETURNING *",
      [name, req.params.id]
    );
    if (!result.rowCount) return sendError(res, 404, "Nie znaleziono podkategorii");
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") return sendError(res, 409, "Taka podkategoria już istnieje");
    console.error(error);
    sendError(res, 500, "Nie udało się zmienić podkategorii");
  }
});

app.delete("/api/subcategories/:id", requireAuth, async (req, res) => {
  try {
    const used = await pool.query(
      "SELECT 1 FROM expenses WHERE subcategory_id=$1 LIMIT 1",
      [req.params.id]
    );
    if (used.rowCount) {
      return sendError(res, 409, "Podkategoria jest używana w wydatkach. Najpierw zmień te wydatki.");
    }

    const result = await pool.query("DELETE FROM subcategories WHERE id=$1", [req.params.id]);
    if (!result.rowCount) return sendError(res, 404, "Nie znaleziono podkategorii");
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Nie udało się usunąć podkategorii");
  }
});

app.get("/api/expenses", requireAuth, async (req, res) => {
  const month = String(req.query.month || "");
  const validMonth = /^\d{4}-\d{2}$/.test(month);

  try {
    const params = [];
    let where = "";
    if (validMonth) {
      params.push(month + "-01");
      where = `
        WHERE e.expense_date >= $1::date
          AND e.expense_date < ($1::date + INTERVAL '1 month')
      `;
    }

    const result = await pool.query(`
      SELECT
        e.id,
        e.amount::float AS amount,
        e.description,
        e.expense_date,
        e.created_at,
        e.category_id,
        e.subcategory_id,
        c.name AS category_name,
        s.name AS subcategory_name
      FROM expenses e
      LEFT JOIN categories c ON c.id = e.category_id
      LEFT JOIN subcategories s ON s.id = e.subcategory_id
      ${where}
      ORDER BY e.expense_date DESC, e.created_at DESC
    `, params);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Nie udało się pobrać wydatków");
  }
});

app.post("/api/expenses", requireAuth, async (req, res) => {
  const amount = Number(req.body?.amount);
  const categoryId = Number(req.body?.categoryId);
  const subcategoryId = req.body?.subcategoryId ? Number(req.body.subcategoryId) : null;
  const description = String(req.body?.description || "").trim() || null;
  const expenseDate = String(req.body?.expenseDate || "");

  if (!Number.isFinite(amount) || amount <= 0) return sendError(res, 400, "Podaj poprawną kwotę");
  if (!Number.isInteger(categoryId)) return sendError(res, 400, "Wybierz kategorię");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) return sendError(res, 400, "Podaj poprawną datę");

  try {
    if (subcategoryId) {
      const subcategory = await pool.query(
        "SELECT 1 FROM subcategories WHERE id=$1 AND category_id=$2",
        [subcategoryId, categoryId]
      );
      if (!subcategory.rowCount) return sendError(res, 400, "Podkategoria nie należy do wybranej kategorii");
    }

    const result = await pool.query(`
      INSERT INTO expenses(amount, category_id, subcategory_id, description, expense_date)
      VALUES($1, $2, $3, $4, $5)
      RETURNING id
    `, [amount, categoryId, subcategoryId, description, expenseDate]);

    res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    if (error.code === "23503") return sendError(res, 400, "Wybrana kategoria nie istnieje");
    console.error(error);
    sendError(res, 500, "Nie udało się zapisać wydatku");
  }
});

app.patch("/api/expenses/:id", requireAuth, async (req, res) => {
  const amount = Number(req.body?.amount);
  const categoryId = Number(req.body?.categoryId);
  const subcategoryId = req.body?.subcategoryId ? Number(req.body.subcategoryId) : null;
  const description = String(req.body?.description || "").trim() || null;
  const expenseDate = String(req.body?.expenseDate || "");

  if (!Number.isFinite(amount) || amount <= 0) return sendError(res, 400, "Podaj poprawną kwotę");
  if (!Number.isInteger(categoryId)) return sendError(res, 400, "Wybierz kategorię");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) return sendError(res, 400, "Podaj poprawną datę");

  try {
    if (subcategoryId) {
      const subcategory = await pool.query(
        "SELECT 1 FROM subcategories WHERE id=$1 AND category_id=$2",
        [subcategoryId, categoryId]
      );
      if (!subcategory.rowCount) return sendError(res, 400, "Podkategoria nie należy do wybranej kategorii");
    }

    const result = await pool.query(`
      UPDATE expenses
      SET amount=$1, category_id=$2, subcategory_id=$3, description=$4, expense_date=$5
      WHERE id=$6
      RETURNING id
    `, [amount, categoryId, subcategoryId, description, expenseDate, req.params.id]);

    if (!result.rowCount) return sendError(res, 404, "Nie znaleziono wydatku");
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Nie udało się zmienić wydatku");
  }
});

app.delete("/api/expenses/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM expenses WHERE id=$1", [req.params.id]);
    if (!result.rowCount) return sendError(res, 404, "Nie znaleziono wydatku");
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Nie udało się usunąć wydatku");
  }
});

app.get("/api/summary", requireAuth, async (req, res) => {
  const month = String(req.query.month || "");
  if (!/^\d{4}-\d{2}$/.test(month)) return sendError(res, 400, "Nieprawidłowy miesiąc");

  try {
    const totalResult = await pool.query(`
      SELECT COALESCE(SUM(amount), 0)::float AS total
      FROM expenses
      WHERE expense_date >= $1::date
        AND expense_date < ($1::date + INTERVAL '1 month')
    `, [month + "-01"]);

    const categoriesResult = await pool.query(`
      SELECT
        COALESCE(c.name, 'Bez kategorii') AS category_name,
        SUM(e.amount)::float AS amount
      FROM expenses e
      LEFT JOIN categories c ON c.id = e.category_id
      WHERE e.expense_date >= $1::date
        AND e.expense_date < ($1::date + INTERVAL '1 month')
      GROUP BY c.id, c.name
      ORDER BY amount DESC
    `, [month + "-01"]);

    res.json({
      total: totalResult.rows[0].total,
      categories: categoriesResult.rows,
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Nie udało się przygotować podsumowania");
  }
});

app.get("/api/export", requireAuth, async (req, res) => {
  try {
    const [categories, subcategories, expenses] = await Promise.all([
      pool.query("SELECT * FROM categories ORDER BY id"),
      pool.query("SELECT * FROM subcategories ORDER BY id"),
      pool.query("SELECT * FROM expenses ORDER BY id"),
    ]);

    res.setHeader("Content-Disposition", 'attachment; filename="finanse-backup.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      categories: categories.rows,
      subcategories: subcategories.rows,
      expenses: expenses.rows,
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Nie udało się utworzyć kopii danych");
  }
});

app.use(express.static("public"));

app.get("*", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Finanse listening on port ${PORT}`));
  })
  .catch((error) => {
    console.error("Database initialization failed", error);
    process.exit(1);
  });
