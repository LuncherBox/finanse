const state = {
  categories: [],
  expenses: [],
  month: currentMonth(),
  summaryMonth: currentMonth(),
  summaryExpenses: [],
  planMonth: currentMonth(),
  plans: [],
  planView: "unpaid",
  activeTab: "expenses",
  editingPlan: null,
  payingPlan: null,
  editingExpenseId: null,
  editingCategoryId: null,
  editingSubcategoryId: null,
};

const $ = (id) => document.getElementById(id);
const loginView = $("loginView");
const appView = $("appView");
const expenseDialog = $("expenseDialog");
const categoryDialog = $("categoryDialog");
const subcategoryDialog = $("subcategoryDialog");
const planDialog = $("planDialog");
const payPlanDialog = $("payPlanDialog");

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
  await Promise.all([loadCategories(), loadExpenses(), loadSummary(), loadPlan()]);
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
  if (document.body.contains($("categoryButtons"))) fillCategorySelect($("categorySelect").value || "");
  if (document.body.contains($("planCategoryButtons"))) fillPlanCategorySelect($("planCategorySelect").value || "");
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

async function loadPlan() {
  const [plans, monthExpenses] = await Promise.all([
    api(`/api/plans?month=${state.planMonth}`),
    api(`/api/expenses?month=${state.planMonth}`)
  ]);

  state.plans = plans;
  $("planMonthTitle").textContent = monthLabel(state.planMonth);

  const planned = plans.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const paid = plans.filter((item) => item.paid).reduce((sum, item) => sum + Number(item.paid_amount ?? item.amount ?? 0), 0);
  const remaining = plans.filter((item) => !item.paid).reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const actual = monthExpenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);

  $("planTotal").textContent = money(planned);
  $("planPaid").textContent = money(paid);
  $("planRemaining").textContent = money(remaining);
  $("planForecast").textContent = money(actual + remaining);

  renderPlan();
}

function renderPlan() {
  const target = $("planList");
  if (!target) return;

  const visible = state.planView === "unpaid"
    ? state.plans.filter((item) => !item.paid)
    : state.plans;

  if (!visible.length) {
    target.innerHTML = '<div class="empty">Brak planowanych wydatków w tym widoku.</div>';
    return;
  }

  const today = todayISO();

  target.innerHTML = visible.map((item) => {
    const overdue = !item.paid && item.due_date < today;
    const recurrenceLabel = item.recurrence === "monthly"
      ? "Co miesiąc"
      : item.recurrence === "yearly"
        ? "Co rok"
        : "";
    const status = item.paid
      ? '<span class="plan-status paid">Zapłacone</span>'
      : overdue
        ? '<span class="plan-status overdue">Po terminie</span>'
        : '<span class="plan-status due">Do zapłaty</span>';

    return `
      <article class="plan-card ${item.paid ? "is-paid" : ""}">
        <button class="plan-card-main" type="button" data-edit-plan="${item.rule_id}" data-occurrence="${item.occurrence_date}">
          <span class="plan-card-copy">
            <span class="plan-card-title">${escapeHtml(item.description || item.subcategory_name || item.category_name || "Planowany wydatek")}</span>
            <span class="plan-card-category">
              ${escapeHtml(item.category_name || "Bez kategorii")}
              ${item.subcategory_name ? " › " + escapeHtml(item.subcategory_name) : ""}
            </span>
            <span class="plan-card-meta">
              ${dateLabel(item.due_date)}
              ${recurrenceLabel ? " · " + recurrenceLabel : ""}
            </span>
          </span>
          <span class="plan-card-side">
            ${status}
            <strong>${money(item.paid_amount ?? item.amount)}</strong>
          </span>
        </button>
        ${item.paid ? "" : `
          <button class="plan-paid-btn" type="button" data-pay-plan="${item.rule_id}" data-pay-occurrence="${item.occurrence_date}">
            ✓ Zapłacone
          </button>
        `}
      </article>
    `;
  }).join("");

  target.querySelectorAll("[data-edit-plan]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.plans.find(
        (row) => row.rule_id === Number(button.dataset.editPlan) &&
          row.occurrence_date === button.dataset.occurrence
      );
      if (item) openPlan(item);
    });
  });

  target.querySelectorAll("[data-pay-plan]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.plans.find(
        (row) => row.rule_id === Number(button.dataset.payPlan) &&
          row.occurrence_date === button.dataset.payOccurrence
      );
      if (item) openPayPlan(item);
    });
  });
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
  renderCategorySummary(
    summary.categories || [],
    summary.subcategories || [],
    Number(summary.total) || 0
  );
}

