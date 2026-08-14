const KEY = "proptrack_v2";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let state = loadLocal();
let pendingDelete = null;
let cloudReady = false;
let accessToken = localStorage.getItem("proptrack_access_token") || null;
let currentUser = null;
let syncing = false;
let authMode = "login";

/* =========================================================
   BASIC HELPERS
========================================================= */

function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now() + "-" + Math.random();
}

function defaultState() {
  const id = uid();

  return {
    selectedId: id,

    accounts: [
      {
        id,
        firm: "Demo Prop Firm",
        name: "$100K Account",

        accountSize: 100000,
        startingBalance: 100000,

        targetType: "percent",
        targetInput: 8,
        target: 8000,

        maxDdType: "percent",
        maxDdInput: 10,
        maxDd: 10000,

        dailyDdType: "percent",
        dailyDdInput: 5,
        dailyDd: 5000,

        resetTime: "00:00",
        ddMode: "static",
        notes: "",

        trades: [],
      },
    ],
  };
}

function loadLocal() {
  try {
    const x = localStorage.getItem(KEY);

    if (x) {
      return JSON.parse(x);
    }
  } catch (e) {
    console.warn("Local data load failed", e);
  }

  return defaultState();
}

function saveLocal() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

function a() {
  return (
    state.accounts.find((x) => x.id === state.selectedId) || state.accounts[0]
  );
}

function money(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Number(n) || 0);
}

function pct(n) {
  return (Number(n) || 0).toFixed(2) + "%";
}

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[m],
  );
}

/* =========================================================
   ACCOUNT CALCULATIONS
========================================================= */

function bal(x) {
  return (
    Number(x.startingBalance || 0) +
    x.trades.reduce((s, t) => s + Number(t.pnl || 0), 0)
  );
}

function high(x) {
  let b = Number(x.startingBalance || 0);

  let h = b;

  [...x.trades]
    .sort((p, q) => new Date(p.date) - new Date(q.date))
    .forEach((t) => {
      b += Number(t.pnl || 0);
      h = Math.max(h, b);
    });

  return h;
}

function maxUsed(x) {
  const base =
    x.ddMode === "trailing" ? high(x) : Number(x.startingBalance || 0);

  return Math.max(0, base - bal(x));
}

function maxRem(x) {
  return Math.max(0, Number(x.maxDd || 0) - maxUsed(x));
}

function dayKey(d = new Date(), resetTime = "00:00") {
  const date = new Date(d);

  const [hours, minutes] = String(resetTime || "00:00")
    .split(":")
    .map(Number);

  const resetMinutes = (hours * 60) + minutes;

  const currentMinutes =
    date.getHours() * 60 +
    date.getMinutes();

  if (currentMinutes < resetMinutes) {
    date.setDate(date.getDate() - 1);
  }

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function today(x) {
  const currentDay = dayKey(
    new Date(),
    x.resetTime || "00:00"
  );

  return x.trades
    .filter(
      (t) =>
        dayKey(
          t.date,
          x.resetTime || "00:00"
        ) === currentDay
    )
    .reduce(
      (s, t) => s + Number(t.pnl || 0),
      0
    );
}

function dailyRem(x) {
  return Math.max(0, Number(x.dailyDd || 0) + Math.min(0, today(x)));
}

function dailyUsed(x) {
  return Math.max(0, -today(x));
}

function targetRemaining(x) {
  return Math.max(
    0,
    Number(x.target || 0) - (bal(x) - Number(x.startingBalance || 0)),
  );
}

function accountStatus(x) {
  const b = bal(x);

  const profit = b - Number(x.startingBalance || 0);

  const used = maxUsed(x);

  if (used >= Number(x.maxDd || 0)) {
    return ["danger", "FAILED", "Maximum drawdown hit"];
  }

  if (profit >= Number(x.target || 0)) {
    return ["passed", "PASSED", "Profit target achieved"];
  }

  return ["", "SAFE", "Account active"];
}

function statusBadge(x) {
  const [c, t] = accountStatus(x);

  return `<span class="status ${c}">● ${t}</span>`;
}

function risk(r, l) {
  if (r <= 0) return ["danger", "Breached"];

  if (l && 1 - r / l >= 0.75) {
    return ["warning", "Caution"];
  }

  return ["", "Safe"];
}

function badge(c, t) {
  return `<span class="status ${c}">● ${t}</span>`;
}

function fill(n, l) {
  return l ? Math.min(100, Math.max(0, (n / l) * 100)) : 0;
}

function localDT() {
  const d = new Date();

  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());

  return d.toISOString().slice(0, 16);
}

