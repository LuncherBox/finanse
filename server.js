const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PIN = process.env.APP_PIN;
const SESSION_COOKIE = "finanse_session";
const sessions = new Map();
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

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

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return sendError(res, 401, "Brak autoryzacji");

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const result = await pool.query(
      "SELECT id FROM trusted_devices WHERE token_hash=$1 AND expires_at > NOW() LIMIT 1",
      [tokenHash]
    );

    if (!result.rowCount) {
      res.clearCookie(SESSION_COOKIE, { path: "/" });
      return sendError(res, 401, "Brak autoryzacji");
    }

    next();
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Nie udało się zweryfikować dostępu");
  }
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

    CREATE TABLE IF NOT EXISTS trusted_devices (
      id SERIAL PRIMARY KEY,
      token_hash CHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trusted_devices_expires_at
      ON trusted_devices(expires_at);

    CREATE TABLE IF NOT EXISTS planned_rules (
      id SERIAL PRIMARY KEY,
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      category_id INTEGER REFERENCES categories(id),
      subcategory_id INTEGER REFERENCES subcategories(id),
      description VARCHAR(300),
      start_date DATE NOT NULL,
      recurrence VARCHAR(20) NOT NULL DEFAULT 'one_time'
        CHECK (recurrence IN ('one_time','monthly','yearly')),
      end_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS planned_overrides (
      id SERIAL PRIMARY KEY,
      rule_id INTEGER NOT NULL REFERENCES planned_rules(id) ON DELETE CASCADE,
      occurrence_date DATE NOT NULL,
      amount NUMERIC(12,2) CHECK (amount > 0),
      category_id INTEGER REFERENCES categories(id),
      subcategory_id INTEGER REFERENCES subcategories(id),
      description VARCHAR(300),
      due_date DATE,
      skipped BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE(rule_id, occurrence_date)
    );

    CREATE TABLE IF NOT EXISTS planned_payments (
      id SERIAL PRIMARY KEY,
      rule_id INTEGER NOT NULL REFERENCES planned_rules(id) ON DELETE CASCADE,
      occurrence_date DATE NOT NULL,
      expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
      paid_at DATE NOT NULL,
      UNIQUE(rule_id, occurrence_date)
    );

    CREATE INDEX IF NOT EXISTS idx_planned_rules_start_date ON planned_rules(start_date);
    CREATE INDEX IF NOT EXISTS idx_planned_overrides_occurrence ON planned_overrides(occurrence_date);
    CREATE INDEX IF NOT EXISTS idx_planned_payments_occurrence ON planned_payments(occurrence_date);
  `);
}

app.post("/api/login", (req, res) => {
  if (!APP_PIN) return sendError(res, 503, "PIN nie został skonfigurowany na serwerze");

  const clientKey = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const attempt = loginAttempts.get(clientKey);

  if (attempt?.blockedUntil && attempt.blockedUntil > now) {
    return sendError(res, 429, "Za dużo błędnych prób. Spróbuj ponownie później.");
  }

  const pin = String(req.body?.pin || "");
  if (pin !== APP_PIN) {
    const count = (attempt?.count || 0) + 1;
    if (count >= MAX_LOGIN_ATTEMPTS) {
      loginAttempts.set(clientKey, { count: 0, blockedUntil: now + LOGIN_BLOCK_MS });
      return sendError(res, 429, "Za dużo błędnych prób. Dostęp został czasowo zablokowany.");
    }
    loginAttempts.set(clientKey, { count, blockedUntil: null });
    return sendError(res, 401, "Nieprawidłowy PIN");
  }

  loginAttempts.delete(clientKey);

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  pool.query(
    "INSERT INTO trusted_devices(token_hash, expires_at) VALUES($1, NOW() + INTERVAL '90 days')",
    [tokenHash]
  ).then(() => {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production"),
      sameSite: "strict",
      path: "/",
      maxAge: 90 * 24 * 60 * 60 * 1000,
    });

    res.json({ ok: true });
  }).catch((error) => {
    console.error(error);
    sendError(res, 500, "Nie udało się zapisać zaufanego urządzenia");
  });
});

app.post("/api/logout", async (req, res) => {
  try {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      await pool.query("DELETE FROM trusted_devices WHERE token_hash=$1", [tokenHash]);
    }
  } catch (error) {
    console.error(error);
  }

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


function isoDate(value) {
  return value ? String(value).slice(0, 10) : null;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function occurrenceForMonth(rule, month) {
  const [year, mon] = month.split("-").map(Number);
  const start = isoDate(rule.start_date);
  const end = isoDate(rule.end_date);
  const [sy, sm, sd] = start.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth(year, mon)).padStart(2, "0")}`;

  if (start > monthEnd || (end && end < monthStart)) return null;

  if (rule.recurrence === "one_time") {
    return start.slice(0, 7) === month ? start : null;
  }

  if (rule.recurrence === "yearly" && sm !== mon) return null;

  if (rule.recurrence === "monthly" || rule.recurrence === "yearly") {
    const day = Math.min(sd, daysInMonth(year, mon));
    const candidate = `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (candidate < start || (end && candidate > end)) return null;
    return candidate;
  }

  return null;
}

async function validateCategoryPair(categoryId, subcategoryId) {
  if (!Number.isInteger(categoryId)) return false;
  if (!subcategoryId) return true;
  const result = await pool.query(
    "SELECT 1 FROM subcategories WHERE id=$1 AND category_id=$2",
    [subcategoryId, categoryId]
  );
  return Boolean(result.rowCount);
}

async function resolvePlannedOccurrence(ruleId, occurrenceDate) {
  const ruleResult = await pool.query(`
    SELECT pr.*, c.name AS category_name, s.name AS subcategory_name
    FROM planned_rules pr
    LEFT JOIN categories c ON c.id=pr.category_id
    LEFT JOIN subcategories s ON s.id=pr.subcategory_id
    WHERE pr.id=$1
  `, [ruleId]);
  if (!ruleResult.rowCount) return null;
  const rule = ruleResult.rows[0];

  const overrideResult = await pool.query(`
    SELECT po.*, c.name AS override_category_name, s.name AS override_subcategory_name
    FROM planned_overrides po
    LEFT JOIN categories c ON c.id=po.category_id
    LEFT JOIN subcategories s ON s.id=po.subcategory_id
    WHERE po.rule_id=$1 AND po.occurrence_date=$2
  `, [ruleId, occurrenceDate]);
  const o = overrideResult.rows[0];

  if (o?.skipped) return null;

  return {
    rule_id: rule.id,
    occurrence_date: occurrenceDate,
    amount: Number(o?.amount ?? rule.amount),
    category_id: o?.category_id ?? rule.category_id,
    subcategory_id: o?.subcategory_id ?? rule.subcategory_id,
    category_name: o?.override_category_name ?? rule.category_name,
    subcategory_name: o?.override_subcategory_name ?? rule.subcategory_name,
    description: o?.description ?? rule.description,
    due_date: isoDate(o?.due_date) || occurrenceDate,
    recurrence: rule.recurrence,
    end_date: isoDate(rule.end_date),
    start_date: isoDate(rule.start_date),
  };
}

app.get("/api/plans", requireAuth, async (req, res) => {
  const month = String(req.query.month || "");
  if (!/^\d{4}-\d{2}$/.test(month)) return sendError(res, 400, "Nieprawidłowy miesiąc");

  try {
    const rulesResult = await pool.query(`
      SELECT pr.*, c.name AS category_name, s.name AS subcategory_name
      FROM planned_rules pr
      LEFT JOIN categories c ON c.id=pr.category_id
      LEFT JOIN subcategories s ON s.id=pr.subcategory_id
      ORDER BY pr.start_date, pr.id
    `);

    const items = [];
    for (const rule of rulesResult.rows) {
      const occurrenceDate = occurrenceForMonth(rule, month);
      if (!occurrenceDate) continue;

      const effective = await resolvePlannedOccurrence(rule.id, occurrenceDate);
      if (!effective) continue;

      const paidResult = await pool.query(
        "SELECT paid_at, expense_id FROM planned_payments WHERE rule_id=$1 AND occurrence_date=$2",
        [rule.id, occurrenceDate]
      );

      items.push({
        ...effective,
        paid: Boolean(paidResult.rowCount),
        paid_at: paidResult.rowCount ? isoDate(paidResult.rows[0].paid_at) : null,
        expense_id: paidResult.rowCount ? paidResult.rows[0].expense_id : null,
      });
    }

    items.sort((a,b) => a.due_date.localeCompare(b.due_date) || a.rule_id - b.rule_id);
    res.json(items);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Nie udało się pobrać planu");
  }
});

app.post("/api/plans", requireAuth, async (req, res) => {
  const amount = Number(req.body?.amount);
  const categoryId = Number(req.body?.categoryId);
  const subcategoryId = req.body?.subcategoryId ? Number(req.body.subcategoryId) : null;
  const description = String(req.body?.description || "").trim() || null;
  const dueDate = String(req.body?.dueDate || "");
  const recurrence = String(req.body?.recurrence || "one_time");
  const endDate = req.body?.endDate ? String(req.body.endDate) : null;

  if (!Number.isFinite(amount) || amount <= 0) return sendError(res, 400, "Podaj poprawną kwotę");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return sendError(res, 400, "Podaj termin płatności");
  if (!["one_time","monthly","yearly"].includes(recurrence)) return sendError(res, 400, "Nieprawidłowa cykliczność");
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return sendError(res, 400, "Nieprawidłowa data końcowa");
  if (endDate && endDate < dueDate) return sendError(res, 400, "Data końcowa nie może być wcześniejsza niż pierwszy termin");
  if (!(await validateCategoryPair(categoryId, subcategoryId))) return sendError(res, 400, "Wybierz poprawną kategorię i podkategorię");

  try {
    const result = await pool.query(`
      INSERT INTO planned_rules(amount, category_id, subcategory_id, description, start_date, recurrence, end_date)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      RETURNING id
    `, [amount, categoryId, subcategoryId, description, dueDate, recurrence, recurrence === "one_time" ? dueDate : endDate]);
    res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Nie udało się zapisać planowanego wydatku");
  }
});

app.patch("/api/plans/:id", requireAuth, async (req, res) => {
  const ruleId = Number(req.params.id);
  const occurrenceDate = String(req.body?.occurrenceDate || "");
  const scope = String(req.body?.scope || "current");
  const amount = Number(req.body?.amount);
  const categoryId = Number(req.body?.categoryId);
  const subcategoryId = req.body?.subcategoryId ? Number(req.body.subcategoryId) : null;
  const description = String(req.body?.description || "").trim() || null;
  const dueDate = String(req.body?.dueDate || "");
  const recurrence = String(req.body?.recurrence || "one_time");
  const endDate = req.body?.endDate ? String(req.body.endDate) : null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return sendError(res, 400, "Nieprawidłowa data");
  if (!["current","future"].includes(scope)) return sendError(res, 400, "Nieprawidłowy zakres zmiany");
  if (!Number.isFinite(amount) || amount <= 0) return sendError(res, 400, "Podaj poprawną kwotę");
  if (!["one_time","monthly","yearly"].includes(recurrence)) return sendError(res, 400, "Nieprawidłowa cykliczność");
  if (!(await validateCategoryPair(categoryId, subcategoryId))) return sendError(res, 400, "Wybierz poprawną kategorię i podkategorię");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ruleResult = await client.query("SELECT * FROM planned_rules WHERE id=$1 FOR UPDATE", [ruleId]);
    if (!ruleResult.rowCount) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Nie znaleziono planowanego wydatku");
    }
    const rule = ruleResult.rows[0];

    if (scope === "current") {
      await client.query(`
        INSERT INTO planned_overrides(rule_id, occurrence_date, amount, category_id, subcategory_id, description, due_date, skipped)
        VALUES($1,$2,$3,$4,$5,$6,$7,FALSE)
        ON CONFLICT(rule_id, occurrence_date) DO UPDATE SET
          amount=EXCLUDED.amount,
          category_id=EXCLUDED.category_id,
          subcategory_id=EXCLUDED.subcategory_id,
          description=EXCLUDED.description,
          due_date=EXCLUDED.due_date,
          skipped=FALSE
      `, [ruleId, occurrenceDate, amount, categoryId, subcategoryId, description, dueDate]);
    } else {
      const startDate = isoDate(rule.start_date);
      if (startDate === occurrenceDate) {
        await client.query(`
          UPDATE planned_rules
          SET amount=$1, category_id=$2, subcategory_id=$3, description=$4,
              start_date=$5, recurrence=$6, end_date=$7
          WHERE id=$8
        `, [amount, categoryId, subcategoryId, description, dueDate, recurrence, recurrence === "one_time" ? dueDate : endDate, ruleId]);
      } else {
        await client.query(
          "UPDATE planned_rules SET end_date=($1::date - INTERVAL '1 day')::date WHERE id=$2",
          [occurrenceDate, ruleId]
        );
        await client.query(`
          INSERT INTO planned_rules(amount, category_id, subcategory_id, description, start_date, recurrence, end_date)
          VALUES($1,$2,$3,$4,$5,$6,$7)
        `, [amount, categoryId, subcategoryId, description, dueDate, recurrence, recurrence === "one_time" ? dueDate : endDate]);
      }
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    sendError(res, 500, "Nie udało się zmienić planowanego wydatku");
  } finally {
    client.release();
  }
});

app.delete("/api/plans/:id", requireAuth, async (req, res) => {
  const ruleId = Number(req.params.id);
  const occurrenceDate = String(req.body?.occurrenceDate || "");
  const scope = String(req.body?.scope || "current");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) return sendError(res, 400, "Nieprawidłowa data");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ruleResult = await client.query("SELECT * FROM planned_rules WHERE id=$1 FOR UPDATE", [ruleId]);
    if (!ruleResult.rowCount) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Nie znaleziono planowanego wydatku");
    }
    const rule = ruleResult.rows[0];

    if (scope === "future") {
      if (isoDate(rule.start_date) === occurrenceDate) {
        await client.query("DELETE FROM planned_rules WHERE id=$1", [ruleId]);
      } else {
        await client.query(
          "UPDATE planned_rules SET end_date=($1::date - INTERVAL '1 day')::date WHERE id=$2",
          [occurrenceDate, ruleId]
        );
      }
    } else {
      await client.query(`
        INSERT INTO planned_overrides(rule_id, occurrence_date, skipped)
        VALUES($1,$2,TRUE)
        ON CONFLICT(rule_id, occurrence_date) DO UPDATE SET skipped=TRUE
      `, [ruleId, occurrenceDate]);
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    sendError(res, 500, "Nie udało się usunąć planowanego wydatku");
  } finally {
    client.release();
  }
});

app.post("/api/plans/:id/pay", requireAuth, async (req, res) => {
  const ruleId = Number(req.params.id);
  const occurrenceDate = String(req.body?.occurrenceDate || "");
  const amount = Number(req.body?.amount);
  const paidDate = String(req.body?.paidDate || "");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate) || !/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) return sendError(res, 400, "Nieprawidłowa data");
  if (!Number.isFinite(amount) || amount <= 0) return sendError(res, 400, "Podaj poprawną kwotę");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const already = await client.query(
      "SELECT 1 FROM planned_payments WHERE rule_id=$1 AND occurrence_date=$2",
      [ruleId, occurrenceDate]
    );
    if (already.rowCount) {
      await client.query("ROLLBACK");
      return sendError(res, 409, "Ten wydatek jest już oznaczony jako zapłacony");
    }

    const effective = await resolvePlannedOccurrence(ruleId, occurrenceDate);
    if (!effective) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Nie znaleziono planowanego wydatku");
    }

    const expenseResult = await client.query(`
      INSERT INTO expenses(amount, category_id, subcategory_id, description, expense_date)
      VALUES($1,$2,$3,$4,$5)
      RETURNING id
    `, [amount, effective.category_id, effective.subcategory_id, effective.description, paidDate]);

    await client.query(`
      INSERT INTO planned_payments(rule_id, occurrence_date, expense_id, paid_at)
      VALUES($1,$2,$3,$4)
    `, [ruleId, occurrenceDate, expenseResult.rows[0].id, paidDate]);

    await client.query("COMMIT");
    res.json({ ok: true, expenseId: expenseResult.rows[0].id });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    sendError(res, 500, "Nie udało się oznaczyć wydatku jako zapłaconego");
  } finally {
    client.release();
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

    const subcategoriesResult = await pool.query(`
      SELECT
        COALESCE(c.name, 'Bez kategorii') AS category_name,
        COALESCE(s.name, 'Bez podkategorii') AS subcategory_name,
        SUM(e.amount)::float AS amount
      FROM expenses e
      LEFT JOIN categories c ON c.id = e.category_id
      LEFT JOIN subcategories s ON s.id = e.subcategory_id
      WHERE e.expense_date >= $1::date
        AND e.expense_date < ($1::date + INTERVAL '1 month')
      GROUP BY c.id, c.name, s.id, s.name
      ORDER BY c.name ASC, amount DESC
    `, [month + "-01"]);

    res.json({
      total: totalResult.rows[0].total,
      categories: categoriesResult.rows,
      subcategories: subcategoriesResult.rows,
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Nie udało się przygotować podsumowania");
  }
});

app.get("/api/export", requireAuth, async (req, res) => {
  try {
    const [categories, subcategories, expenses, plannedRules, plannedOverrides, plannedPayments] = await Promise.all([
      pool.query("SELECT * FROM categories ORDER BY id"),
      pool.query("SELECT * FROM subcategories ORDER BY id"),
      pool.query("SELECT * FROM expenses ORDER BY id"),
      pool.query("SELECT * FROM planned_rules ORDER BY id"),
      pool.query("SELECT * FROM planned_overrides ORDER BY id"),
      pool.query("SELECT * FROM planned_payments ORDER BY id"),
    ]);

    res.setHeader("Content-Disposition", 'attachment; filename="finanse-backup.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      categories: categories.rows,
      subcategories: subcategories.rows,
      expenses: expenses.rows,
      plannedRules: plannedRules.rows,
      plannedOverrides: plannedOverrides.rows,
      plannedPayments: plannedPayments.rows,
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Nie udało się utworzyć kopii danych");
  }
});

app.use(express.static("public"));

app.use((req, res) => {
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