function renderCategorySummary(categories, subcategories, total) {
  const target = $("summaryBars");
  if (!categories.length) {
    target.innerHTML = '<div class="empty">Brak danych dla tego miesiąca.</div>';
    return;
  }

  const safeTotal = total || 1;

  target.innerHTML = categories.map((category, index) => {
    const amount = Number(category.amount || 0);
    const pct = Math.round((amount / safeTotal) * 100);
    const rows = subcategories.filter(
      (item) => item.category_name === category.category_name
    );

    return `
      <div class="summary-category-card">
        <button class="summary-category-toggle" type="button" data-summary-category="${index}" aria-expanded="false">
          <span class="summary-category-copy">
            <strong>${escapeHtml(category.category_name)}</strong>
            <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
          </span>
          <span class="summary-category-side">
            <strong>${money(amount)} · ${pct}%</strong>
            <span class="summary-toggle-icon" aria-hidden="true">+</span>
          </span>
        </button>

        <div class="summary-subcategory-list" data-summary-subcategories="${index}" hidden>
          ${rows.map((item) => {
            const subAmount = Number(item.amount || 0);
            const subPct = amount ? Math.round((subAmount / amount) * 100) : 0;
            return `
              <div class="summary-subcategory-row">
                <span class="subcategory-info">
                  <strong>${escapeHtml(item.subcategory_name)}</strong>
                  <small>${subPct}%</small>
                </span>
                <strong class="subcategory-amount">${money(subAmount)}</strong>
              </div>
            `;
          }).join("") || '<div class="summary-no-subs">Brak podkategorii</div>'}
        </div>
      </div>
    `;
  }).join("");

  target.querySelectorAll("[data-summary-category]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.summaryCategory;
      const list = target.querySelector(`[data-summary-subcategories="${id}"]`);
      const isOpen = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!isOpen));
      list.hidden = isOpen;
      const icon = button.querySelector(".summary-toggle-icon");
      if (icon) icon.textContent = isOpen ? "+" : "−";
    });
  });
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


function fillPlanCategorySelect(selectedId = "") {
  const target = $("planCategoryButtons");
  $("planCategorySelect").value = selectedId || "";

  target.innerHTML = state.categories.map((category) => {
    const active = String(category.id) === String(selectedId);
    return `
      <button type="button" class="choice-btn ${active ? "active" : ""}" data-plan-category="${category.id}">
        ${escapeHtml(category.name)}
      </button>
    `;
  }).join("");

  target.querySelectorAll("[data-plan-category]").forEach((button) => {
    button.addEventListener("click", () => {
      $("planCategorySelect").value = button.dataset.planCategory;
      target.querySelectorAll(".choice-btn").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      fillPlanSubcategorySelect("", button.dataset.planCategory);
    });
  });

  fillPlanSubcategorySelect("", selectedId);
}

function fillPlanSubcategorySelect(selectedId = "", categoryIdOverride = null) {
  const categoryId = Number(categoryIdOverride || $("planCategorySelect").value);
  const category = state.categories.find((item) => item.id === categoryId);
  const subs = category?.subcategories || [];
  const field = $("planSubcategoryField");
  const target = $("planSubcategoryButtons");

  $("planSubcategorySelect").value = selectedId || "";

  if (!categoryId || !subs.length) {
    field.classList.add("hidden");
    target.innerHTML = "";
    $("planSubcategorySelect").value = "";
    return;
  }

  field.classList.remove("hidden");
  target.innerHTML = `
    <button type="button" class="choice-btn ${!selectedId ? "active" : ""}" data-plan-subcategory="">Bez podkategorii</button>
    ${subs.map((sub) => `
      <button type="button" class="choice-btn ${String(sub.id) === String(selectedId) ? "active" : ""}" data-plan-subcategory="${sub.id}">
        ${escapeHtml(sub.name)}
      </button>
    `).join("")}
  `;

  target.querySelectorAll("[data-plan-subcategory]").forEach((button) => {
    button.addEventListener("click", () => {
      $("planSubcategorySelect").value = button.dataset.planSubcategory;
      target.querySelectorAll(".choice-btn").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
    });
  });
}

function setPlanRecurrence(value) {
  $("planRecurrenceInput").value = value;
  document.querySelectorAll("[data-recurrence]").forEach((button) => {
    button.classList.toggle("active", button.dataset.recurrence === value);
  });
  $("planEndDateField").classList.toggle("hidden", value === "one_time");
}