/* =========================================================
   ACCOUNT SWITCHER
========================================================= */

function refreshSwitch() {
  const s = $("#accountSwitcher");

  if (!s) return;

  s.innerHTML = state.accounts
    .map(
      (x) =>
        `<option value="${x.id}" ${
          x.id === state.selectedId ? "selected" : ""
        }>${esc(x.firm)} — ${esc(x.name)}</option>`,
    )
    .join("");
}

/* =========================================================
   CLOUD API
========================================================= */

async function cloud(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (accessToken) {
    headers.Authorization = "Bearer " + accessToken;
  }

  const response = await fetch("/.netlify/functions/api" + path, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Cloud error ${response.status}`);
  }

  return data;
}

/* =========================================================
   AUTH UI
========================================================= */

function showAuth(mode = "login", message = "") {
  authMode = mode;

  $("#authScreen").classList.remove("hidden");

  $("#authTitle").textContent =
    mode === "login" ? "Welcome back" : "Create your account";

  $("#authSubtitle").textContent =
    mode === "login"
      ? "Sign in to access your accounts and trades from anywhere."
      : "Create one account and keep your PropTrack data in the cloud.";

  $("#authSubmit").textContent = mode === "login" ? "Login" : "Create Account";

  $("#authSwitch").textContent =
    mode === "login"
      ? "Create a new account"
      : "Already have an account? Login";

  $("#authError").textContent = message || "";

  $("#authPassword").value = "";

  setTimeout(() => $("#authEmail").focus(), 50);
}

function hideAuth() {
  $("#authScreen").classList.add("hidden");

  $("#userChip").classList.remove("hidden");

  $("#userChipEmail").textContent = currentUser?.email || "";
}

/* =========================================================
   LOGIN / SIGNUP
========================================================= */

async function handleAuth(e) {
  e.preventDefault();

  const email = $("#authEmail").value.trim().toLowerCase();

  const password = $("#authPassword").value;

  if (!email || !password) return;

  $("#authSubmit").disabled = true;

  $("#authError").textContent = "";

  try {
    /*
      Keep the old local data before
      authentication changes anything.
    */

    const oldLocal = JSON.parse(localStorage.getItem(KEY) || "null");

    const endpoint = authMode === "login" ? "login" : "signup";

    const response = await fetch("/.netlify/functions/api/" + endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Authentication failed");
    }

    /*
      IMPORTANT:
      api.js returns { token }
      NOT { access_token }
    */

    accessToken = data.token;

    currentUser = data.user;

    if (!accessToken) {
      throw new Error("Login succeeded but no session token was returned.");
    }

    localStorage.setItem("proptrack_access_token", accessToken);

    localStorage.setItem("proptrack_user_email", currentUser.email);

    cloudReady = true;

    /*
      First try to load cloud data.
    */

    let remote = null;

    try {
      remote = await cloud("/data");
    } catch (err) {
      console.error("Cloud data load failed:", err);
    }

    /*
      If cloud already contains accounts,
      use cloud data.
    */

    if (remote && Array.isArray(remote.accounts) && remote.accounts.length) {
      state = {
        selectedId: state.selectedId,

        accounts: remote.accounts.map(normalizeCloudAccount),
      };

      if (!state.accounts.some((x) => x.id === state.selectedId)) {
        state.selectedId = state.accounts[0].id;
      }

      saveLocal();
    } else if (oldLocal?.accounts?.length) {

    /*
      If cloud is empty but local data
      already exists, upload local data.
    */
      state = oldLocal;

      saveLocal();

      await syncCloud();

      /*
        Fetch again so we know the
        cloud data is actually available.
      */

      try {
        const synced = await cloud("/data");

        if (synced?.accounts?.length) {
          state = {
            selectedId: state.selectedId,

            accounts: synced.accounts.map(normalizeCloudAccount),
          };

          if (!state.accounts.some((x) => x.id === state.selectedId)) {
            state.selectedId = state.accounts[0].id;
          }

          saveLocal();
        }
      } catch (err) {
        console.warn("Second cloud fetch failed:", err);
      }
    }

    hideAuth();

    refreshAll();

    toast(
      authMode === "login"
        ? "Logged in — cloud data loaded."
        : "Account created — cloud sync connected.",
    );
  } catch (err) {
    console.error("AUTH ERROR:", err);

    $("#authError").textContent = err.message || "Unable to sign in.";
  } finally {
    $("#authSubmit").disabled = false;
  }
}

/* =========================================================
   LOGOUT
========================================================= */

async function logout() {
  accessToken = null;
  currentUser = null;
  cloudReady = false;

  localStorage.removeItem("proptrack_access_token");

  localStorage.removeItem("proptrack_user_email");

  $("#userChip").classList.add("hidden");

  showAuth("login");

  toast("Logged out.");
}

// account percentage  calculation mistake solve from here

function normalizeCloudAccount(account) {
  const size = Number(account.accountSize ?? account.account_size ?? 0);

  const start = Number(
    account.startingBalance ?? account.starting_balance ?? size,
  );

  const targetType = account.targetType ?? account.target_type ?? "percent";

  const targetInput = Number(account.targetInput ?? account.target_input ?? 0);

  const maxDdType = account.maxDdType ?? account.max_dd_type ?? "percent";

  const maxDdInput = Number(account.maxDdInput ?? account.max_dd_input ?? 0);

  const dailyDdType = account.dailyDdType ?? account.daily_dd_type ?? "percent";

  const dailyDdInput = Number(
    account.dailyDdInput ?? account.daily_dd_input ?? 0,
  );

  return {
    ...account,

    accountSize: size,
    startingBalance: start,

    targetType,
    targetInput,

    target:
      targetType === "percent" ? (start * targetInput) / 100 : targetInput,

    maxDdType,
    maxDdInput,

    maxDd: maxDdType === "percent" ? (size * maxDdInput) / 100 : maxDdInput,

    dailyDdType,
    dailyDdInput,

    dailyDd:
      dailyDdType === "percent" ? (size * dailyDdInput) / 100 : dailyDdInput,

    resetTime: account.resetTime ?? account.reset_time ?? "00:00",

    ddMode: account.ddMode ?? account.dd_mode ?? "static",

    trades: Array.isArray(account.trades) ? account.trades : [],
  };
}
/* =========================================================
   INITIAL CLOUD LOAD
========================================================= */

async function initCloud() {
  if (!accessToken) {
    showAuth("login");
    return;
  }

  try {
    const me = await cloud("/me");

    currentUser = me.user;

    cloudReady = true;

    hideAuth();

    /*
      Load cloud data.
    */

    const remote = await cloud("/data");

    if (remote && Array.isArray(remote.accounts) && remote.accounts.length) {
      state = {
  selectedId: state.selectedId,
  accounts: remote.accounts.map(normalizeCloudAccount),
};

      if (!state.accounts.some((x) => x.id === state.selectedId)) {
        state.selectedId = state.accounts[0].id;
      }

      saveLocal();
    }

    refreshAll();

    toast("Cloud sync connected.");
  } catch (e) {
    console.warn("Cloud initialization failed:", e);

    localStorage.removeItem("proptrack_access_token");

    accessToken = null;
    currentUser = null;
    cloudReady = false;

    showAuth("login", "Your session expired. Please log in again.");
  }
}

/* =========================================================
   SYNC TO CLOUD
========================================================= */

async function syncCloud() {
  if (!cloudReady || syncing || !accessToken) {
    return;
  }

  syncing = true;

  try {
    await cloud("/sync", {
      method: "POST",

      body: JSON.stringify({
        accounts: state.accounts,
      }),
    });
  } catch (e) {
    console.warn("Cloud sync failed:", e);

    toast("Saved locally; cloud sync failed.");
  } finally {
    syncing = false;
  }
}

function save() {
  saveLocal();
  syncCloud();
}

/* =========================================================
   DASHBOARD
========================================================= */

function renderDashboard() {
  const v = $("#dashboardView");

  const x = a();

  if (!x) {
    v.innerHTML =
      '<div class="empty"><strong>No account</strong>Add an account first.</div>';

    return;
  }

  const b = bal(x);
  const mr = maxRem(x);
  const mu = maxUsed(x);
  const dr = dailyRem(x);
  const tp = today(x);
  const tr = targetRemaining(x);

  const [mc, mt] = risk(mr, x.maxDd);

  const [dc, dt] = risk(dr, x.dailyDd);

  v.innerHTML = `
    <div class="grid metrics">

      <div class="metric">
        <div class="label">
          Account Balance
        </div>

        <div class="value">
          ${money(b)}
        </div>

        <div class="muted">
          ${b - x.startingBalance >= 0 ? "+" : ""}${money(
            b - x.startingBalance,
          )} overall
        </div>
      </div>

      <div class="metric">
        <div class="label">
          Profit Target Remaining
        </div>

        <div class="value">
          ${money(tr)}
        </div>

        <div class="muted">
          Target ${money(x.target)} ·
          ${pct(fill(Math.max(0, b - x.startingBalance), x.target))} complete
        </div>
      </div>

      <div class="metric">
        <div class="label">
          Max DD Remaining
        </div>

        <div class="value ${mc}">
          ${money(mr)}
        </div>

        <div class="muted">
          ${money(mu)}
          used of
          ${money(x.maxDd)}
        </div>
      </div>

      <div class="metric">
        <div class="label">
          Daily DD Remaining
        </div>

        <div class="value ${dc}">
          ${money(dr)}
        </div>

        <div class="muted">
          ${money(dailyUsed(x))}
          used today
        </div>
      </div>

    </div>

    <div class="grid content-grid">

      <div class="panel">

        <div class="panel-head">

          <div>
            <h3>Risk Monitor</h3>

            <span class="muted">
              ${esc(x.firm)}
              ·
              ${esc(x.name)}
            </span>
          </div>

          ${statusBadge(x)}

        </div>

        <div class="progress-row">

          <div class="progress-head">
            <span>
              Profit Target
            </span>

            <b>
              ${pct(fill(Math.max(0, b - x.startingBalance), x.target))}
              complete
            </b>
          </div>

          <div class="bar">
            <div
              class="fill"
              style="width:${fill(
                Math.max(0, b - x.startingBalance),
                x.target,
              )}%"
            ></div>
          </div>

          <div class="muted">
            ${money(tr)}
            remaining
          </div>

        </div>

        <div class="progress-row">

          <div class="progress-head">

            <span>
              Maximum Drawdown
            </span>

            <b>
              ${pct(fill(mu, x.maxDd))}
              used
            </b>

          </div>

          <div class="bar">

            <div
              class="fill ${mc}"
              style="width:${fill(mu, x.maxDd)}%"
            ></div>

          </div>

          <div class="muted">
            ${money(mr)}
            remaining ·
            ${esc(x.ddMode)}
            mode
          </div>

        </div>

        <div class="progress-row">

          <div class="progress-head">

            <span>
              Daily Drawdown
            </span>

            <b>
              ${pct(fill(dailyUsed(x), x.dailyDd))}
              used
            </b>

          </div>

          <div class="bar">

            <div
              class="fill ${dc}"
              style="width:${fill(dailyUsed(x), x.dailyDd)}%"
            ></div>

          </div>

          <div class="muted">
  ${money(dr)}
  remaining · resets at
  ${esc(x.resetTime || "07:00")}
