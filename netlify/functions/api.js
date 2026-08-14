const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS"
};

function json(status, body) {
  return {
    statusCode: status,
    headers,
    body: JSON.stringify(body)
  };
}

/* =========================================================
   SUPABASE REQUEST
========================================================= */

async function sb(path, options = {}) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: options.prefer || "return=representation",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message =
      typeof data === "string"
        ? data
        : data?.message ||
          data?.error ||
          `Supabase ${response.status}`;

    throw new Error(message);
  }

  return data;
}

/* =========================================================
   PASSWORD
========================================================= */

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const hash = crypto
    .scryptSync(password, salt, 64)
    .toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  try {
    const parts = String(storedHash || "").split(":");

    if (parts.length !== 2) {
      return false;
    }

    const salt = parts[0];
    const originalHash = parts[1];

    const hash = crypto
      .scryptSync(password, salt, 64)
      .toString("hex");

    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(originalHash, "hex");

    if (a.length !== b.length) {
      return false;
    }

    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}


/* =========================================================
   OTP HELPERS
========================================================= */

function createOtp() {
  return String(
    Math.floor(100000 + Math.random() * 900000)
  );
}

function hashOtp(otp) {
  return crypto
    .createHash("sha256")
    .update(String(otp))
    .digest("hex");
}

async function sendOtpEmail(email, otp, purpose) {
  const subject =
    purpose === "signup"
      ? "Your PropTrack verification code"
      : "Your PropTrack password reset code";

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization:
          `Bearer ${process.env.RESEND_API_KEY}`
      },

      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL,
        to: [email],
        subject,

        html: `
          <div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;">
            <h2>PropTrack</h2>

            <p>Your verification code is:</p>

            <div style="
              font-size:32px;
              font-weight:bold;
              letter-spacing:8px;
              margin:25px 0;
            ">
              ${otp}
            </div>

            <p>This code expires in 10 minutes.</p>

            <p>
              If you did not request this code,
              you can safely ignore this email.
            </p>
          </div>
        `
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("RESEND ERROR:", data);

    throw new Error(
      data?.message ||
      data?.error ||
      "Unable to send verification email."
    );
  }

  return data;
}

/* =========================================================
   TOKEN
========================================================= */

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

/* =========================================================
   CREATE SESSION
========================================================= */

async function createSession(userId) {
  const token = createToken();

  const expiresAt = new Date(
    Date.now() + 365 * 24 * 60 * 60 * 1000
  ).toISOString();

  await sb("sessions", {
    method: "POST",
    body: JSON.stringify({
      token,
      user_id: userId,
      expires_at: expiresAt,
      created_at: new Date().toISOString()
    })
  });

  return token;
}

/* =========================================================
   AUTHENTICATED USER
========================================================= */

async function getAuthenticatedUser(event) {
  const authorization =
    event.headers?.authorization ||
    event.headers?.Authorization ||
    "";

  const token = authorization.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    throw new Error("Missing session");
  }

  const sessions = await sb(
    `sessions?token=eq.${encodeURIComponent(
      token
    )}&select=user_id,expires_at`
  );

  if (!sessions.length) {
    throw new Error("Invalid session");
  }

  const session = sessions[0];

  if (
    !session.expires_at ||
    new Date(session.expires_at).getTime() < Date.now()
  ) {
    throw new Error("Session expired");
  }

  const users = await sb(
    `users?id=eq.${encodeURIComponent(
      session.user_id
    )}&select=id,email,created_at`
  );

  if (!users.length) {
    throw new Error("User not found");
  }

  return {
    user: users[0],
    token
  };
}

/* =========================================================
   GET ROUTE
========================================================= */

function getRoute(event) {
  const path = event.path || "";

  const parts = path
    .split("/")
    .filter(Boolean);

  return (
    parts[parts.length - 1] || "api"
  ).toLowerCase();
}