function setPlanScope(value) {
  $("planScopeInput").value = value;
  document.querySelectorAll("[data-plan-scope]").forEach((button) => {
    button.classList.toggle("active", button.dataset.planScope === value);
  });
}

function defaultDateForMonth(month) {
  if (month === currentMonth()) return todayISO();
  return `${month}-01`;
}

function openPlan(item = null) {
  state.editingPlan = item;
  $("planError").textContent = "";
  $("deletePlanBtn").classList.toggle("hidden", !item);
  $("planDialogTitle").textContent = item ? "Edytuj planowany wydatek" : "Nowy planowany wydatek";

  if (!item) {
    $("planAmountInput").value = "";
    $("planDescriptionInput").value = "";
    $("planDueDateInput").value = defaultDateForMonth(state.planMonth);
    $("planEndDateInput").value = "";
    fillPlanCategorySelect("");
    setPlanRecurrence("one_time");
    setPlanScope("current");
    $("planScopeField").classList.add("hidden");
  } else {
    $("planAmountInput").value = item.amount;
    $("planDescriptionInput").value = item.description || "";
    $("planDueDateInput").value = item.due_date;
    $("planEndDateInput").value = item.end_date || "";
    fillPlanCategorySelect(item.category_id || "");
    fillPlanSubcategorySelect(item.subcategory_id || "", item.category_id || "");
    setPlanRecurrence(item.recurrence || "one_time");
    setPlanScope("current");
    $("planScopeField").classList.toggle("hidden", item.recurrence === "one_time");
  }

  planDialog.showModal();
  setTimeout(() => $("planAmountInput").focus(), 120);
}

