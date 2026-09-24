const state = {
  categories: [],
  expenses: [],
  month: currentMonth(),
  summaryMonth: currentMonth(),
  summaryExpenses: [],
  editingExpenseId: null,
};

const $ = (id) => document.getElementById(id);
const loginView = $("loginView");
const appView = $("appView");
const expenseDialog = $("expenseDialog");
const categoryDialog = $("categoryDialog");
const subcategoryDialog = $("subcategoryDialog");

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function todayISO() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function money(value) {
  return new Intl.NumberFormat("pl-PL", {
    style: "currency",
    currency: "PLN",
  }).format(Number(value || 0));
}

function monthLabel(month) {
  const [year, m] = month.split("-").map(Number);
  const label = new Intl.DateTimeFormat("pl-PL", {
    month: "long",
    year: "numeric",
  }).format(new Date(year, m - 1, 1));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function dateLabel(dateString) {
  const [year, month, day] = String(dateString).slice(0, 10).split("-");
  return `${day}/${month}/${year}`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (response.status === 401 && url !== "/api/login") {
    showLogin();
    throw new Error("Sesja wygasła");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Wystąpił błąd");
  return data;
}

async function checkAuth() {
  try {
    await api("/api/auth");
    showApp();
  } catch {
    showLogin();
  }
}

function showLogin() {
  loginView.classList.remove("hidden");
  appView.classList.add("hidden");
  $("pinInput").value = "";
}

async function showApp() {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  await Promise.all([loadCategories(), loadExpenses(), loadSummary()]);
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("loginError").textContent = "";
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ pin: $("pinInput").value }),
    });
    await showApp();
  } catch (error) {
    $("loginError").textContent = error.message;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  showLogin();
});

async function loadCategories() {
  state.categories = await api("/api/categories");
  renderCategories();
  fillCategorySelect();
}

async function loadExpenses() {
  state.expenses = await api(`/api/expenses?month=${state.month}`);
  renderExpenses();
  $("monthTitle").textContent = monthLabel(state.month);
  const total = state.expenses.reduce((sum, item) => sum + Number(item.amount), 0);
  $("monthTotal").textContent = money(total);
}

async function loadSummary() {
  const [summary, expenses] = await Promise.all([
    api(`/api/summary?month=${state.summaryMonth}`),
    api(`/api/expenses?month=${state.summaryMonth}`)
  ]);
  state.summaryExpenses = expenses;
  $("summaryMonthTitle").textContent = monthLabel(state.summaryMonth);
  $("summaryTotal").textContent = money(summary.total);
  renderSummary(summary);
  renderSummaryExpenses();
}

function renderExpenses() {
  const target = $("expenseList");
  if (!state.expenses.length) {
    target.innerHTML = '<div class="empty">Brak wydatków w tym miesiącu.<br>Dodaj pierwszy przyciskiem +</div>';
    return;
  }

  target.innerHTML = state.expenses.map((expense) => {
    const secondary = expense.subcategory_name || expense.description || "";
    return `
      <button class="expense-row" type="button" data-expense-id="${expense.id}">
        <span class="expense-main">
          <strong>${escapeHtml(expense.category_name || "Bez kategorii")}</strong>
          <span class="expense-sub">${escapeHtml(secondary)}</span>
        </span>
        <span class="expense-side">
          <strong class="expense-amount">${money(expense.amount)}</strong>
          <span class="expense-date">${dateLabel(expense.expense_date)}</span>
        </span>
      </button>
    `;
  }).join("");

  target.querySelectorAll("[data-expense-id]").forEach((button) => {
    button.addEventListener("click", () => openExpense(Number(button.dataset.expenseId)));
  });
}

function renderSummary(summary) {
  renderCategorySummary(summary.categories || [], Number(summary.total) || 0);
  renderCategorySubcategorySummary(
    summary.categories || [],
    summary.subcategories || [],
    Number(summary.total) || 0
  );
}

function renderCategorySummary(rows, total) {
  const target = $("summaryBars");
  if (!rows.length) {
    target.innerHTML = '<div class="empty">Brak danych dla tego miesiąca.</div>';
    return;
  }

  const safeTotal = total || 1;
  target.innerHTML = rows.map((item) => {
    const pct = Math.round((Number(item.amount) / safeTotal) * 100);
    return `
      <div class="summary-item">
        <div class="summary-top">
          <strong>${escapeHtml(item.category_name)}</strong>
          <strong>${money(item.amount)} · ${pct}%</strong>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      </div>
    `;
  }).join("");
}