/* =========================================================
   MAIN HANDLER
========================================================= */

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers,
      body: ""
    };
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(500, {
      error: "Supabase environment variables are missing."
    });
  }

  try {
    const path = getRoute(event);

    /* =====================================================
       SIGNUP
    ===================================================== */

/* =====================================================
   SIGNUP - SEND OTP
===================================================== */

if (path === "signup") {

  if (event.httpMethod !== "POST") {
    return json(405, {
      error: "Method Not Allowed"
    });
  }

  const body = JSON.parse(event.body || "{}");

  const email = String(body.email || "")
    .trim()
    .toLowerCase();

  const password = String(body.password || "");

  if (!email || !password) {
    return json(400, {
      error: "Email and password are required."
    });
  }

  if (password.length < 6) {
    return json(400, {
      error: "Password must be at least 6 characters."
    });
  }

  /*
    Check whether account already exists.
  */

  const existingUsers = await sb(
    `users?email=eq.${encodeURIComponent(
      email
    )}&select=id,email`
  );

  if (existingUsers.length > 0) {
    return json(409, {
      error: "An account with this email already exists."
    });
  }

  /*
    Generate OTP.
  */

  const otp = createOtp();

  const otpHash = hashOtp(otp);

  const expiresAt = new Date(
    Date.now() + 10 * 60 * 1000
  ).toISOString();

  /*
    Remove previous signup OTPs
    for this email.
  */

  await sb(
    `email_otps?email=eq.${encodeURIComponent(
      email
    )}&purpose=eq.signup`,
    {
      method: "DELETE"
    }
  );

  /*
    Store OTP hash.
  */

  await sb("email_otps", {
    method: "POST",

    body: JSON.stringify({
      email,
      otp_hash: otpHash,
      purpose: "signup",
      expires_at: expiresAt,
      attempts: 0,
      created_at: new Date().toISOString()
    })
  });

  /*
    Send OTP email.
  */

  await sendOtpEmail(
    email,
    otp,
    "signup"
  );

  return json(200, {
    ok: true,
    requiresOtp: true,
    message:
      "Verification code sent to your email."
  });
}


/* =====================================================
   SIGNUP - VERIFY OTP
===================================================== */

if (path === "signup-verify") {

  if (event.httpMethod !== "POST") {
    return json(405, {
      error: "Method Not Allowed"
    });
  }

  const body = JSON.parse(event.body || "{}");

  const email = String(body.email || "")
    .trim()
    .toLowerCase();

  const password = String(body.password || "");

  const otp = String(body.otp || "")
    .trim();

  if (!email || !password || !otp) {
    return json(400, {
      error:
        "Email, password and verification code are required."
    });
  }

  if (!/^\d{6}$/.test(otp)) {
    return json(400, {
      error: "Verification code must be 6 digits."
    });
  }

  /*
    Make sure account hasn't already
    been created.
  */

  const existingUsers = await sb(
    `users?email=eq.${encodeURIComponent(
      email
    )}&select=id,email`
  );

  if (existingUsers.length > 0) {
    return json(409, {
      error: "An account with this email already exists."
    });
  }

  /*
    Get latest OTP.
  */

  const otpRows = await sb(
    `email_otps?email=eq.${encodeURIComponent(
      email
    )}&purpose=eq.signup&select=*&order=created_at.desc&limit=1`
  );

  if (!otpRows.length) {
    return json(400, {
      error:
        "Verification code not found. Please request a new code."
    });
  }

  const otpRecord = otpRows[0];

  /*
    Check expiration.
  */

  if (
    !otpRecord.expires_at ||
    new Date(otpRecord.expires_at) < new Date()
  ) {

    await sb(
      `email_otps?id=eq.${encodeURIComponent(
        otpRecord.id
      )}`,
      {
        method: "DELETE"
      }
    );

    return json(400, {
      error:
        "Verification code has expired. Please request a new code."
    });
  }

  /*
    Check attempts.
  */

  const attempts = Number(
    otpRecord.attempts || 0
  );

  if (attempts >= 5) {
    return json(429, {
      error:
        "Too many incorrect attempts. Please request a new code."
    });
  }

  /*
    Compare OTP hash.
  */

  const suppliedHash = hashOtp(otp);

  if (
    suppliedHash !== otpRecord.otp_hash
  ) {

    await sb(
      `email_otps?id=eq.${encodeURIComponent(
        otpRecord.id
      )}`,
      {
        method: "PATCH",

        body: JSON.stringify({
          attempts: attempts + 1
        })
      }
    );

    return json(401, {
      error:
        "Incorrect verification code."
    });
  }

  /*
    OTP is correct.
    Now create the account.
  */

  const passwordHash =
    createPasswordHash(password);

  const users = await sb("users", {
    method: "POST",

    body: JSON.stringify({
      email,
      password_hash: passwordHash,
      created_at: new Date().toISOString()
    })
  });

  if (!users.length) {
    throw new Error(
      "Unable to create user."
    );
  }

  const user = users[0];

  /*
    OTP can no longer be reused.
  */

  await sb(
    `email_otps?id=eq.${encodeURIComponent(
      otpRecord.id
    )}`,
    {
      method: "DELETE"
    }
  );

  /*
    Create login session.
  */

  const token =
    await createSession(user.id);

  return json(201, {
    ok: true,
    token,

    user: {
      id: user.id,
      email: user.email
    }
  });
}

    /* =====================================================
       LOGIN
    ===================================================== */

    if (path === "login") {
      if (event.httpMethod !== "POST") {
        return json(405, {
          error: "Method Not Allowed"
        });
      }

      const body = JSON.parse(event.body || "{}");

      const email = String(body.email || "")
        .trim()
        .toLowerCase();

      const password = String(body.password || "");

      if (!email || !password) {
        return json(400, {
          error: "Email and password are required."
        });
      }

      const users = await sb(
        `users?email=eq.${encodeURIComponent(
          email
        )}&select=id,email,password_hash,created_at`
      );

      if (!users.length) {
        return json(401, {
          error: "Invalid email or password."
        });
      }

      const user = users[0];

      const validPassword =
        verifyPassword(
          password,
          user.password_hash
        );

      if (!validPassword) {
        return json(401, {
          error: "Invalid email or password."
        });
      }

      const token =
        await createSession(user.id);

      return json(200, {
        ok: true,
        token,
        user: {
          id: user.id,
          email: user.email,
          created_at: user.created_at
        }
      });
    }

    /* =====================================================
       INIT
       Kept for compatibility
    ===================================================== */

    if (path === "init") {
      if (event.httpMethod !== "POST") {
        return json(405, {
          error: "Method Not Allowed"
        });
      }

      const body = JSON.parse(
        event.body || "{}"
      );

      if (!body.deviceId) {
        return json(400, {
          error: "deviceId required"
        });
      }

      const deviceHash = crypto
        .createHash("sha256")
        .update(String(body.deviceId))
        .digest("hex");

      const email =
        `device_${deviceHash.slice(
          0,
          24
        )}@proptrack.local`;

      const users = await sb(
        `users?email=eq.${encodeURIComponent(
          email
        )}&select=id`
      );

      let userId =
        users.length > 0
          ? users[0].id
          : null;

      if (!userId) {
        const passwordHash =
          createPasswordHash(
            `${body.deviceId}_${Date.now()}`
          );

        const created =
          await sb("users", {
            method: "POST",
            body: JSON.stringify({
              email,
              password_hash: passwordHash,
              created_at:
                new Date().toISOString()
            })
          });

        userId = created[0].id;
      }

      const token =
        await createSession(userId);

      return json(200, {
        token
      });
    }

    /* =====================================================
       AUTHENTICATION FOR EVERYTHING ELSE
    ===================================================== */

    let authenticated;

    try {
      authenticated =
        await getAuthenticatedUser(event);
    } catch (authError) {
      return json(401, {
        error: authError.message
      });
    }

    const userId =
      authenticated.user.id;

    /* =====================================================
       ME
    ===================================================== */

    if (path === "me") {
      return json(200, {
        ok: true,
        user: authenticated.user
      });
    }

    /* =====================================================
       GET DATA
    ===================================================== */

    if (path === "data") {
  const accounts = await sb(
    `accounts?user_id=eq.${encodeURIComponent(userId)}&select=*`
  );

  const ids = accounts.map((account) => account.id);

  let trades = [];

  if (ids.length) {
    trades = await sb(
      `trades?account_id=in.(${ids.join(",")})&select=*`
    );
  }

  const mappedAccounts = accounts.map((account) => {
    const accountTrades = trades
      .filter((trade) => trade.account_id === account.id)
      .map((trade) => ({
        id: trade.id,
        date: trade.created_at,
        pair: trade.pair || "",
        side: trade.direction || "",
        pnl: Number(trade.pnl || 0),
        entry: trade.entry ?? null,
        exit: trade.exit ?? null,
        size: trade.lot ?? null,
        risk: null,
        note: trade.notes || "",
        balanceAfter: Number(trade.balance_after || 0)
      }));

    const startingBalance = Number(account.account_size || 0);

    const targetInput = Number(account.target_input || 0);
    const maxDdInput = Number(account.max_dd_input || 0);
    const dailyDdInput = Number(account.daily_dd_input || 0);

    return {
      id: account.id,

      firm: account.firm || "",
      name: account.name || "",

      /* Frontend-compatible fields */
      startingBalance: startingBalance,

      target: targetInput,

      maxDd: maxDdInput,

      dailyDd: dailyDdInput,

      ddMode: account.max_dd_type || "usd",

      dailyDdMode: account.daily_dd_type || "usd",

      targetType: account.target_type || "usd",

      maxDdType: account.max_dd_type || "usd",

      dailyDdType: account.daily_dd_type || "usd",

      /* Keep original database values too */
      accountSize: startingBalance,

      targetInput: targetInput,

      maxDdInput: maxDdInput,

      dailyDdInput: dailyDdInput,

      resetTime: account.reset_time || "00:00",

      createdAt:
        account.created_at ||
        new Date().toISOString(),

      trades: accountTrades
    };
  });

  return json(200, {
    accounts: mappedAccounts
  });
}

    /* =====================================================
       SYNC DATA
    ===================================================== */

    if (path === "sync") {
  if (event.httpMethod !== "POST") {
    return json(405, {
      error: "Method Not Allowed"
    });
  }

  const body = JSON.parse(event.body || "{}");

  const accounts = Array.isArray(body.accounts)
    ? body.accounts
    : [];

  /*
   * Remove duplicate account IDs coming from app.js.
   * If the same account appears more than once,
   * keep the last version.
   */
  const uniqueAccounts = Array.from(
    new Map(
      accounts
        .filter(account => account && account.id)
        .map(account => [String(account.id), account])
    ).values()
  );

  /*
   * Get all existing accounts belonging to this user.
   */
  const oldAccounts = await sb(
    `accounts?user_id=eq.${encodeURIComponent(userId)}&select=id`
  );

  const oldIds = new Set(
    oldAccounts.map(account => String(account.id))
  );

  const incomingIds = new Set(
    uniqueAccounts.map(account => String(account.id))
  );

  /*
   * -----------------------------------------
   * SYNC ACCOUNTS
   * -----------------------------------------
   */

  for (const account of uniqueAccounts) {

    const row = {
  id: account.id,
  user_id: userId,

  firm: account.firm || "",
  name: account.name || "",

  account_size: Number(account.accountSize || 0),

  target_type: account.targetType || "usd",
  target_input:
    account.targetInput ?? account.target ?? 0,

  max_dd_type: account.maxDdType || "usd",
  max_dd_input:
    account.maxDdInput ?? account.maxDd ?? 0,

  daily_dd_type: account.dailyDdType || "usd",
  daily_dd_input:
    account.dailyDdInput ?? account.dailyDd ?? 0,

  reset_time:
    account.resetTime ||
    account.reset_time ||
    "00:00",

  dd_mode:
    account.ddMode ||
    "static",

  notes:
    account.notes ||
    null,

  created_at:
    account.createdAt ||
    new Date().toISOString()
};

    /*
     * Update existing account belonging to this user.
     */
    if (oldIds.has(String(account.id))) {

      await sb(
        `accounts?id=eq.${encodeURIComponent(
          account.id
        )}&user_id=eq.${encodeURIComponent(
          userId
        )}`,
        {
          method: "PATCH",
          body: JSON.stringify(row)
        }
      );

    } else {

      /*
       * New account.
       */
      await sb("accounts", {
        method: "POST",
        body: JSON.stringify(row)
      });
    }

    /*
     * -----------------------------------------
     * SYNC TRADES
     * -----------------------------------------
     */

    const oldTrades = await sb(
      `trades?account_id=eq.${encodeURIComponent(
        account.id
      )}&select=id`
    );

    const oldTradeIds = new Set(
      oldTrades.map(trade => String(trade.id))
    );

    /*
     * Remove duplicate trades coming from app.js.
     */
    const uniqueTrades = Array.from(
      new Map(
        (Array.isArray(account.trades)
          ? account.trades
          : []
        )
          .filter(trade => trade && trade.id)
          .map(trade => [
            String(trade.id),
            trade
          ])
      ).values()
    );

    for (const trade of uniqueTrades) {

      const tradeRow = {
        id: trade.id,

        account_id: account.id,

        pair: trade.pair || "",

        direction:
          trade.side || "",

        pnl: Number(
          trade.pnl || 0
        ),

        entry:
          trade.entry ?? null,

        exit:
          trade.exit ?? null,

        lot:
          trade.size ?? null,

        notes:
          trade.note || null,

        balance_after:
          Number(
            trade.balanceAfter || 0
          ),

        created_at:
          trade.date ||
          new Date().toISOString()
      };

      if (oldTradeIds.has(String(trade.id))) {

        await sb(
          `trades?id=eq.${encodeURIComponent(
            trade.id
          )}&account_id=eq.${encodeURIComponent(
            account.id
          )}`,
          {
            method: "PATCH",
            body: JSON.stringify(tradeRow)
          }
        );

      } else {

        await sb("trades", {
          method: "POST",
          body: JSON.stringify(tradeRow)
        });
      }
    }
  }

  /*
   * -----------------------------------------
   * DELETE ACCOUNTS REMOVED FROM APP
   * -----------------------------------------
   */

  for (const id of oldIds) {

    if (!incomingIds.has(String(id))) {

      await sb(
        `accounts?id=eq.${encodeURIComponent(
          id
        )}&user_id=eq.${encodeURIComponent(
          userId
        )}`,
        {
          method: "DELETE"
        }
      );
    }
  }

  return json(200, {
    ok: true,
    accountsSynced: uniqueAccounts.length
  });
}

    /* =====================================================
       UNKNOWN ROUTE
    ===================================================== */

    return json(404, {
      error: "Not found",
      path
    });

  } catch (error) {
    console.error(
      "API ERROR:",
      error
    );

    return json(500, {
      error:
        error.message ||
        "Server error"
    });
  }
};