function openPayPlan(item) {
  state.payingPlan = item;
  $("payPlanError").textContent = "";
  $("payPlanAmountInput").value = item.amount;
  $("payPlanDateInput").value = todayISO();
  payPlanDialog.showModal();
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
        <div class="category-actions">
          <button class="icon-edit-btn" type="button" data-edit-category="${category.id}" aria-label="Edytuj kategorię">✎</button>
          <button class="text-btn" type="button" data-add-subcategory="${category.id}">+ Podkategoria</button>
        </div>
      </div>
      <div class="sub-list editable-sub-list">
        ${category.subcategories.map((sub) => `
          <span class="editable-chip">
            <span>${escapeHtml(sub.name)}</span>
            <button class="chip-edit-btn" type="button" data-edit-subcategory="${sub.id}" data-subcategory-category="${category.id}" aria-label="Edytuj podkategorię">✎</button>
          </span>
        `).join("")}
        ${category.subcategories.length ? "" : '<span class="muted">Brak podkategorii</span>'}
      </div>
    </div>
  `).join("");

  target.querySelectorAll("[data-add-subcategory]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editingSubcategoryId = null;
      $("subcategoryDialogTitle").textContent = "Nowa podkategoria";
      $("subcategorySubmitBtn").textContent = "Dodaj podkategorię";
      $("subcategoryCategoryId").value = button.dataset.addSubcategory;
      $("subcategoryNameInput").value = "";
      $("subcategoryError").textContent = "";
      subcategoryDialog.showModal();
    });
  });

  target.querySelectorAll("[data-edit-category]").forEach((button) => {
    button.addEventListener("click", () => {
      const categoryId = Number(button.dataset.editCategory);
      const category = state.categories.find((item) => item.id === categoryId);
      if (!category) return;

      state.editingCategoryId = categoryId;
      $("categoryDialogTitle").textContent = "Edytuj kategorię";
      $("categorySubmitBtn").textContent = "Zapisz zmiany";
      $("categoryNameInput").value = category.name;
      $("categoryError").textContent = "";
      categoryDialog.showModal();
    });
  });

  target.querySelectorAll("[data-edit-subcategory]").forEach((button) => {
    button.addEventListener("click", () => {
      const categoryId = Number(button.dataset.subcategoryCategory);
      const subcategoryId = Number(button.dataset.editSubcategory);
      const category = state.categories.find((item) => item.id === categoryId);
      const subcategory = category?.subcategories.find((item) => item.id === subcategoryId);
      if (!subcategory) return;

      state.editingSubcategoryId = subcategoryId;
      $("subcategoryDialogTitle").textContent = "Edytuj podkategorię";
      $("subcategorySubmitBtn").textContent = "Zapisz zmiany";
      $("subcategoryCategoryId").value = categoryId;
      $("subcategoryNameInput").value = subcategory.name;
      $("subcategoryError").textContent = "";
      subcategoryDialog.showModal();
    });
  });
}

function fillCategorySelect(selectedId = "") {
  const target = $("categoryButtons");
  $("categorySelect").value = selectedId || "";

  target.innerHTML = state.categories.map((category) => {
    const active = String(category.id) === String(selectedId);
    return `
      <button
        type="button"
        class="choice-btn ${active ? "active" : ""}"
        data-category-choice="${category.id}"
      >${escapeHtml(category.name)}</button>
    `;
  }).join("");

  target.querySelectorAll("[data-category-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const categoryId = button.dataset.categoryChoice;
      $("categorySelect").value = categoryId;

      target.querySelectorAll(".choice-btn").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");

      fillSubcategorySelect("", categoryId);
    });
  });

  fillSubcategorySelect("", selectedId);
}

function fillSubcategorySelect(selectedId = "", categoryIdOverride = null) {
  const categoryId = Number(categoryIdOverride || $("categorySelect").value);
  const category = state.categories.find((item) => item.id === categoryId);
  const subs = category?.subcategories || [];
  const field = $("subcategoryField");
  const target = $("subcategoryButtons");

  $("subcategorySelect").value = selectedId || "";

  if (!categoryId || !subs.length) {
    field.classList.add("hidden");
    target.innerHTML = "";
    $("subcategorySelect").value = "";
    return;
  }

  field.classList.remove("hidden");

  target.innerHTML = `
    <button
      type="button"
      class="choice-btn ${!selectedId ? "active" : ""}"
      data-subcategory-choice=""
    >Bez podkategorii</button>
    ${subs.map((sub) => {
      const active = String(sub.id) === String(selectedId);
      return `
        <button
          type="button"
          class="choice-btn ${active ? "active" : ""}"
          data-subcategory-choice="${sub.id}"
        >${escapeHtml(sub.name)}</button>
      `;
    }).join("")}
  `;

  target.querySelectorAll("[data-subcategory-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      $("subcategorySelect").value = button.dataset.subcategoryChoice;

      target.querySelectorAll(".choice-btn").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
    });
  });
}

function openExpense(expenseId = null) {
  state.editingExpenseId = expenseId;
  $("expenseError").textContent = "";
  $("deleteExpenseBtn").classList.toggle("hidden", !expenseId);

  if (!expenseId) {
    $("expenseDialogTitle").textContent = "Nowy wydatek";
    $("amountInput").value = "";
    $("descriptionInput").value = "";
    $("dateInput").value = todayISO();
    fillCategorySelect("");
  } else {
    const expense =
      state.expenses.find((item) => item.id === expenseId) ||
      state.summaryExpenses.find((item) => item.id === expenseId);
    if (!expense) return;
    $("expenseDialogTitle").textContent = "Edytuj wydatek";
    $("amountInput").value = expense.amount;
    $("descriptionInput").value = expense.description || "";
    $("dateInput").value = String(expense.expense_date).slice(0, 10);
    fillCategorySelect(expense.category_id || "");
    fillSubcategorySelect(expense.subcategory_id || "", expense.category_id || "");
  }

  expenseDialog.showModal();
  setTimeout(() => $("amountInput").focus(), 120);
}

$("openAddExpense").addEventListener("click", () => openExpense());
$("fab").addEventListener("click", () => {
  if (state.activeTab === "plan") openPlan();
  else openExpense();
});

$("expenseForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("expenseError").textContent = "";

  if (!$("categorySelect").value) {
    $("expenseError").textContent = "Wybierz kategorię";
    return;
  }

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


document.querySelectorAll("[data-recurrence]").forEach((button) => {
  button.addEventListener("click", () => setPlanRecurrence(button.dataset.recurrence));
});

document.querySelectorAll("[data-plan-scope]").forEach((button) => {
  button.addEventListener("click", () => setPlanScope(button.dataset.planScope));
});

document.querySelectorAll("[data-plan-view]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-plan-view]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.planView = button.dataset.planView;
    renderPlan();
  });
});

$("planForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("planError").textContent = "";

  if (!$("planCategorySelect").value) {
    $("planError").textContent = "Wybierz kategorię";
    return;
  }

  const payload = {
    amount: $("planAmountInput").value,
    categoryId: $("planCategorySelect").value,
    subcategoryId: $("planSubcategorySelect").value || null,
    description: $("planDescriptionInput").value,
    dueDate: $("planDueDateInput").value,
    recurrence: $("planRecurrenceInput").value,
    endDate: $("planRecurrenceInput").value === "one_time" ? null : ($("planEndDateInput").value || null),
  };

  try {
    if (state.editingPlan) {
      payload.occurrenceDate = state.editingPlan.occurrence_date;
      payload.scope = state.editingPlan.recurrence === "one_time" ? "current" : $("planScopeInput").value;
      await api(`/api/plans/${state.editingPlan.rule_id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    } else {
      await api("/api/plans", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }

    planDialog.close();
    state.editingPlan = null;
    await loadPlan();
  } catch (error) {
    $("planError").textContent = error.message;
  }
});