function renderCategorySubcategorySummary(categories, subcategories, total) {
  const target = $("subcategorySummary");

  if (!categories.length) {
    target.innerHTML = '<div class="empty">Brak danych dla tego miesiąca.</div>';
    return;
  }

  target.innerHTML = categories.map((category) => {
    const categoryAmount = Number(category.amount || 0);
    const rows = subcategories.filter(
      (item) => item.category_name === category.category_name
    );

    return `
      <div class="category-summary-group">
        <div class="category-summary-head">
          <strong class="category-summary-name">${escapeHtml(category.category_name)}</strong>
          <strong class="category-summary-amount">${money(categoryAmount)}</strong>
        </div>

        <div class="category-summary-subs">
          ${rows.map((item) => {
            const amount = Number(item.amount || 0);
            const pctOfCategory = categoryAmount
              ? Math.round((amount / categoryAmount) * 100)
              : 0;

            return `
              <div class="subcategory-row">
                <span class="subcategory-info">
                  <strong>${escapeHtml(item.subcategory_name)}</strong>
                  <small>${pctOfCategory}%</small>
                </span>
                <strong class="subcategory-amount">${money(amount)}</strong>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }).join("");
}

function renderSummaryExpenses() {
  const target = $("summaryExpenseList");
  if (!target) return;

  if (!state.summaryExpenses.length) {
    target.innerHTML = '<div class="empty">Brak wydatków w tym miesiącu.</div>';
    return;
  }

  target.innerHTML = state.summaryExpenses.map((expense) => {
    const secondary = expense.subcategory_name || expense.description || "";
    return `
      <button class="expense-row summary-expense-row" type="button" data-summary-expense-id="${expense.id}">
        <span class="expense-main">
          <strong>${escapeHtml(expense.category_name || "Bez kategorii")}</strong>
          <span class="expense-sub">${escapeHtml(secondary)}</span>
        </span>
        <span class="expense-side">
          <strong class="expense-amount">${money(expense.amount)}</strong>
          <span class="expense-date">${dateLabel(expense.expense_date)}</span>
        </span>
      </button>
    `;
  }).join("");

  target.querySelectorAll("[data-summary-expense-id]").forEach((button) => {
    button.addEventListener("click", () => openExpense(Number(button.dataset.summaryExpenseId)));
  });
}

function renderCategories() {
  const target = $("categoriesList");
  if (!state.categories.length) {
    target.innerHTML = '<div class="empty">Nie masz jeszcze kategorii. Dodaj pierwszą kategorię.</div>';
    return;
  }

  target.innerHTML = state.categories.map((category) => `
    <div class="category-card">
      <div class="category-title">
        <strong>${escapeHtml(category.name)}</strong>
        <button class="text-btn" type="button" data-add-subcategory="${category.id}">+ Podkategoria</button>
      </div>
      <div class="sub-list">
        ${category.subcategories.map((sub) => `<span class="chip">${escapeHtml(sub.name)}</span>`).join("")}
        ${category.subcategories.length ? "" : '<span class="muted">Brak podkategorii</span>'}
      </div>
    </div>
  `).join("");

  target.querySelectorAll("[data-add-subcategory]").forEach((button) => {
    button.addEventListener("click", () => {
      $("subcategoryCategoryId").value = button.dataset.addSubcategory;
      $("subcategoryNameInput").value = "";
      $("subcategoryError").textContent = "";
      subcategoryDialog.showModal();
    });
  });
}

function fillCategorySelect() {
  const select = $("categorySelect");
  select.innerHTML = '<option value="">Wybierz kategorię</option>' +
    state.categories.map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join("");
  fillSubcategorySelect();
}

function fillSubcategorySelect(selectedId = "") {
  const categoryId = Number($("categorySelect").value);
  const category = state.categories.find((item) => item.id === categoryId);
  const subs = category?.subcategories || [];

  $("subcategorySelect").innerHTML = '<option value="">Bez podkategorii</option>' +
    subs.map((sub) => `<option value="${sub.id}" ${String(sub.id) === String(selectedId) ? "selected" : ""}>${escapeHtml(sub.name)}</option>`).join("");
}