</div>

          

        </div>

        <div
          class="modal-actions"
          style="justify-content:flex-start"
        >

          <button
            class="primary-btn"
            id="dashTrade"
          >
            ＋ Record Trade
          </button>

          <button
            class="ghost-btn"
            id="dashAccounts"
          >
            Manage Accounts
          </button>

        </div>

      </div>

      <div class="panel">

        <div class="panel-head">

          <h3>
            Account Snapshot
          </h3>

          ${statusBadge(x)}

        </div>

        <div class="muted">
          Account size
        </div>

        <div class="stat-big">
          ${money(x.accountSize)}
        </div>

        <div style="height:14px"></div>

        <div class="muted">
          Starting balance
        </div>

        <b>
          ${money(x.startingBalance)}
        </b>

        <div style="height:14px"></div>

        <div class="muted">
          Maximum DD
        </div>

        <b>
          ${money(x.maxDd)}
        </b>

        <div style="height:14px"></div>

        <div class="muted">
          Daily DD
        </div>

        <b>
          ${money(x.dailyDd)}
        </b>

        <div style="height:14px"></div>

        <div class="muted">
          Total trades
        </div>

        <b>
          ${x.trades.length}
        </b>

      </div>

    </div>

    <div
      class="panel"
      style="margin-top:14px"
    >

      <div class="panel-head">

        <h3>
          Recent Trades
        </h3>

        <button
          class="ghost-btn"
          id="dashHistory"
        >
          View all
        </button>

      </div>

      ${table(
        [...x.trades]
          .sort((p, q) => new Date(q.date) - new Date(p.date))
          .slice(0, 7),
      )}

    </div>
  `;

  $("#dashTrade").onclick = () => view("trade");

  $("#dashAccounts").onclick = () => view("accounts");

  $("#dashHistory").onclick = () => view("history");
}

/* =========================================================
   TABLE
========================================================= */

function table(ts) {
  if (!ts.length) {
    return `
      <div class="empty">
        <strong>
          No trades yet
        </strong>

        Record your first trade.
      </div>
    `;
  }

  return `
    <div class="table-wrap">

      <table>

        <thead>
          <tr>
            <th>Date</th>
            <th>Pair</th>
            <th>Side</th>
            <th>P/L</th>
            <th>Balance After</th>
            <th>Note</th>
          </tr>
        </thead>

        <tbody>

          ${ts
            .map(
              (t) => `
                <tr>

                  <td>
                    ${new Date(t.date).toLocaleString()}
                  </td>

                  <td>
                    <b>
                      ${esc(t.pair)}
                    </b>
                  </td>

                  <td>
                    ${esc(t.side)}
                  </td>

                  <td
                    class="${t.pnl >= 0 ? "positive" : "negative"}"
                  >
                    <b>
                      ${t.pnl >= 0 ? "+" : ""}${money(t.pnl)}
                    </b>
                  </td>

                  <td>
                    ${money(t.balanceAfter)}
                  </td>

                  <td>
                    ${esc(t.note || "—")}
                  </td>

                </tr>
              `,
            )
            .join("")}

        </tbody>

      </table>

    </div>
  `;
}

/* =========================================================
   ACCOUNTS
========================================================= */

function renderAccounts() {
  const v = $("#accountsView");

  v.innerHTML = `
    <div class="panel">

      <div class="panel-head">

        <div>
          <h3>
            Your Prop Accounts
          </h3>

          <span class="muted">
            Each account has separate calculations.
          </span>
        </div>

        <button
          class="primary-btn"
          id="addAccount"
        >
          ＋ Add Account
        </button>

      </div>

    </div>

    <div
      class="grid"
      style="
        grid-template-columns:
        repeat(
          auto-fit,
          minmax(280px,1fr)
        );
        margin-top:14px
      "
    >

      ${state.accounts
        .map(
          (x) => `
            <div class="panel">

              <div class="panel-head">

                <div>

                  <h3>
                    ${esc(x.firm)}
                  </h3>

                  <span class="muted">
                    ${esc(x.name)}
                  </span>

                </div>

                ${statusBadge(x)}

              </div>

              <div class="stat-big">
                ${money(bal(x))}
              </div>

              <div class="muted">
                Status:
                ${accountStatus(x)[2]}
              </div>

              <div
                class="muted"
                style="margin-top:6px"
              >
                Target
                ${money(x.target)}
                · Remaining
                ${money(targetRemaining(x))}
              </div>

              <div
                class="muted"
                style="margin-top:6px"
              >
                Max DD remaining
                ${money(maxRem(x))}
              </div>

              <div
                class="muted"
                style="margin-top:6px"
              >
                Daily DD remaining
                ${money(dailyRem(x))}
              </div>

              <div class="modal-actions">

                <button
                  class="primary-btn open-account"
                  data-id="${x.id}"
                >
                  Open
                </button>

                <button
                  class="ghost-btn edit-account"
                  data-id="${x.id}"
                >
                  Edit
                </button>

                <button
                  class="danger-btn del-account"
                  data-id="${x.id}"
                >
                  Delete
                </button>

              </div>

            </div>
          `,
        )
        .join("")}

    </div>
  `;

  $("#addAccount").onclick = () => openAccount();

  $$(".open-account").forEach(
    (b) =>
      (b.onclick = () => {
        state.selectedId = b.dataset.id;

        save();

        refreshAll();

        view("dashboard");
      }),
  );

  $$(".edit-account").forEach(
    (b) => (b.onclick = () => openAccount(b.dataset.id)),
  );

  $$(".del-account").forEach(
    (b) =>
      (b.onclick = () => {
        pendingDelete = b.dataset.id;

        $("#deleteModal").classList.remove("hidden");
      }),
  );
}

/* =========================================================
   TRADE FORM
========================================================= */

function renderTrade() {
  const v = $("#tradeView");

  const x = a();

  if (!x) {
    v.innerHTML = '<div class="empty">Add an account first.</div>';

    return;
  }

  v.innerHTML = `
    <div class="grid trade-layout">

      <div class="panel">

        <div class="panel-head">

          <div>

            <h3>
              Record Trade
            </h3>

            <span class="muted">
              Nothing is saved until you click Save Trade.
            </span>

          </div>

        </div>

        <form id="tradeForm">

          <div class="form-grid">

            <label>
              Date & Time

              <input
                id="tradeDate"
                type="datetime-local"
                value="${localDT()}"
                required
              >
            </label>

            <label>
              Pair / Symbol

              <input
                id="pair"
                placeholder="XAUUSD, BTCUSD, EURUSD"
                required
              >
            </label>

            <div>

              <span class="muted">
                Direction
              </span>

              <div
                class="direction"
                style="margin-top:7px"
              >

                <input
                  type="radio"
                  name="side"
                  id="buy"
                  value="BUY"
                  checked
                >

                <label for="buy">
                  BUY
                </label>

                <input
                  type="radio"
                  name="side"
                  id="sell"
                  value="SELL"
                >

                <label for="sell">
                  SELL
                </label>

              </div>

            </div>

            <label>
              P/L ($)

              <input
                id="pnl"
                type="number"
                step=".01"
                placeholder="-250 or 500"
                required
              >
            </label>

            <label>
              Entry Price

              <input
                id="entry"
                type="number"
                step="any"
              >
            </label>

            <label>
              Exit Price

              <input
                id="exit"
                type="number"
                step="any"
              >
            </label>

            <label>
              Lot / Size

              <input
                id="size"
                type="number"
                step="any"
              >
            </label>

            <label>
              Risk / Planned Loss ($)

              <input
                id="risk"
                type="number"
                step=".01"
              >
            </label>

          </div>

          <label class="full">

            Trade Note

            <textarea
              id="tradeNote"
              rows="3"
              placeholder="Setup, reason, mistake, session..."
            ></textarea>

          </label>

          <div class="modal-actions">

            <button
              type="button"
              class="ghost-btn"
              id="cancelTradeBtn"
            >
              Cancel
            </button>

            <button
              class="primary-btn"
              type="submit"
            >
              Save Trade & Update Account
            </button>

          </div>

        </form>

      </div>

      <div class="panel">

        <div class="panel-head">

          <h3>
            Current Account
          </h3>

          ${statusBadge(x)}

        </div>

        <div class="muted">
          Balance
        </div>

        <div class="stat-big">
          ${money(bal(x))}
        </div>

        <div style="height:18px"></div>

        <div class="muted">
          Profit target remaining
        </div>

        <div class="stat-big">
          ${money(targetRemaining(x))}
        </div>

        <div style="height:18px"></div>

        <div class="muted">
          Max DD remaining
        </div>

        <div class="stat-big">
          ${money(maxRem(x))}
        </div>

        <div style="height:18px"></div>

        <div class="muted">
          Daily DD remaining
        </div>

        <div class="stat-big">
          ${money(dailyRem(x))}
        </div>

      </div>

    </div>
  `;

  $("#cancelTradeBtn").onclick = () => view("dashboard");

  $("#tradeForm").onsubmit = saveTrade;
}

/* =========================================================
   SAVE TRADE
========================================================= */

function saveTrade(e) {
  e.preventDefault();

  const x = a();

  const p = Number($("#pnl").value);

  const t = {
    id: uid(),

    date: new Date($("#tradeDate").value).toISOString(),

    pair: $("#pair").value.trim().toUpperCase(),

    side: document.querySelector('input[name="side"]:checked').value,

    pnl: p,

    entry: Number($("#entry").value) || null,

    exit: Number($("#exit").value) || null,

    size: Number($("#size").value) || null,

    risk: Number($("#risk").value) || null,

    note: $("#tradeNote").value.trim(),
  };

  t.balanceAfter = bal(x) + p;

  x.trades.push(t);

  save();

  refreshAll();

  toast("Trade recorded — account updated.");

  view("dashboard");
}

/* =========================================================
   HISTORY
========================================================= */

function renderHistory() {
  const x = a();

  $("#historyView").innerHTML = `
    <div class="panel">

      <div class="panel-head">

        <h3>
          Trade History
        </h3>

        <button
          class="primary-btn"
          id="historyTrade"
        >
          ＋ New Trade
        </button>

      </div>

      ${table(
        x
          ? [...x.trades].sort((p, q) => new Date(q.date) - new Date(p.date))
          : [],
      )}

    </div>
  `;

  $("#historyTrade").onclick = () => view("trade");
}

/* =========================================================
   STATISTICS
========================================================= */

function renderStats() {
  const x = a();

  const ts = x?.trades || [];

  const w = ts.filter((t) => t.pnl > 0);

  const l = ts.filter((t) => t.pnl < 0);

  const net = ts.reduce((s, t) => s + Number(t.pnl || 0), 0);

  const gw = w.reduce((s, t) => s + Number(t.pnl || 0), 0);

  const gl = Math.abs(l.reduce((s, t) => s + Number(t.pnl || 0), 0));

  const pf = gl ? gw / gl : gw ? Infinity : 0;

  $("#statsView").innerHTML = `
    <div class="grid stats-grid">

      <div class="panel">
        <div class="muted">
          Net P/L
        </div>

        <div
          class="stat-big ${net >= 0 ? "positive" : "negative"}"
        >
          ${net >= 0 ? "+" : ""}${money(net)}
        </div>
      </div>

      <div class="panel">

        <div class="muted">
          Win Rate
        </div>

        <div class="stat-big">
          ${ts.length ? pct((w.length / ts.length) * 100) : "0.00%"}
        </div>

      </div>

      <div class="panel">

        <div class="muted">
          Profit Factor
        </div>

        <div class="stat-big">
          ${pf === Infinity ? "∞" : pf.toFixed(2)}
        </div>

      </div>

      <div class="panel">

        <div class="muted">
          Best Trade
        </div>

        <div class="stat-big positive">
          ${ts.length ? money(Math.max(...ts.map((t) => t.pnl))) : money(0)}
        </div>

      </div>

      <div class="panel">

        <div class="muted">
          Worst Trade
        </div>

        <div class="stat-big negative">
          ${ts.length ? money(Math.min(...ts.map((t) => t.pnl))) : money(0)}
        </div>

      </div>

      <div class="panel">

        <div class="muted">
          Trades
        </div>

        <div class="stat-big">
          ${ts.length}
        </div>

      </div>

    </div>
  `;
}

/* =========================================================
   SETTINGS
========================================================= */

function renderSettings() {
  $("#settingsView").innerHTML = `
    <div class="panel">

      <h3>
        Data & Storage
      </h3>

      <p class="muted">
        Your data is saved locally for instant loading
        and synced to Supabase through a Netlify server function.
        Cloud status:
        <b>
          ${cloudReady ? "Connected" : "Offline / local only"}
        </b>
      </p>

      <div
        class="modal-actions"
        style="justify-content:flex-start"
      >

        <button
          class="primary-btn"
          id="export"
        >
          Export JSON
        </button>

        <button
          class="ghost-btn"
          id="imp"
        >
          Import JSON
        </button>

        <button
          class="danger-btn"
          id="reset"
        >
          Reset Local Data
        </button>

      </div>

      <input
        id="file"
        type="file"
        accept="application/json"
        hidden
      >

    </div>
  `;

  $("#export").onclick = () => {
    const b = new Blob([JSON.stringify(state, null, 2)], {
      type: "application/json",
    });

    const a = document.createElement("a");

    a.href = URL.createObjectURL(b);

    a.download = "proptrack-backup.json";

    a.click();
  };

  $("#imp").onclick = () => $("#file").click();

  $("#file").onchange = async (e) => {
    try {
      state = JSON.parse(await e.target.files[0].text());

      save();

      refreshAll();

      toast("Backup imported.");
    } catch {
      toast("Invalid backup.");
    }
  };

  $("#reset").onclick = () => {
    if (
      confirm("Delete local data and start fresh? Cloud data is not deleted.")
    ) {
      localStorage.removeItem(KEY);

      state = defaultState();

      saveLocal();

      refreshAll();

      toast("Local data reset.");
    }
  };
}

/* =========================================================
   ACCOUNT MODAL
========================================================= */

function openAccount(id) {
  const x = id ? state.accounts.find((a) => a.id === id) : null;

  $("#accountModalTitle").textContent = x
    ? "Edit Prop Account"
    : "Add Prop Account";

  $("#editAccountId").value = x?.id || "";

  $("#firm").value = x?.firm || "";

  $("#accountName").value = x?.name || "";

  $("#accountSize").value = x?.accountSize ?? "";

  $("#startingBalance").value = x?.startingBalance ?? "";

  $("#targetType").value = x?.targetType || "percent";

  $("#targetInput").value = x?.targetInput ?? 8;

  $("#maxDdType").value = x?.maxDdType || "percent";

  $("#maxDdInput").value = x?.maxDdInput ?? 10;

  $("#dailyDdType").value = x?.dailyDdType || "percent";

  $("#dailyDdInput").value = x?.dailyDdInput ?? 5;

  $("#resetTime").value = x?.resetTime || "00:00";

  $("#ddMode").value = x?.ddMode || "static";

  $("#accountNotes").value = x?.notes || "";

  $("#accountModal").classList.remove("hidden");
}

/* =========================================================
   ACCOUNT FORM
========================================================= */

$("#accountForm").onsubmit = (e) => {
  e.preventDefault();

  const id = $("#editAccountId").value;

  const size = +$("#accountSize").value;

  const start = +$("#startingBalance").value;

  const targetType = $("#targetType").value;

  const targetInput = +$("#targetInput").value;

  const maxDdType = $("#maxDdType").value;

  const maxDdInput = +$("#maxDdInput").value;

  const dailyDdType = $("#dailyDdType").value;

  const dailyDdInput = +$("#dailyDdInput").value;

  const d = {
    firm: $("#firm").value.trim(),

    name: $("#accountName").value.trim(),

    accountSize: size,

    startingBalance: start,

    targetType,
    targetInput,

    target:
      targetType === "percent" ? (start * targetInput) / 100 : targetInput,

    maxDdType,
    maxDdInput,

    maxDd: maxDdType === "percent" ? (size * maxDdInput) / 100 : maxDdInput,

    dailyDdType,
    dailyDdInput,

    dailyDd:
      dailyDdType === "percent" ? (size * dailyDdInput) / 100 : dailyDdInput,

    resetTime:
  $("#resetTime").value || "07:00",

    ddMode: $("#ddMode").value,

    notes: $("#accountNotes").value,
  };

  if (id) {
    Object.assign(
      state.accounts.find((x) => x.id === id),
      d,
    );
  } else {
    const x = {
      id: uid(),
      ...d,
      trades: [],
    };

    state.accounts.push(x);

    state.selectedId = x.id;
  }

  save();

  close("accountModal");

  refreshAll();

  toast("Account saved to cloud.");
};

/* =========================================================
   DELETE ACCOUNT
========================================================= */

$("#confirmDelete").onclick = () => {
  state.accounts = state.accounts.filter((x) => x.id !== pendingDelete);

  state.selectedId = state.accounts[0]?.id || null;

  pendingDelete = null;

  save();

  close("deleteModal");

  refreshAll();

  toast("Account deleted.");
};

/* =========================================================
   MODALS
========================================================= */

$$("[data-close-modal]").forEach(
  (b) => (b.onclick = () => close(b.dataset.closeModal)),
);

function close(id) {
  $("#" + id).classList.add("hidden");
}

/* =========================================================
   VIEW
========================================================= */

function view(n) {
  $$(".view").forEach((x) => x.classList.remove("active-view"));

  $("#" + n + "View").classList.add("active-view");

  $$(".nav-item").forEach((x) =>
    x.classList.toggle("active", x.dataset.view === n),
  );

  $("#pageTitle").textContent = {
    dashboard: "Dashboard",
    accounts: "Accounts",
    trade: "New Trade",
    history: "Trade History",
    stats: "Statistics",
    settings: "Settings",
  }[n];

  render(n);
}

function render(n) {
  if (n === "dashboard") renderDashboard();

  if (n === "accounts") renderAccounts();

  if (n === "trade") renderTrade();

  if (n === "history") renderHistory();

  if (n === "stats") renderStats();

  if (n === "settings") renderSettings();
}

function refreshAll() {
  refreshSwitch();

  const n =
    document.querySelector(".active-view")?.id.replace("View", "") ||
    "dashboard";

  render(n);
}

/* =========================================================
   TOAST
========================================================= */

function toast(s) {
  const t = $("#toast");

  if (!t) return;

  t.textContent = s;

  t.classList.add("show");

  setTimeout(() => t.classList.remove("show"), 2200);
}

/* =========================================================
   EVENT LISTENERS
========================================================= */

$$(".nav-item").forEach((b) => (b.onclick = () => view(b.dataset.view)));

$("#accountSwitcher").onchange = (e) => {
  state.selectedId = e.target.value;

  save();

  refreshAll();
};

$("#quickTradeBtn").onclick = () => view("trade");

$("#authForm").onsubmit = handleAuth;

$("#authSwitch").onclick = () =>
  showAuth(authMode === "login" ? "signup" : "login");

$("#logoutTop").onclick = logout;

/* =========================================================
   START APPLICATION
========================================================= */

refreshAll();

initCloud();