$("deletePlanBtn").addEventListener("click", async () => {
  const item = state.editingPlan;
  if (!item) return;

  const scope = item.recurrence === "one_time" ? "current" : $("planScopeInput").value;
  const message = scope === "future"
    ? "Usunąć ten planowany wydatek od tego miesiąca również w przyszłości?"
    : "Usunąć ten planowany wydatek tylko z tego miesiąca?";
  if (!confirm(message)) return;

  try {
    await api(`/api/plans/${item.rule_id}`, {
      method: "DELETE",
      body: JSON.stringify({
        occurrenceDate: item.occurrence_date,
        scope,
      }),
    });
    planDialog.close();
    state.editingPlan = null;
    await loadPlan();
  } catch (error) {
    $("planError").textContent = error.message;
  }
});

$("payPlanForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("payPlanError").textContent = "";
  if (!state.payingPlan) return;

  try {
    await api(`/api/plans/${state.payingPlan.rule_id}/pay`, {
      method: "POST",
      body: JSON.stringify({
        occurrenceDate: state.payingPlan.occurrence_date,
        amount: $("payPlanAmountInput").value,
        paidDate: $("payPlanDateInput").value,
      }),
    });
    payPlanDialog.close();
    state.payingPlan = null;
    await Promise.all([loadPlan(), loadExpenses(), loadSummary()]);
  } catch (error) {
    $("payPlanError").textContent = error.message;
  }
});

$("prevPlanMonth").addEventListener("click", async () => {
  state.planMonth = shiftMonth(state.planMonth, -1);
  await loadPlan();
});

$("nextPlanMonth").addEventListener("click", async () => {
  state.planMonth = shiftMonth(state.planMonth, 1);
  await loadPlan();
});

$("addCategoryBtn").addEventListener("click", () => {
  state.editingCategoryId = null;
  $("categoryDialogTitle").textContent = "Nowa kategoria";
  $("categorySubmitBtn").textContent = "Dodaj kategorię";
  $("categoryNameInput").value = "";
  $("categoryError").textContent = "";
  categoryDialog.showModal();
});

$("categoryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("categoryError").textContent = "";

  try {
    const isEditing = Boolean(state.editingCategoryId);
    await api(
      isEditing ? `/api/categories/${state.editingCategoryId}` : "/api/categories",
      {
        method: isEditing ? "PATCH" : "POST",
        body: JSON.stringify({ name: $("categoryNameInput").value }),
      }
    );

    categoryDialog.close();
    state.editingCategoryId = null;
    await Promise.all([loadCategories(), loadExpenses(), loadSummary()]);
  } catch (error) {
    $("categoryError").textContent = error.message;
  }
});

$("subcategoryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("subcategoryError").textContent = "";

  try {
    const isEditing = Boolean(state.editingSubcategoryId);
    const categoryId = $("subcategoryCategoryId").value;

    await api(
      isEditing
        ? `/api/subcategories/${state.editingSubcategoryId}`
        : `/api/categories/${categoryId}/subcategories`,
      {
        method: isEditing ? "PATCH" : "POST",
        body: JSON.stringify({ name: $("subcategoryNameInput").value }),
      }
    );

    subcategoryDialog.close();
    state.editingSubcategoryId = null;
    await Promise.all([loadCategories(), loadExpenses(), loadSummary()]);
  } catch (error) {
    $("subcategoryError").textContent = error.message;
  }
});

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => $(button.dataset.close).close());
});

document.querySelectorAll("[data-summary-view]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-summary-view]").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".summary-view").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    const view = button.dataset.summaryView;
    $(view === "categories" ? "summaryCategoriesView" : "summaryExpensesView").classList.add("active");
  });
});

document.querySelectorAll(".nav-btn").forEach((button) => {
  button.addEventListener("click", async () => {
    document.querySelectorAll(".nav-btn").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");

    const tab = button.dataset.tab;
    state.activeTab = tab;
    $(tab + "Tab").classList.add("active");
    $("fab").classList.toggle("hidden", tab === "settings");
    $("fab").setAttribute("aria-label", tab === "plan" ? "Dodaj planowany wydatek" : "Dodaj wydatek");

    if (tab === "summary") await loadSummary();
    if (tab === "plan") await loadPlan();
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