$("categorySelect").addEventListener("change", () => fillSubcategorySelect());

function openExpense(expenseId = null) {
  state.editingExpenseId = expenseId;
  $("expenseError").textContent = "";
  $("deleteExpenseBtn").classList.toggle("hidden", !expenseId);

  if (!expenseId) {
    $("expenseDialogTitle").textContent = "Nowy wydatek";
    $("amountInput").value = "";
    $("descriptionInput").value = "";
    $("dateInput").value = todayISO();
    $("categorySelect").value = "";
    fillSubcategorySelect();
  } else {
    const expense =
      state.expenses.find((item) => item.id === expenseId) ||
      state.summaryExpenses.find((item) => item.id === expenseId);
    if (!expense) return;
    $("expenseDialogTitle").textContent = "Edytuj wydatek";
    $("amountInput").value = expense.amount;
    $("descriptionInput").value = expense.description || "";
    $("dateInput").value = String(expense.expense_date).slice(0, 10);
    $("categorySelect").value = expense.category_id || "";
    fillSubcategorySelect(expense.subcategory_id || "");
  }

  expenseDialog.showModal();
  setTimeout(() => $("amountInput").focus(), 120);
}

$("openAddExpense").addEventListener("click", () => openExpense());
$("fab").addEventListener("click", () => openExpense());

$("expenseForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("expenseError").textContent = "";

  const payload = {
    amount: $("amountInput").value,
    categoryId: $("categorySelect").value,
    subcategoryId: $("subcategorySelect").value || null,
    description: $("descriptionInput").value,
    expenseDate: $("dateInput").value,
  };

  try {
    const url = state.editingExpenseId ? `/api/expenses/${state.editingExpenseId}` : "/api/expenses";
    await api(url, {
      method: state.editingExpenseId ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    expenseDialog.close();
    await Promise.all([loadExpenses(), loadSummary()]);
  } catch (error) {
    $("expenseError").textContent = error.message;
  }
});

$("deleteExpenseBtn").addEventListener("click", async () => {
  if (!state.editingExpenseId) return;
  if (!confirm("Usunąć ten wydatek?")) return;

  try {
    await api(`/api/expenses/${state.editingExpenseId}`, { method: "DELETE" });
    expenseDialog.close();
    await Promise.all([loadExpenses(), loadSummary()]);
  } catch (error) {
    $("expenseError").textContent = error.message;
  }
});

$("addCategoryBtn").addEventListener("click", () => {
  $("categoryNameInput").value = "";
  $("categoryError").textContent = "";
  categoryDialog.showModal();
});

$("categoryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("categoryError").textContent = "";
  try {
    await api("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: $("categoryNameInput").value }),
    });
    categoryDialog.close();
    await loadCategories();
  } catch (error) {
    $("categoryError").textContent = error.message;
  }
});

$("subcategoryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("subcategoryError").textContent = "";
  try {
    const categoryId = $("subcategoryCategoryId").value;
    await api(`/api/categories/${categoryId}/subcategories`, {
      method: "POST",
      body: JSON.stringify({ name: $("subcategoryNameInput").value }),
    });
    subcategoryDialog.close();
    await loadCategories();
  } catch (error) {
    $("subcategoryError").textContent = error.message;
  }
});

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => $(button.dataset.close).close());
});

document.querySelectorAll(".nav-btn").forEach((button) => {
  button.addEventListener("click", async () => {
    document.querySelectorAll(".nav-btn").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");

    const tab = button.dataset.tab;
    $(tab + "Tab").classList.add("active");
    $("fab").classList.toggle("hidden", tab === "settings");

    if (tab === "summary") await loadSummary();
    if (tab === "settings") await loadCategories();
  });
});

function shiftMonth(month, delta) {
  const [year, m] = month.split("-").map(Number);
  const date = new Date(year, m - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

$("prevMonth").addEventListener("click", async () => {
  state.summaryMonth = shiftMonth(state.summaryMonth, -1);
  await loadSummary();
});

$("nextMonth").addEventListener("click", async () => {
  state.summaryMonth = shiftMonth(state.summaryMonth, 1);
  await loadSummary();
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

checkAuth();
