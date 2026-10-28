require("dotenv").config();

const express = require('express');
const cors = require("cors");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const pool = require("./db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { hashToken, createVerificationToken } = require("./utils/verificationToken");
const { sendVerificationMail, sendContactMail, sendFeedbackMail } = require("./utils/mailer");
const { startReminderMails } = require("./utils/reminderMails");
const { startFocusSchedule } = require("./utils/focus");
const { PUSH_PUBLIC_KEY, PUSH_KINDS, PUSH_MAX_DEVICES, PUSH_TEXTS, pushLater, deliver, startPushSchedule } = require("./utils/push");
const http = require("node:http");
const realtime = require("./realtime");
const { hasAppAccess, hasTesterAccess, APP_ACCESS_SQL } = require("./utils/access");
const progress = require("./utils/progress");
const { PROFILE_COLORS, PROFILE_BANNERS, PROFILE_EMOJIS, AVATAR_FRAMES, PROFILE_TITLES, SHOWCASE_MAX, BADGES } = progress;

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Without a long random secret anybody could make valid login tokens: don't start at all
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error("JWT_SECRET must be set to a long random string (at least 32 characters). Not starting.");
    process.exit(1);
}
if (IS_PRODUCTION && !process.env.CORS_ORIGINS) {
    console.warn("CORS_ORIGINS is not set: only the localhost dev origins are allowed, the real site will be blocked.");
}

// Rate limits can be raised for automated tests (never needed in production)
const limitFromEnv = (name, fallback) => Number(process.env[name]) || fallback;

// A server error is logged here and answered without any details (no database or stack info
// for the client). Every route uses this instead of sending err.message.
function serverError(res, err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Something went wrong", code: "SERVER_ERROR" });
}

app.disable("x-powered-by");
// every answer is Cache-Control: no-store, so an ETag (a hash of each body) would only cost time
app.set("etag", false);

// The API only answers with JSON: forbid everything else a browser could do with a response
app.use((req, res, next) => {
    res.set({
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "Cache-Control": "no-store",
    });
    // only over HTTPS, which the production setup always uses
    if (IS_PRODUCTION) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
});

// Behind a reverse proxy (nginx/Caddy on the server), the client IP is in X-Forwarded-For.
// TRUST_PROXY=1 makes Express use it, so rate limiting counts real clients, not the proxy.
if (process.env.TRUST_PROXY) {
    app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}

// Only the frontend's own origins may call the API from a browser.
// CORS_ORIGINS is a comma separated list, e.g. "https://quidey.example.com".
// Requests without an Origin header (curl, server-to-server) are not affected by CORS.
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:4173")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        callback(null, false); // no CORS headers: the browser blocks the response
    },
}));
app.use("/api/notebook", express.json({ limit: "4mb" })); // notes carry small pictures
app.use(express.json({ limit: "100kb" })); // parse json bodies; bigger ones are refused

// Slows down password guessing: 10 failed attempts per IP per 15 minutes on login and register.
// Successful requests and CORS preflights (OPTIONS) don't count.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: limitFromEnv("RATE_LIMIT_AUTH", 10),
    skipSuccessfulRequests: true,
    skip: (req) => req.method === "OPTIONS",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many attempts, please try again later" },
});
app.use("/api/login", authLimiter);
app.use("/api/register", authLimiter);

// New accounts: at most 5 successful registrations per IP and hour, so a script can't create
// masses of accounts (failed attempts are counted by authLimiter above)
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: limitFromEnv("RATE_LIMIT_REGISTER", 5),
    skipFailedRequests: true,
    skip: (req) => req.method === "OPTIONS",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many new accounts, please try again later", code: "RATE_LIMITED" },
});

// Verification mails on request: at most 3 per account and hour, so nobody floods an inbox
const verificationMailLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: limitFromEnv("RATE_LIMIT_VERIFICATION_MAIL", 3),
    skip: (req) => req.method === "OPTIONS",
    keyGenerator: (req) => `verify-mail:${req.user.userId}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many mails, please try again later", code: "RATE_LIMITED" },
});

// "Send the link again" from the sign-in screen: 3 per IP per 15 minutes
const resendVerificationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: limitFromEnv("RATE_LIMIT_VERIFICATION_MAIL", 3),
    skip: (req) => req.method === "OPTIONS",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many mails, please try again later", code: "RATE_LIMITED" },
});

// Wrong passwords per account (not per IP), against guessing one password from many machines
const loginAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: limitFromEnv("RATE_LIMIT_LOGIN_ACCOUNT", 10),
    skipSuccessfulRequests: true,
    skip: (req) => req.method === "OPTIONS" || typeof req.body?.username !== "string",
    keyGenerator: (req) => `login:${req.body.username.trim().toLowerCase().slice(0, 100)}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many attempts, please try again later", code: "RATE_LIMITED" },
});

// Login tokens: HS256 only, and they carry the account's token_version (see authenticateToken)
const TOKEN_ALGORITHM = "HS256";
function signToken(user) {
    return jwt.sign(
        { userId: user.id, username: user.username, tv: user.token_version ?? 0 },
        process.env.JWT_SECRET,
        { algorithm: TOKEN_ALGORITHM, expiresIn: "7d" }
    );
}

// The account fields every request needs, kept for a few seconds per user: the app sends several
// requests at once (and a running stopwatch reports regularly), and each would otherwise ask the
// database for the same row. Everything in this process that changes them (password, sign out
// everywhere, pro/admin, deleting the account) calls forgetAccount, so those take effect at
// once; only changes made outside it (scripts/pro.js, psql) wait up to ACCOUNT_CACHE_MS.
const ACCOUNT_CACHE_MS = limitFromEnv("ACCOUNT_CACHE_MS", 15 * 1000);
const ACCOUNT_CACHE_MAX = 5000;
const accountCache = new Map(); // userId -> { account, at }

async function loadAccount(userId) {
    const cached = accountCache.get(userId);
    if (cached && Date.now() - cached.at < ACCOUNT_CACHE_MS) return cached.account;
    const result = await pool.query(
        "SELECT id, username, is_pro, is_tester, is_admin, token_version FROM users WHERE id = $1",
        [userId]
    );
    const account = result.rows[0] ?? null;
    // a simple bound: the oldest entry goes first (a Map keeps insertion order)
    accountCache.delete(userId);
    if (accountCache.size >= ACCOUNT_CACHE_MAX) accountCache.delete(accountCache.keys().next().value);
    if (account) accountCache.set(userId, { account, at: Date.now() });
    return account;
}

function forgetAccount(userId) {
    accountCache.delete(userId);
}

// Checks the login token and loads the account (req.user, req.account).
// A token is only valid while its token_version matches the account's: changing the password
// or "sign out everywhere" raises the version, and all older tokens stop working right away.
async function authenticateToken(req, res, next) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "No existing token" });
    }

    let payload;
    try {
        payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: [TOKEN_ALGORITHM] });
    } catch {
        return res.status(403).json({ error: "Token invalid or expired", code: "TOKEN_INVALID" });
    }

    try {
        const account = await loadAccount(payload.userId);
        if (!account || account.token_version !== (payload.tv ?? 0)) {
            return res.status(401).json({ error: "Signed out, please sign in again", code: "TOKEN_REVOKED" });
        }
        req.user = { userId: account.id, username: account.username };
        req.account = account;
        next();
    } catch (err) {
        serverError(res, err);
    }
}

app.use("/api/tasks", authenticateToken);
app.use("/api/groups", authenticateToken);
app.use("/api/sessions", authenticateToken);
app.use("/api/notes", authenticateToken);
app.use("/api/task-groups", authenticateToken);
app.use("/api/users", authenticateToken);
app.use("/api/friends", authenticateToken);
app.use("/api/shared-sessions", authenticateToken);
app.use("/api/task-shares", authenticateToken);
app.use("/api/profiles", authenticateToken);
app.use("/api/profile", authenticateToken);
app.use("/api/event-types", authenticateToken);
app.use("/api/stats", authenticateToken);
app.use("/api/feed", authenticateToken);
app.use("/api/progress", authenticateToken);
app.use("/api/families", authenticateToken);
app.use("/api/push", authenticateToken);
app.use("/api/focus", authenticateToken);
app.use("/api/routines", authenticateToken);
app.use("/api/notebook", authenticateToken);

// Closed beta: the app's data is only for pro users and testers (and admins, see utils/access.js).
// Checked against the account on every request (not stored in the token; see loadAccount), so
// granting or taking away pro / tester works right away.
// /api/me, /api/users (own account) and /api/beta-requests stay open, for the beta screen.
function requirePro(req, res, next) {
    if (!hasAppAccess(req.account)) {
        return res.status(403).json({ error: "Quidey is in closed beta", code: "PRO_REQUIRED" });
    }
    next();
}

app.use(
    ["/api/tasks", "/api/groups", "/api/sessions", "/api/notes", "/api/task-groups", "/api/friends", "/api/shared-sessions", "/api/task-shares", "/api/profiles", "/api/profile", "/api/event-types", "/api/stats", "/api/feed", "/api/progress", "/api/families", "/api/push", "/api/focus", "/api/routines", "/api/notebook"],
    requirePro
);

// Features not released to everyone yet: only testers (and admins). Every route under
// /api/tester/... is protected by this; for a single route elsewhere use
// app.get("/api/x", authenticateToken, requireTester, handler).
function requireTester(req, res, next) {
    if (!hasTesterAccess(req.account)) {
        return res.status(403).json({ error: "Only for testers", code: "TESTER_REQUIRED" });
    }
    next();
}

app.use("/api/tester", authenticateToken, requireTester);

// Overall limit per account (or per IP before signing in): plenty for the app, which polls
// every few seconds, but stops scripts from hammering the API
app.use("/api", rateLimit({
    windowMs: 60 * 1000,
    limit: limitFromEnv("RATE_LIMIT_API", 300),
    skip: (req) => req.method === "OPTIONS",
    keyGenerator: (req) => (req.user ? `user:${req.user.userId}` : ipKeyGenerator(req.ip)),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests, please slow down", code: "RATE_LIMITED" },
}));

// ---------- input checks ----------
// Ids from the URL: a positive integer, or null (answered with 404 instead of a database error)
const idParam = (value) => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
};

// Text: trimmed, null when empty; undefined when it has the wrong type or is longer than max
function cleanText(value, max) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (trimmed.length > max) return undefined;
    return trimmed === "" ? null : trimmed;
}

// A date (e.g. "2026-10-20" or an ISO timestamp); null when empty, undefined when invalid
function cleanDate(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value.length > 40) return undefined;
    const time = Date.parse(value);
    if (Number.isNaN(time)) return undefined;
    const year = new Date(time).getUTCFullYear();
    return year >= 1900 && year <= 3000 ? value : undefined;
}

// Priority: a whole number 0-1000 (also as a string from a form field), or null
function cleanPrio(value) {
    if (value === undefined || value === null || value === "") return null;
    const prio = Number(value);
    return Number.isInteger(prio) && prio >= 0 && prio <= 1000 ? prio : undefined;
}

const invalidInput = (res, field) => res.status(400).json({ error: `Invalid ${field}`, code: "INVALID_INPUT", field });
const notFound = (res, what) => res.status(404).json({ error: `${what} not found` });

const TASK_NAME_MAX = 200;
const TASK_DESCRIPTION_MAX = 2000;
const GROUP_NAME_MAX = 60;
const GROUP_DESCRIPTION_MAX = 500;
const NOTE_MAX = 5000;
const TASK_LOCATION_MAX = 200;
const TASK_LINK_MAX = 500;
const TASK_DETAILS_MAX = 5000;
const MINUTES_PER_WEEK = 7 * 24 * 60;

// A time of day "HH:MM" (24 h); null when empty, undefined when invalid
function cleanTime(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") return undefined;
    const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)(:00)?$/);
    return match ? `${match[1]}:${match[2]}` : undefined;
}

// Whole minutes between min and max (also as a string from a form field); null when empty
function cleanMinutes(value, min, max) {
    if (value === undefined || value === null || value === "") return null;
    const minutes = Number(value);
    return Number.isInteger(minutes) && minutes >= min && minutes <= max ? minutes : undefined;
}

// A task's reminders: minutes before its start (0: at the start, up to a week), at most
// REMINDERS_MAX, given back sorted and without doubles; [] for none, undefined when invalid
const REMINDERS_MAX = 5;
function cleanReminders(value) {
    if (value === null) return [];
    if (!Array.isArray(value)) return undefined;
    const minutes = value.map((item) => cleanMinutes(item, 0, MINUTES_PER_WEEK));
    if (minutes.some((item) => item === null || item === undefined)) return undefined;
    const unique = [...new Set(minutes)].sort((a, b) => a - b);
    return unique.length <= REMINDERS_MAX ? unique : undefined;
}

// A web address. Only http(s): the app shows it as a link, so "javascript:" and the like
// must never get in. null when empty, undefined when invalid
function cleanLink(value) {
    const text = cleanText(value, TASK_LINK_MAX);
    if (!text) return text;
    try {
        const url = new URL(text);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
    } catch {
        return undefined;
    }
}

const TASK_KINDS = ["task", "event"];

// The colours a task can have (the app draws them); null is the default look
const TASK_COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "violet", "pink"];

// How far the next one of a repeating task is from the last (Postgres intervals)
const REPEAT_INTERVALS = { daily: "1 day", weekly: "7 days", monthly: "1 month", yearly: "1 year" };
// at most this many repeats when a repeating task has an end
const REPEAT_LEFT_MAX = 1000;
// The day n steps of its rhythm after a task's day (SQL about a row `t` with due and repeat; n
// steps from the day itself, not step after step, so the 31st stays the 31st where it can)
const repeatDueSql = (t, n) => `(${t}.due + ${n} * CASE ${t}.repeat
        WHEN 'daily' THEN interval '1 day' WHEN 'weekly' THEN interval '7 days'
        WHEN 'monthly' THEN interval '1 month' ELSE interval '1 year' END)::date`;

// The optional task fields, each checked only when it was sent:
// { values: { column: value } } or { error: field }
const TASK_EXTRAS = {
    due_time: cleanTime,
    duration_minutes: (value) => cleanMinutes(value, 1, MINUTES_PER_WEEK),
    reminders: cleanReminders,
    location: (value) => cleanText(value, TASK_LOCATION_MAX),
    link: cleanLink,
    details: (value) => cleanText(value, TASK_DETAILS_MAX),
    repeat: (value) => (value === null || value === "" ? null : Object.hasOwn(REPEAT_INTERVALS, value) ? value : undefined),
    // how many more times it comes back after this one (null = no end)
    repeat_left: (value) => cleanMinutes(value, 0, REPEAT_LEFT_MAX),
    color: (value) => (value === null || value === "" ? null : TASK_COLORS.includes(value) ? value : undefined),
    // also remind by mail (only the owner can change it, see PUT /api/tasks/:id)
    reminder_email: (value) => (typeof value === "boolean" ? value : undefined),
    // 'task' (ticked off by hand) or 'event' (done once it is over); only the owner changes it
    kind: (value) => (TASK_KINDS.includes(value) ? value : undefined),
    // one of the owner's event types (checked against the database, see ownEventType)
    event_type_id: (value) => (value === null || value === "" ? null : idParam(value) ?? undefined),
};
// the fields only a task's owner can change (the others' values are ignored)
const OWNER_ONLY_FIELDS = ["reminder_email", "kind", "event_type_id"];
function readTaskExtras(body, fields = TASK_EXTRAS) {
    // an app from before several reminders sends one as reminder_minutes (null: none)
    if (fields.reminders && body?.reminders === undefined && body?.reminder_minutes !== undefined) {
        const one = cleanMinutes(body.reminder_minutes, 0, MINUTES_PER_WEEK);
        if (one === undefined) return { error: "reminder_minutes" };
        body = { ...body, reminders: one === null ? [] : [one] };
    }
    const values = {};
    for (const [field, clean] of Object.entries(fields)) {
        if (body?.[field] === undefined) continue;
        const value = clean(body[field]);
        if (value === undefined) return { error: field };
        values[field] = value;
    }
    return { values };
}

// The optional fields of a task in a shared session: the same as on one's own tasks, except
// the personal ones (reminders and repeating). Read with readTaskExtras(body, SHARED_TASK_FIELDS).
const SHARED_TASK_FIELDS = {
    description: (value) => cleanText(value, TASK_DESCRIPTION_MAX),
    due: cleanDate,
    prio: cleanPrio,
    due_time: TASK_EXTRAS.due_time,
    duration_minutes: TASK_EXTRAS.duration_minutes,
    location: TASK_EXTRAS.location,
    link: TASK_EXTRAS.link,
    details: TASK_EXTRAS.details,
    color: TASK_EXTRAS.color,
};

// A shared session's tasks also can be events: they need a day and are done once they are
// over (syncSessionEvents). Family calendars stay with SHARED_TASK_FIELDS.
const SESSION_TASK_FIELDS = { ...SHARED_TASK_FIELDS, kind: TASK_EXTRAS.kind };

// Ids of the tasks a user may see and change: their own, and the ones shared with them that
// they accepted. `param` is the query parameter holding the user id, e.g. "$2".
const accessibleTaskIds = (param) =>
    `SELECT id FROM tasks WHERE user_id = ${param}
    UNION SELECT task_id FROM task_shares WHERE user_id = ${param} AND status = 'accepted'`;

// Tasks in the shape the app uses, for the user in $1: the task's columns (due_time as "HH:MM"),
// group_ids (only that user's own groups), isOwner, owner (who shared it, for a task shared
// with me), shareId (my share of somebody else's task, to leave it) and
// sharedWith: [{ shareId, status: 'pending' | 'accepted', user }] (everybody it was sent to).
// Add conditions with "AND ...".
const TASK_SELECT = `
    SELECT tasks.id, tasks.name, tasks.due, to_char(tasks.due_time, 'HH24:MI') AS due_time,
        tasks.duration_minutes, tasks.reminders, tasks.location, tasks.link, tasks.details,
        tasks.description, tasks.prio, tasks.done, tasks.created_at, tasks.user_id,
        tasks.repeat, tasks.repeat_left,
        ARRAY(SELECT to_char(day, 'YYYY-MM-DD') FROM unnest(tasks.repeat_skip) AS day ORDER BY day) AS repeat_skip,
        tasks.completed_at, tasks.color, tasks.reminder_email,
        tasks.kind, tasks.event_type_id, event_types.name AS event_type_name, event_types.color AS event_type_color,
        owner.username AS owner_username, owner.display_name AS owner_display_name,
        my_share.id AS my_share_id,
        COALESCE((
            SELECT array_agg(task_groups.group_id ORDER BY task_groups.group_id)
            FROM task_groups
            JOIN groups ON groups.id = task_groups.group_id
            WHERE task_groups.task_id = tasks.id AND groups.user_id = $1
        ), '{}') AS group_ids,
        COALESCE((
            SELECT json_agg(json_build_object(
                'shareId', task_shares.id,
                'status', task_shares.status,
                'user', json_build_object('id', users.id, 'username', users.username, 'displayName', users.display_name)
            ) ORDER BY task_shares.id)
            FROM task_shares
            JOIN users ON users.id = task_shares.user_id
            WHERE task_shares.task_id = tasks.id
        ), '[]') AS shared_with
    FROM tasks
    JOIN users AS owner ON owner.id = tasks.user_id
    LEFT JOIN event_types ON event_types.id = tasks.event_type_id
    LEFT JOIN task_shares AS my_share
        ON my_share.task_id = tasks.id AND my_share.user_id = $1 AND my_share.status = 'accepted'
    WHERE (tasks.user_id = $1 OR my_share.id IS NOT NULL)`;

function toTaskResponse(row, userId) {
    const isOwner = row.user_id === userId;
    return {
        id: row.id,
        name: row.name,
        due: row.due,
        due_time: row.due_time,
        duration_minutes: row.duration_minutes,
        // minutes before the start, sorted; a task without a time starts at my all-day time
        reminders: row.reminders,
        // for apps from before several reminders: the one closest to the start
        reminder_minutes: row.reminders[0] ?? null,
        location: row.location,
        link: row.link,
        details: row.details,
        description: row.description,
        prio: row.prio,
        done: row.done,
        repeat: row.repeat,
        // how many more times it comes back (null = no end) and the coming days left out
        repeat_left: row.repeat_left,
        repeat_skip: row.repeat_skip,
        color: row.color,
        // the owner's setting: a mail reaches only them
        reminder_email: row.reminder_email,
        kind: row.kind,
        event_type_id: row.event_type_id,
        // the owner's type, so people it is shared with see its name too
        event_type: row.event_type_id ? { id: row.event_type_id, name: row.event_type_name, color: row.event_type_color } : null,
        completed_at: row.completed_at,
        created_at: row.created_at,
        user_id: row.user_id,
        group_ids: row.group_ids,
        isOwner,
        owner: isOwner ? null : { id: row.user_id, username: row.owner_username, displayName: row.owner_display_name },
        shareId: row.my_share_id,
        sharedWith: row.shared_with,
    };
}

// One task as the user sees it, or null when they may not see it
async function loadTask(taskId, userId, db = pool) {
    const result = await db.query(`${TASK_SELECT} AND tasks.id = $2`, [userId, taskId]);
    return result.rows[0] ? toTaskResponse(result.rows[0], userId) : null;
}

// Everybody who has a task: its owner and the people it was sent to (pending or accepted), without `except`
async function taskPeople(taskId, except) {
    const result = await pool.query(
        "SELECT user_id FROM tasks WHERE id = $1 UNION SELECT user_id FROM task_shares WHERE task_id = $1",
        [taskId]
    );
    return result.rows.map(row => row.user_id).filter(id => id !== except);
}

// The others see a shared task change right away: their task list and invites load again
function notifyTaskPeople(people, taskId) {
    for (const id of people) realtime.toUser(id, "tasks:changed", { taskId });
}

//GET endpoints
app.get("/api/tasks", async (req, res) => {
    const userId = req.user.userId;

    try{
        // my events that ended since the last check are ticked off first (and repeat)
        await syncEventsNow("tasks.user_id = $1 AND NOT tasks.done", [userId]);
        // my own tasks and the ones friends shared with me (see TASK_SELECT)
        const result = await pool.query(`${TASK_SELECT} ORDER BY tasks.id`, [userId]);
        res.json(result.rows.map(row => toTaskResponse(row, userId)));
    } catch (err) {
        serverError(res, err);
    }
});

app.get("/api/users", async (req, res) => {
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            "SELECT users.username, users.display_name, users.birth_date, users.email, users.email_verified, users.created_at FROM users WHERE id = $1",
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        serverError(res, err);
    }
});

app.get("/api/tasks/:id/groups", async (req, res) => {
    const id = idParam(req.params.id);
    const userId = req.user.userId;
    if (!id) return notFound(res, "Task");

    try {
        const result = await pool.query(
            `SELECT groups.id, groups.name, groups.description, groups.color
            FROM groups
            JOIN task_groups ON groups.id = task_groups.group_id
            WHERE task_groups.task_id = $1 AND groups.user_id = $2
                AND task_groups.task_id IN (${accessibleTaskIds("$2")})`,
            [id, userId]
        );
        res.json(result.rows);
    } catch (err) {
        serverError(res, err);
    }
});
//group tasks by id
app.get("/api/groups/:id/tasks", async (req, res) => {
    const id = idParam(req.params.id);
    const userId = req.user.userId;
    if (!id) return notFound(res, "Group");

    try {
        const result = await pool.query(
            `${TASK_SELECT}
                AND tasks.id IN (
                    SELECT task_groups.task_id FROM task_groups
                    JOIN groups ON groups.id = task_groups.group_id
                    WHERE task_groups.group_id = $2 AND groups.user_id = $1
                )
            ORDER BY tasks.id`,
            [userId, id]
        );
        res.json(result.rows.map(row => toTaskResponse(row, userId)));
    } catch (err) {
        serverError(res, err);
    }
});

app.get("/api/groups", async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query("SELECT * FROM groups WHERE user_id = $1 ORDER BY id", [userId]);
        res.json(result.rows);
    } catch (err) {
        serverError(res, err);
    }
});

app.get("/api/tasks/:taskId/notes", async (req, res) => {
    const taskId = idParam(req.params.taskId);
    const userId = req.user.userId;
    if (!taskId) return notFound(res, "Task");

    try {
       const result = await pool.query(
       `SELECT notes.* FROM notes
       WHERE notes.task_id = $1 AND notes.task_id IN (${accessibleTaskIds("$2")})
       ORDER BY notes.id`,
        [taskId, userId]
    );
    res.json(result.rows);
    } catch (err) {
        serverError(res, err);
    }
});

app.get("/api/notes", async (req, res) => {
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            `SELECT notes.*
            FROM notes
            WHERE notes.task_id IN (${accessibleTaskIds("$1")})
            ORDER BY notes.id`,
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        serverError(res, err);
    }
});

// sessions are returned in the shape the frontend stores them in:
// { id, totalTime (seconds), workedTasks: [{ id, name, time (seconds), shared? }], group (name or 'all'), date }
// Tasks from shared sessions have the id "shared-<id>" and shared: { sessionId, sessionName }.
// date is cast to timestamptz so the timestamp column is read in the db's own time zone
const SESSION_SELECT = `
    SELECT sessions.id, sessions.time_ms, sessions.date::timestamptz AS date,
        COALESCE(groups.name, 'all') AS group_name,
        COALESCE(
            json_agg(json_build_object(
                'id', tasks.id,
                'name', tasks.name,
                'time', ROUND(session_tasks.time_ms / 1000.0)::int
            ) ORDER BY tasks.id)
                FILTER (WHERE tasks.id IS NOT NULL),
            '[]'
        ) AS worked_tasks,
        COALESCE((
            SELECT json_agg(json_build_object(
                'id', 'shared-' || shared_session_tasks.id,
                'name', shared_session_tasks.name,
                'time', ROUND(session_shared_tasks.time_ms / 1000.0)::int,
                'shared', json_build_object('sessionId', shared_sessions.id, 'sessionName', shared_sessions.name)
            ) ORDER BY shared_session_tasks.id)
            FROM session_shared_tasks
            JOIN shared_session_tasks ON shared_session_tasks.id = session_shared_tasks.shared_task_id
            JOIN shared_sessions ON shared_sessions.id = shared_session_tasks.session_id
            WHERE session_shared_tasks.session_id = sessions.id
        ), '[]') AS shared_tasks
    FROM sessions
    LEFT JOIN groups ON groups.id = sessions.group_id
    LEFT JOIN session_tasks ON session_tasks.session_id = sessions.id
    LEFT JOIN tasks ON tasks.id = session_tasks.task_id
`;

function toSessionResponse(row) {
    return {
        id: row.id,
        totalTime: Math.round((row.time_ms ?? 0) / 1000),
        workedTasks: [...row.worked_tasks, ...(row.shared_tasks ?? [])],
        group: row.group_name,
        date: row.date,
    };
}

app.get("/api/sessions", async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `${SESSION_SELECT}
            WHERE sessions.user_id = $1
            GROUP BY sessions.id, groups.name
            ORDER BY sessions.date DESC, sessions.id DESC`,
            [userId]
        );
        res.json(result.rows.map(toSessionResponse));
    } catch (err) {
        serverError(res, err);
    }
});

app.get("/api/sessions/:id/tasks", async (req, res) => {
    const id = idParam(req.params.id);
    const userId = req.user.userId;
    if (!id) return notFound(res, "Session");
    try {
        const result = await pool.query(
            `SELECT tasks.id, tasks.name, tasks.due, tasks.description, tasks.prio, tasks.done,
                ROUND(session_tasks.time_ms / 1000.0)::int AS time
            FROM tasks
            JOIN session_tasks ON tasks.id = session_tasks.task_id
            JOIN sessions ON sessions.id = session_tasks.session_id
            WHERE session_tasks.session_id = $1 AND sessions.user_id = $2`,
            [id, userId]
        );
        res.json(result.rows);
    } catch (err) {
        serverError(res, err);
    }
});

// Who I am and whether I may use the app:
// { userId, username, isPro (may use the app: pro, tester or admin), isAdmin,
//   isTester (sees features not released to everyone yet; admins always do),
//   adminPendingCount (admins only: open beta requests), betaRequest: { status, reason, createdAt } | null,
//   allDayReminderTime: "HH:MM", when tasks without a time are reminded (see PUT /api/users/reminder-time),
//   tourSeen: false while a new account hasn't closed the intro tour yet (see PUT /api/users/tour-seen) }
app.get("/api/me" , authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT users.username, users.is_pro, users.is_admin, users.is_tester,
                to_char(users.allday_reminder_time, 'HH24:MI') AS allday_reminder_time,
                users.tour_seen_at IS NOT NULL AS tour_seen,
                beta_access_requests.status, beta_access_requests.reason, beta_access_requests.created_at,
                CASE WHEN users.is_admin
                    THEN (SELECT count(*) FROM beta_access_requests WHERE status = 'pending')::int END AS pending_count
            FROM users
            LEFT JOIN beta_access_requests ON beta_access_requests.user_id = users.id
            WHERE users.id = $1`,
            [req.user.userId]
        );
        const row = result.rows[0];
        // the account was deleted after the token was issued
        if (!row) return res.status(401).json({ error: "User not found" });
        res.json({
            userId: req.user.userId,
            username: row.username,
            isPro: hasAppAccess(row),
            isAdmin: row.is_admin,
            isTester: hasTesterAccess(row),
            ...(row.is_admin ? { adminPendingCount: row.pending_count } : {}),
            betaRequest: row.status ? { status: row.status, reason: row.reason, createdAt: row.created_at } : null,
            allDayReminderTime: row.allday_reminder_time,
            tourSeen: row.tour_seen,
        });
    } catch (err) {
        serverError(res, err);
    }
});

// Ask for beta access: { reason } (10-1000 characters). Only once per account.
app.post("/api/beta-requests", authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length < 10) return res.status(400).json({ error: "Please give a reason (at least 10 characters)", code: "REASON_TOO_SHORT" });
    if (reason.length > 1000) return res.status(400).json({ error: "The reason is too long", code: "REASON_TOO_LONG" });

    try {
        const user = await pool.query("SELECT is_pro, is_tester, is_admin FROM users WHERE id = $1", [userId]);
        if (user.rows.length === 0) return res.status(401).json({ error: "User not found" });
        if (hasAppAccess(user.rows[0])) return res.status(409).json({ error: "You already have access", code: "ALREADY_PRO" });

        const result = await pool.query(
            `INSERT INTO beta_access_requests (user_id, reason) VALUES ($1, $2)
            ON CONFLICT (user_id) DO NOTHING
            RETURNING status, reason, created_at`,
            [userId, reason]
        );
        if (result.rows.length === 0) {
            return res.status(409).json({ error: "You already asked for access", code: "ALREADY_REQUESTED" });
        }
        const row = result.rows[0];
        res.status(201).json({ status: row.status, reason: row.reason, createdAt: row.created_at });
    } catch (err) {
        serverError(res, err);
    }
});

//POST endpoints
app.post("/api/tasks", async (req, res) => {
    const userId = req.user.userId;
    const name = cleanText(req.body?.name, TASK_NAME_MAX);
    const description = cleanText(req.body?.description, TASK_DESCRIPTION_MAX);
    const due = cleanDate(req.body?.due);
    const prio = cleanPrio(req.body?.prio);
    const extras = readTaskExtras(req.body);
    if (!name) return invalidInput(res, "name");
    if (description === undefined) return invalidInput(res, "description");
    if (due === undefined) return invalidInput(res, "due");
    if (prio === undefined) return invalidInput(res, "prio");
    if (extras.error) return invalidInput(res, extras.error);
    // a time of day needs a day, and so does repeating
    if (extras.values.due_time && !due) return invalidInput(res, "due_time");
    if (extras.values.repeat && !due) return invalidInput(res, "repeat");
    // an event happens on a day; only events have a type
    if (extras.values.kind === "event" && !due) return invalidInput(res, "due");
    if (extras.values.kind !== "event") delete extras.values.event_type_id;
    // an end only for something that repeats
    if (!extras.values.repeat) delete extras.values.repeat_left;

    const columns = ["name", "due", "description", "prio", "user_id", ...Object.keys(extras.values)];
    const values = [name, due, description, prio, userId, ...Object.values(extras.values)];

    const client = await pool.connect();
    try {
        if (!(await ownEventType(client, extras.values.event_type_id, userId))) return invalidInput(res, "event_type_id");
        await client.query("BEGIN");
        const result = await client.query(
            `INSERT INTO tasks (${columns.join(", ")})
            VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")})
            RETURNING id`,
            values
        );
        const id = result.rows[0].id;
        // an event entered afterwards (e.g. yesterday's work) is over right away
        const [synced] = await syncEvents(client, "tasks.id = $1", [id]);
        await client.query("COMMIT");
        const task = await loadTask(id, userId);
        res.status(201).json(synced?.nextId ? { ...task, nextTask: await loadTask(synced.nextId, userId) } : task);
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        serverError(res, err);
    } finally {
        client.release();
    }
});

// Whether an event type id is one of the user's own (null / not sent: fine, no type)
async function ownEventType(db, typeId, userId) {
    if (typeId === null || typeId === undefined) return true;
    const result = await db.query("SELECT 1 FROM event_types WHERE id = $1 AND user_id = $2", [typeId, userId]);
    return result.rows.length > 0;
}

// When an event is over: its day at its time in the owner's time zone plus how long it lasts.
// Without a time it takes the whole day. Needs tasks joined with their owner as users.
const EVENT_END_SQL = `CASE WHEN tasks.due_time IS NULL
        THEN (tasks.due + 1)::timestamp AT TIME ZONE COALESCE(users.timezone, 'Europe/Berlin')
        ELSE (tasks.due + tasks.due_time) AT TIME ZONE COALESCE(users.timezone, 'Europe/Berlin')
            + make_interval(mins => COALESCE(tasks.duration_minutes, 0))
    END`;

// Events are never ticked off by hand: they are done once they are over. This sets `done` of the
// events `where` picks (SQL about tasks / users, with `params`) to whether they are over, so
// one moved into the future opens again. completed_at is when it ended. A repeating event that
// just ended gets its next one, like a task that was ticked off.
// Returns [{ id, userId, done, nextId }] of the events that changed.
async function syncEvents(db, where, params = []) {
    const result = await db.query(
        `UPDATE tasks SET done = state.over, completed_at = CASE WHEN state.over THEN state.ends_at END
        FROM (
            SELECT tasks.id, ends.at AS ends_at, ends.at <= now() AS over
            FROM tasks
            JOIN users ON users.id = tasks.user_id
            CROSS JOIN LATERAL (SELECT ${EVENT_END_SQL} AS at) AS ends
            WHERE tasks.kind = 'event' AND tasks.due IS NOT NULL AND (${where})
            FOR UPDATE OF tasks SKIP LOCKED
        ) AS state
        WHERE tasks.id = state.id AND tasks.done IS DISTINCT FROM state.over
        RETURNING tasks.id, tasks.user_id, tasks.done`,
        params
    );
    const changed = [];
    for (const row of result.rows) {
        changed.push({ id: row.id, userId: row.user_id, done: row.done, nextId: row.done ? await createNextRepeat(db, row.id) : null });
    }
    return changed;
}

// The same for events in shared sessions: `done` is whether they are over, in the session
// owner's time zone. Tells the members' apps of each session that changed (unless notify is
// false, when the caller does). Returns the ids of the sessions that changed.
async function syncSessionEvents(where, params = [], notify = true) {
    const result = await pool.query(
        `UPDATE shared_session_tasks SET done = state.over
        FROM (
            SELECT shared_session_tasks.id, ends.at <= now() AS over
            FROM shared_session_tasks
            JOIN shared_sessions ON shared_sessions.id = shared_session_tasks.session_id
            JOIN users ON users.id = shared_sessions.owner_id
            CROSS JOIN LATERAL (SELECT ${EVENT_END_SQL.replaceAll("tasks.", "shared_session_tasks.")} AS at) AS ends
            WHERE shared_session_tasks.kind = 'event' AND shared_session_tasks.due IS NOT NULL
                AND shared_sessions.ended_at IS NULL AND (${where})
        ) AS state
        WHERE shared_session_tasks.id = state.id AND shared_session_tasks.done IS DISTINCT FROM state.over
        RETURNING shared_session_tasks.session_id`,
        params
    );
    const sessions = [...new Set(result.rows.map(row => row.session_id))];
    if (notify) {
        for (const sessionId of sessions) await notifySession(sessionId).catch(() => {});
    }
    return sessions;
}

// syncEvents in a transaction of its own, so an ended event and its next repeat come together
async function syncEventsNow(where, params) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const changed = await syncEvents(client, where, params);
        await client.query("COMMIT");
        return changed;
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// Once a minute: ticks off the events that ended since (of everybody) and tells the people who
// have them, so open apps update without waiting for their next refresh
async function closePastEvents() {
    let changed = [];
    try {
        // an event after tomorrow can't be over yet, whatever the time zone
        changed = await syncEventsNow("NOT tasks.done AND tasks.due <= current_date + 1");
        await syncSessionEvents("NOT shared_session_tasks.done AND shared_session_tasks.due <= current_date + 1");
    } catch (err) {
        console.error("Closing past events failed:", err);
        return;
    }
    for (const event of changed) {
        try {
            notifyTaskPeople(await taskPeople(event.id), event.id);
        } catch { /* they see it on their next refresh */ }
    }
}

// { name, description, color? } (color: one of TASK_COLORS or null)
app.post("/api/groups", async (req, res) => {
    const userId = req.user.userId;
    const name = cleanText(req.body?.name, GROUP_NAME_MAX);
    const description = cleanText(req.body?.description, GROUP_DESCRIPTION_MAX);
    const color = req.body?.color === undefined ? null : TASK_EXTRAS.color(req.body.color);
    if (!name) return invalidInput(res, "name");
    if (description === undefined) return invalidInput(res, "description");
    if (color === undefined) return invalidInput(res, "color");

    try {
        const result = await pool.query(
            `INSERT INTO groups (name, description, user_id, color)
            VALUES ($1, $2, $3, $4)
            RETURNING *`,
            [name, description, userId, color]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        serverError(res, err);
    }
});

app.post("/api/tasks/:taskId/groups/:groupId", async (req, res) => {
    const taskId = idParam(req.params.taskId);
    const groupId = idParam(req.params.groupId);
    const userId = req.user.userId;
    if (!taskId || !groupId) return notFound(res, "Task or group");

    try { 
        const ownerCheck = await pool.query(
            `SELECT 1 FROM (${accessibleTaskIds("$2")}) AS mine WHERE id = $1
            UNION ALL
            SELECT 1 FROM groups WHERE id = $3 AND user_id = $2`,
            [taskId, userId, groupId]
        );

        if (ownerCheck.rows.length < 2) {
            return res.status(404).json({ error: "Task or group not found" });
        }

        // already in the group: nothing to do (no duplicate-key error)
        await pool.query(
            `INSERT INTO task_groups (task_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [taskId, groupId]
        );
        res.status(201).json({ task_id: taskId, group_id: groupId });
    } catch (err) {
        serverError(res, err);
    }
});

app.post("/api/tasks/:taskId/notes", async (req, res) => {
    const taskId = idParam(req.params.taskId);
    const content = cleanText(req.body?.content, NOTE_MAX);
    const userId = req.user.userId;
    if (!taskId) return notFound(res, "Task");
    if (!content) return invalidInput(res, "content");

    try {
        const taskCheck = await pool.query(
            `SELECT 1 FROM (${accessibleTaskIds("$2")}) AS mine WHERE id = $1`,
            [taskId, userId]
        );

        if (taskCheck.rows.length === 0) {
            return res.status(404).json({ error: "Task not found" });
        }

        const result = await pool.query(
            `INSERT INTO notes (task_id, content)
            VALUES ($1, $2)
            RETURNING *`,
            [taskId, content]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        serverError(res, err);
    }
});

app.post("/api/sessions", async (req, res) => {
    const { totalTime, workedTasks = [], group, date } = req.body;
    const userId = req.user.userId;

    // a session is at most a day long, with at most 500 tasks
    if (!Number.isFinite(totalTime) || totalTime < 0 || totalTime > 24 * 60 * 60) {
        return res.status(400).json({ error: "totalTime must be between 0 and 86400 seconds" });
    }
    if (!Array.isArray(workedTasks) || workedTasks.length > 500) {
        return res.status(400).json({ error: "workedTasks must be an array of at most 500 tasks" });
    }
    if (group !== undefined && group !== null && (typeof group !== "string" || group.length > GROUP_NAME_MAX)) {
        return invalidInput(res, "group");
    }
    if (cleanDate(date) === undefined) return invalidInput(res, "date");

    // session and its task links are saved together or not at all
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        let groupId = null;
        if (group && group !== "all") {
            const groupResult = await client.query(
                "SELECT id FROM groups WHERE name = $1 AND user_id = $2",
                [group, userId]
            );
            if (groupResult.rows.length === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ error: "Group not found" });
            }
            groupId = groupResult.rows[0].id;
        }

        const sessionResult = await client.query(
            `INSERT INTO sessions (group_id, time_ms, date, user_id)
            VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4)
            RETURNING id`,
            [groupId, Math.round(totalTime * 1000), date ?? null, userId]
        );
        const sessionId = sessionResult.rows[0].id;

        // time per task arrives in seconds (like totalTime); the same task twice is summed up.
        // Tasks from shared sessions come as { sharedTaskId, time } and are kept apart, because
        // their ids are from another table (the time itself is booked in the shared session).
        const msPerTask = new Map();
        const msPerSharedTask = new Map();
        for (const task of workedTasks) {
            const seconds = Number.isFinite(task?.time) && task.time > 0 ? Math.min(task.time, 24 * 60 * 60) : 0;
            const sharedId = Number(task?.sharedTaskId);
            if (task?.sharedTaskId !== undefined) {
                if (Number.isInteger(sharedId)) msPerSharedTask.set(sharedId, (msPerSharedTask.get(sharedId) ?? 0) + Math.round(seconds * 1000));
                continue;
            }
            const id = Number(task?.id);
            if (!Number.isInteger(id)) continue;
            msPerTask.set(id, (msPerTask.get(id) ?? 0) + Math.round(seconds * 1000));
        }

        // only shared tasks of sessions I am a member of; unknown ids are ignored
        if (msPerSharedTask.size > 0) {
            await client.query(
                `INSERT INTO session_shared_tasks (session_id, shared_task_id, time_ms)
                SELECT $1, shared_session_tasks.id, worked.time_ms
                FROM unnest($2::int[], $3::int[]) AS worked(task_id, time_ms)
                JOIN shared_session_tasks ON shared_session_tasks.id = worked.task_id
                JOIN shared_session_members ON shared_session_members.session_id = shared_session_tasks.session_id
                    AND shared_session_members.user_id = $4 AND shared_session_members.status = 'joined'
                ON CONFLICT DO NOTHING`,
                [sessionId, [...msPerSharedTask.keys()], [...msPerSharedTask.values()], userId]
            );
        }

        // only link tasks that belong to the user, ignore unknown ids
        if (msPerTask.size > 0) {
            await client.query(
                `INSERT INTO session_tasks (session_id, task_id, time_ms)
                SELECT $1, tasks.id, worked.time_ms
                FROM unnest($2::int[], $3::int[]) AS worked(task_id, time_ms)
                JOIN tasks ON tasks.id = worked.task_id
                WHERE tasks.id IN (${accessibleTaskIds("$4")})
                ON CONFLICT DO NOTHING`,
                [sessionId, [...msPerTask.keys()], [...msPerTask.values()], userId]
            );
        }

        await client.query("COMMIT");

        const result = await pool.query(
            `${SESSION_SELECT}
            WHERE sessions.id = $1
            GROUP BY sessions.id, groups.name`,
            [sessionId]
        );
        res.status(201).json(toSessionResponse(result.rows[0]));
        // challenges, level and today's feed entry, after the answer (the app loads its
        // progress itself; this keeps the friends' feeds current)
        progress.evaluateProgress(pool, userId, announceFeed).catch(err => console.error(err));
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        serverError(res, err);
    } finally {
        client.release();
    }
});

app.post("/api/sessions/:sessionId/tasks/:taskId", async (req, res) => {
    const sessionId = idParam(req.params.sessionId);
    const taskId = idParam(req.params.taskId);
    const userId = req.user.userId;
    if (!sessionId || !taskId) return notFound(res, "Session or task");

    try{
        const ownerCheck = await pool.query(
            `SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2
            UNION ALL
            SELECT 1 FROM (${accessibleTaskIds("$2")}) AS mine WHERE id = $3`,
            [sessionId, userId, taskId]
        );

        if (ownerCheck.rows.length < 2) {
            return res.status(404).json({ error: "Session or task not found" });
        }

        await pool.query(
            `INSERT INTO session_tasks (session_id, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [sessionId, taskId]
        );
        res.status(201).json({ session_id: sessionId, task_id: taskId });
    } catch (err) {
        serverError(res, err);
    }
});

// Usernames: 3-30 letters, digits, "_", "." or "-" (no spaces or look-alike characters),
// unique regardless of upper/lower case
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,30}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_AGE = 14;

const LANGUAGES = ["de", "en"];

// A time zone both Node and Postgres know (IANA name, e.g. "Europe/Berlin"). Postgres reads its
// list from disk (slow), so the zones it knows are asked once and kept.
let postgresTimezones = null;
async function validTimezone(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(value)) return false;
    try {
        new Intl.DateTimeFormat("en", { timeZone: value });
    } catch {
        return false;
    }
    postgresTimezones ??= pool.query("SELECT name FROM pg_timezone_names")
        .then(result => new Set(result.rows.map(row => row.name)))
        .catch(err => { postgresTimezones = null; throw err; });
    return (await postgresTimezones).has(value);
}

// 8-72 characters; bcrypt only uses the first 72 bytes, so longer ones are refused, not cut off
const validPassword = (password) =>
    typeof password === "string" && password.length >= 8 && Buffer.byteLength(password, "utf8") <= 72;

// Age in whole years on today's date, for a "YYYY-MM-DD" birth date; null when it isn't a real date
function ageFromBirthDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split("-").map(Number);
    const birth = new Date(Date.UTC(year, month - 1, day));
    if (birth.getUTCMonth() !== month - 1 || birth.getUTCDate() !== day || year < 1900) return null;
    const today = new Date();
    let age = today.getUTCFullYear() - year;
    if (today.getUTCMonth() < month - 1 || (today.getUTCMonth() === month - 1 && today.getUTCDate() < day)) age--;
    return age;
}

app.post("/api/register", registerLimiter, async (req, res) => {
    const { password, birth_date } = req.body ?? {};
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    // the app's language, for the mails (optional)
    const language = LANGUAGES.includes(req.body?.language) ? req.body.language : null;
    const fail = (status, code, error) => res.status(status).json({ error, code });

    if (!USERNAME_PATTERN.test(username)) return fail(400, "INVALID_USERNAME", "Username must be 3-30 letters, digits, _ . or -");
    if (!validPassword(password)) return fail(400, "WEAK_PASSWORD", "Password must be 8-72 characters");
    if (!displayName || displayName.length > 50) return fail(400, "INVALID_DISPLAY_NAME", "Display name must be 1-50 characters");
    if (!EMAIL_PATTERN.test(email) || email.length > 254) return fail(400, "INVALID_EMAIL", "Invalid email address");
    const age = ageFromBirthDate(birth_date);
    if (age === null || age > 130) return fail(400, "INVALID_BIRTH_DATE", "Invalid birth date");
    if (age < MIN_AGE) return fail(400, "TOO_YOUNG", `You must be at least ${MIN_AGE} years old`);
    // terms, privacy policy and age must all be confirmed; when, is stored as proof
    if (req.body?.accept_terms !== true) return fail(400, "TERMS_REQUIRED", "The terms of use must be accepted");
    if (req.body?.accept_privacy !== true) return fail(400, "PRIVACY_REQUIRED", "The privacy policy must be acknowledged");
    if (req.body?.confirm_age !== true) return fail(400, "AGE_CONFIRMATION_REQUIRED", "The age must be confirmed");

    try {
        const taken = await pool.query(
            `SELECT bool_or(lower(username) = lower($1)) AS username_taken, bool_or(lower(email) = lower($2)) AS email_taken
            FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($2)`,
            [username, email]
        );
        if (taken.rows[0]?.username_taken) return fail(409, "USERNAME_TAKEN", "This username is taken");
        if (taken.rows[0]?.email_taken) return fail(409, "EMAIL_TAKEN", "This email is already registered");

        const passwordHash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (username, password_hash, display_name, birth_date, email, language, terms_accepted_at, privacy_accepted_at)
            VALUES ($1, $2, $3, $4, $5, $6, now(), now())
            RETURNING id, username, email, language, created_at`,
            [username, passwordHash, displayName, birth_date, email, language]
        );
        const user = result.rows[0];

        const rawToken = await createVerificationToken(pool, user.id);
        try {
            await sendVerificationMail(user.email, rawToken, user.language);
        } catch (err) {
            // Registration still succeeds; the user can request a new mail later
            console.error("Verification mail failed:", err);
        }

        res.status(201).json({
            id: user.id,
            username: user.username,
            created_at: user.created_at,
            message: "Registered. Please confirm your email.",
        });
    } catch (err) {
        if (err.code === "23505") {
            // two registrations with the same name at the same moment
            const field = /email/.test(err.constraint ?? "") ? "EMAIL_TAKEN" : "USERNAME_TAKEN";
            return fail(409, field, "Already registered");
        }
        serverError(res, err);
    }
});

// Confirms an email address with the token from the verification link: { token }.
// The token is used up either way; an expired one says so, so the page can offer a new mail.
// Works without being signed in (the link may be opened on another device).
app.post("/api/verify-email", authLimiter, async (req, res) => {
    const token = req.body?.token;
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
        return res.status(400).json({ error: "Invalid or used link", code: "INVALID_TOKEN" });
    }

    try {
        // one statement: the token can't be used twice by two requests at the same moment
        const result = await pool.query(
            `WITH used AS (
                DELETE FROM email_verification_tokens WHERE token_hash = $1
                RETURNING user_id, expires_at > now() AS valid
            ), verified AS (
                UPDATE users SET email_verified = true
                FROM used WHERE users.id = used.user_id AND used.valid
                RETURNING users.id
            )
            SELECT valid FROM used`,
            [hashToken(token)]
        );
        const row = result.rows[0];
        if (!row) return res.status(400).json({ error: "Invalid or used link", code: "INVALID_TOKEN" });
        if (!row.valid) return res.status(400).json({ error: "This link has expired", code: "TOKEN_EXPIRED" });
        res.json({ verified: true });
    } catch (err) {
        serverError(res, err);
    }
});

// Contact form (the second quick way to reach the operator the Impressum needs, § 5 DDG):
// { name, email, message, website }. Works without an account. "website" is a field people
// never see: bots fill it in, and get a normal answer without a mail being sent.
// At most 5 messages per hour from one address; refused input (a typo in the address) doesn't count.
const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: limitFromEnv("RATE_LIMIT_CONTACT", 5),
    skipFailedRequests: true,
    skip: (req) => req.method === "OPTIONS",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many messages, please try again later", code: "RATE_LIMITED" },
});

app.post("/api/contact", contactLimiter, async (req, res) => {
    // one line: no line breaks in the name, which goes into the subject
    const name = typeof req.body?.name === "string" ? req.body.name.replace(/\s+/g, " ").trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const fail = (code, error) => res.status(400).json({ error, code });

    if (!name || name.length > 100) return fail("INVALID_NAME", "Name must be 1-100 characters");
    if (!EMAIL_PATTERN.test(email) || email.length > 254) return fail("INVALID_EMAIL", "Invalid email address");
    if (message.length < 10 || message.length > 5000) return fail("INVALID_MESSAGE", "Message must be 10-5000 characters");
    if (req.body?.website) return res.json({ sent: true });

    try {
        await sendContactMail({ name, email, message });
        res.json({ sent: true });
    } catch (err) {
        console.error("Contact mail failed:", err);
        res.status(502).json({ error: "The message could not be sent", code: "SEND_FAILED" });
    }
});

// A new verification link for an account that can't sign in yet: { email }.
// Same answer whether the address exists, is verified or not, so nobody can probe for accounts;
// the mail is sent in the background so the response time doesn't tell either.
app.post("/api/resend-verification", resendVerificationLimiter, async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
        return res.status(400).json({ error: "Invalid email address", code: "INVALID_EMAIL" });
    }

    try {
        const result = await pool.query(
            "SELECT id, email, email_verified, language FROM users WHERE lower(email) = lower($1)",
            [email]
        );
        const user = result.rows[0];
        if (user && !user.email_verified) {
            const rawToken = await createVerificationToken(pool, user.id);
            sendVerificationMail(user.email, rawToken, user.language).catch((err) => console.error("Resend failed:", err));
        }
        res.json({ message: "If the account exists, a new mail has been sent." });
    } catch (err) {
        serverError(res, err);
    }
});

// Sends me a new verification mail (the older links stop working).
// Not under /api/users, so it also works before pro access is granted.
app.post("/api/verify-email/resend", authenticateToken, verificationMailLimiter, async (req, res) => {
    try {
        const result = await pool.query("SELECT email, email_verified, language FROM users WHERE id = $1", [req.user.userId]);
        const user = result.rows[0];
        if (!user?.email) return res.status(400).json({ error: "No email address", code: "INVALID_EMAIL" });
        if (user.email_verified) return res.status(409).json({ error: "Already verified", code: "ALREADY_VERIFIED" });

        const rawToken = await createVerificationToken(pool, req.user.userId);
        await sendVerificationMail(user.email, rawToken, user.language);
        res.json({ sent: true });
    } catch (err) {
        serverError(res, err);
    }
});

// Compared against when the username doesn't exist, so an unknown user takes as long
// as a wrong password and the response time doesn't reveal which usernames exist
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("no-such-user-placeholder", 10);

app.post("/api/login", loginAccountLimiter, async (req, res) => {
    const { username, password } = req.body ?? {};

    // "username" is the username or the email address; long enough for any valid address
    if (typeof username !== "string" || typeof password !== "string" || !username || !password
        || username.length > 254 || password.length > 1000) {
        return res.status(400).json({ error: "Username and password are required" });
    }

    try {
        // Usernames can't contain "@" and addresses must, so the "@" tells which one was typed.
        // Both are unique regardless of case, so "ann" signs in "Ann" too.
        const identifier = username.trim();
        const column = identifier.includes("@") ? "email" : "username";
        const result = await pool.query(
            `SELECT id, username, password_hash, token_version, email_verified FROM users WHERE lower(${column}) = lower($1)`,
            [identifier]
        );

        const user = result.rows[0];
        const passwordMatch = await bcrypt.compare(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);

        // same status and message for "unknown user" and "wrong password"
        if (!user || !passwordMatch) {
            return res.status(401).json({ error: "Invalid sign in" });
        }
        // only after the password check, so this doesn't tell strangers anything about the account
        if (!user.email_verified) {
            return res.status(403).json({ error: "Email not verified", code: "EMAIL_NOT_VERIFIED" });
        }

        // the real username, also when signing in with the email address
        res.json({ token: signToken(user), username: user.username });
    } catch (err) {
        serverError(res, err);
    }
});

// ---------- Feedback ----------
// { category, message } from a signed-in user, mailed to the operator (CONTACT_TO) with who
// sent it, so a reply can go to their address. At most 10 per hour.
// "rating" is the app's question to new users "Gefällt dir Quidey?": { liked: true, stars: 1-5,
// message optional } or { liked: false, message (what isn't good yet) }.
const FEEDBACK_CATEGORIES = ["idea", "bug", "praise", "other", "rating"];
const feedbackLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: limitFromEnv("RATE_LIMIT_FEEDBACK", 10),
    skipFailedRequests: true,
    skip: (req) => req.method === "OPTIONS",
    keyGenerator: (req) => `feedback:${req.user?.userId ?? ipKeyGenerator(req.ip)}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too much feedback at once, please try again later", code: "RATE_LIMITED" },
});

app.post("/api/feedback", authenticateToken, feedbackLimiter, async (req, res) => {
    const category = req.body?.category;
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const page = typeof req.body?.page === "string" ? req.body.page.slice(0, 200) : "";
    if (!FEEDBACK_CATEGORIES.includes(category)) return res.status(400).json({ error: "Invalid category", code: "INVALID_CATEGORY" });
    let rating = null;
    if (category === "rating") {
        const { liked, stars } = req.body;
        if (typeof liked !== "boolean") return invalidInput(res, "liked");
        if (liked && !(Number.isInteger(stars) && stars >= 1 && stars <= 5)) return invalidInput(res, "stars");
        rating = { liked, stars: liked ? stars : null };
    }
    // a "yes" with its stars needs no words
    const minLength = rating?.liked ? 0 : 5;
    if (message.length < minLength || message.length > 5000) {
        return res.status(400).json({ error: "Feedback must be 5-5000 characters", code: "INVALID_MESSAGE" });
    }
    // where an answer goes: the account's address unless another one is given
    const replyTo = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    if (replyTo && (!EMAIL_PATTERN.test(replyTo) || replyTo.length > 254)) {
        return res.status(400).json({ error: "Invalid email address", code: "INVALID_EMAIL" });
    }

    try {
        const user = (await pool.query("SELECT username, display_name, email FROM users WHERE id = $1", [req.user.userId])).rows[0];
        await sendFeedbackMail({ category, message, page, rating, user: replyTo ? { ...user, email: replyTo } : user });
        res.json({ sent: true });
    } catch (err) {
        console.error("Feedback mail failed:", err);
        res.status(502).json({ error: "The feedback could not be sent", code: "SEND_FAILED" });
    }
});

// ---------- Inbox: messages between friends, notifications ----------

app.use(["/api/messages", "/api/notifications", "/api/inbox"], authenticateToken, requirePro);

const MESSAGE_MAX = 2000;
const directMessageLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: limitFromEnv("RATE_LIMIT_DIRECT_MESSAGES", 30),
    skip: (req) => req.method !== "POST",
    keyGenerator: (req) => `direct-messages:${req.user.userId}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many messages, slow down", code: "RATE_LIMITED" },
});

const areFriends = async (a, b) => (await pool.query(
    `SELECT 1 FROM friendships WHERE status = 'accepted'
        AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
    [a, b]
)).rows.length > 0;

const toMessage = (row, me) => ({
    id: row.id,
    fromMe: row.sender_id === me,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at,
});

// Marks what `other` sent me as read; my other tabs update their badges
async function markConversationRead(me, other) {
    const result = await pool.query(
        "UPDATE messages SET read_at = now() WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL",
        [me, other]
    );
    if (result.rowCount > 0) realtime.toUser(me, "inbox:read", { userId: other });
}

// Unread counts for the menu badge: { messages, notifications }
app.get("/api/inbox/unread", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT (SELECT count(*) FROM messages WHERE recipient_id = $1 AND read_at IS NULL)::int AS messages,
                (SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL)::int AS notifications`,
            [req.user.userId]
        );
        res.json(result.rows[0]);
    } catch (err) {
        serverError(res, err);
    }
});

// My conversations, newest first: [{ user, lastMessage, unread }]
app.get("/api/messages", async (req, res) => {
    const me = req.user.userId;
    try {
        const result = await pool.query(
            `WITH mine AS (
                SELECT *, CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS other_id
                FROM messages WHERE sender_id = $1 OR recipient_id = $1
            ), last AS (
                SELECT DISTINCT ON (other_id) * FROM mine ORDER BY other_id, created_at DESC, id DESC
            )
            SELECT last.*, users.username, users.display_name,
                (SELECT count(*) FROM mine WHERE mine.other_id = last.other_id
                    AND mine.recipient_id = $1 AND mine.read_at IS NULL)::int AS unread
            FROM last JOIN users ON users.id = last.other_id
            ORDER BY last.created_at DESC`,
            [me]
        );
        res.json(result.rows.map(row => ({
            user: { id: row.other_id, username: row.username, displayName: row.display_name },
            lastMessage: toMessage(row, me),
            unread: row.unread,
        })));
    } catch (err) {
        serverError(res, err);
    }
});

// The conversation with one user (the latest 200), oldest first; opening it marks it read
app.get("/api/messages/:userId", async (req, res) => {
    const me = req.user.userId;
    const other = idParam(req.params.userId);
    if (!other) return notFound(res, "User");
    try {
        const user = (await pool.query("SELECT id, username, display_name FROM users WHERE id = $1", [other])).rows[0];
        if (!user) return notFound(res, "User");
        await markConversationRead(me, other);
        const result = await pool.query(
            `SELECT * FROM (
                SELECT * FROM messages
                WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
                ORDER BY created_at DESC, id DESC LIMIT 200
            ) AS latest ORDER BY created_at, id`,
            [me, other]
        );
        res.json({
            user: { id: user.id, username: user.username, displayName: user.display_name },
            canWrite: await areFriends(me, other),
            messages: result.rows.map(row => toMessage(row, me)),
        });
    } catch (err) {
        serverError(res, err);
    }
});

// Send a message to a friend: { body }
app.post("/api/messages/:userId", directMessageLimiter, async (req, res) => {
    const me = req.user.userId;
    const other = idParam(req.params.userId);
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!other || other === me) return notFound(res, "User");
    if (!body || body.length > MESSAGE_MAX) {
        return res.status(400).json({ error: `Message must be 1-${MESSAGE_MAX} characters`, code: "INVALID_MESSAGE" });
    }
    try {
        if (!await areFriends(me, other)) {
            return res.status(403).json({ error: "You can only write to friends", code: "NOT_FRIENDS" });
        }
        const result = await pool.query(
            "INSERT INTO messages (sender_id, recipient_id, body) VALUES ($1, $2, $3) RETURNING *",
            [me, other, body]
        );
        const row = result.rows[0];
        res.status(201).json(toMessage(row, me));

        // right away to the friend, and to my other tabs
        const people = await pool.query("SELECT id, username, display_name FROM users WHERE id = ANY($1::int[])", [[me, other]]);
        const byId = new Map(people.rows.map(user => [user.id, { id: user.id, username: user.username, displayName: user.display_name }]));
        realtime.toUser(other, "message:new", { user: byId.get(me), message: toMessage(row, other) });
        realtime.toUser(me, "message:new", { user: byId.get(other), message: toMessage(row, me) });
        pushLater(pool, [other], "messages", () => PUSH_TEXTS.message({ from: byId.get(me), body }));
    } catch (err) {
        serverError(res, err);
    }
});

// The conversation is open and a new message came in: mark it read without loading it again
app.post("/api/messages/:userId/read", async (req, res) => {
    const other = idParam(req.params.userId);
    if (!other) return notFound(res, "User");
    try {
        await markConversationRead(req.user.userId, other);
        res.json({ read: true });
    } catch (err) {
        serverError(res, err);
    }
});

// My notifications (the latest 100), newest first
// A notification as the app gets it (list and live); data only for kinds that have some
// (task_assigned: { sessionId, taskId, by })
const toNotice = (row) => ({
    id: row.id, kind: row.kind, title: row.title, body: row.body, createdAt: row.created_at, readAt: row.read_at,
    ...(row.data && { data: row.data }),
});

app.get("/api/notifications", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, kind, title, body, data, created_at, read_at FROM notifications
            WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
            [req.user.userId]
        );
        res.json(result.rows.map(toNotice));
    } catch (err) {
        serverError(res, err);
    }
});

// Mark all my notifications read
app.post("/api/notifications/read", async (req, res) => {
    try {
        const result = await pool.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [req.user.userId]);
        if (result.rowCount > 0) realtime.toUser(req.user.userId, "inbox:read", {});
        res.json({ read: true });
    } catch (err) {
        serverError(res, err);
    }
});

// Delete one of my notifications
app.delete("/api/notifications/:id", async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return notFound(res, "Notification");
    try {
        const result = await pool.query("DELETE FROM notifications WHERE id = $1 AND user_id = $2", [id, req.user.userId]);
        if (result.rowCount === 0) return notFound(res, "Notification");
        realtime.toUser(req.user.userId, "inbox:read", {});
        res.json({ deleted: true });
    } catch (err) {
        serverError(res, err);
    }
});

// ---------- Admin ----------
// Only for users with is_admin, checked against the account on every request (see loadAccount).
// Every change is written to admin_actions. Admins can't change their own pro/admin status,
// so nobody locks themselves out and there is always at least one admin left.

function requireAdmin(req, res, next) {
    if (!req.account.is_admin) return res.status(403).json({ error: "Admins only", code: "ADMIN_REQUIRED" });
    req.admin = { id: req.account.id, username: req.account.username };
    next();
}

app.use("/api/admin", authenticateToken, requireAdmin);

const adminFail = (res, status, code, error) => res.status(status).json({ error, code });

async function logAdminAction(db, admin, target, action) {
    await db.query(
        `INSERT INTO admin_actions (admin_id, admin_username, target_id, target_username, action)
        VALUES ($1, $2, $3, $4, $5)`,
        [admin.id, admin.username, target.id, target.username, action]
    );
}

// A user as the admin panel shows them (incl. email, which only admins ever see)
const ADMIN_USER_SELECT = `
    SELECT users.id, users.username, users.display_name, users.email, users.created_at,
        users.is_pro, users.is_admin, users.is_tester,
        beta_access_requests.status AS request_status, beta_access_requests.reason AS request_reason,
        beta_access_requests.created_at AS request_created_at, beta_access_requests.decided_at AS request_decided_at
    FROM users
    LEFT JOIN beta_access_requests ON beta_access_requests.user_id = users.id
`;

const toAdminUser = (row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    createdAt: row.created_at,
    isPro: row.is_pro,
    isAdmin: row.is_admin,
    isTester: row.is_tester,
    request: row.request_status ? {
        status: row.request_status,
        reason: row.request_reason,
        createdAt: row.request_created_at,
        decidedAt: row.request_decided_at,
    } : null,
});

async function loadAdminUser(db, id) {
    const result = await db.query(`${ADMIN_USER_SELECT} WHERE users.id = $1`, [id]);
    return result.rows[0] ? toAdminUser(result.rows[0]) : null;
}

// Numbers for the overview and the latest admin actions
// ---------- Broadcasts: a notice to every account (or only the testers) ----------
// { title, body, audience: 'all' (default) | 'testers' }: lands in the inbox (Meldungen) of every
// user, or of the testers and admins only; logged in broadcasts.
const BROADCAST_AUDIENCES = ["all", "testers"];

app.get("/api/admin/broadcasts", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, admin_username, title, body, audience, recipient_count, created_at FROM broadcasts ORDER BY created_at DESC LIMIT 50"
        );
        res.json(result.rows.map(row => ({
            id: row.id, admin: row.admin_username, title: row.title, body: row.body, audience: row.audience,
            recipientCount: row.recipient_count, createdAt: row.created_at,
        })));
    } catch (err) {
        serverError(res, err);
    }
});

app.post("/api/admin/broadcasts", async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!title || title.length > 120) return adminFail(res, 400, "INVALID_TITLE", "Title must be 1-120 characters");
    if (!body || body.length > 2000) return adminFail(res, 400, "INVALID_BODY", "Text must be 1-2000 characters");
    const audience = req.body?.audience ?? "all";
    if (!BROADCAST_AUDIENCES.includes(audience)) return adminFail(res, 400, "INVALID_AUDIENCE", "Audience must be 'all' or 'testers'");

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const broadcast = (await client.query(
            "INSERT INTO broadcasts (admin_id, admin_username, title, body, audience) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at",
            [req.admin.id, req.admin.username, title, body, audience]
        )).rows[0];
        const sent = await client.query(
            `INSERT INTO notifications (user_id, kind, title, body, broadcast_id)
            SELECT id, 'broadcast', $1, $2, $3 FROM users
            WHERE $4 = 'all' OR is_tester OR is_admin
            RETURNING id, user_id, kind, title, body, created_at`,
            [title, body, broadcast.id, audience]
        );
        await client.query("UPDATE broadcasts SET recipient_count = $1 WHERE id = $2", [sent.rowCount, broadcast.id]);
        await client.query("COMMIT");
        res.status(201).json({ id: broadcast.id, audience, recipientCount: sent.rowCount, createdAt: broadcast.created_at });

        // everybody who has the app open sees it right away (each with their own notification id)
        for (const row of sent.rows) {
            realtime.toUser(row.user_id, "notification:new", {
                id: row.id, kind: row.kind, title: row.title, body: row.body, createdAt: row.created_at, readAt: null,
            });
        }
        pushLater(pool, sent.rows.map(row => row.user_id), "social", () => PUSH_TEXTS.broadcast({ title, body }));
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        serverError(res, err);
    } finally {
        client.release();
    }
});

app.get("/api/admin/overview", async (req, res) => {
    try {
        const [counts, actions] = await Promise.all([
            pool.query(`SELECT
                (SELECT count(*) FROM users)::int AS users,
                (SELECT count(*) FROM users WHERE ${APP_ACCESS_SQL})::int AS with_access,
                (SELECT count(*) FROM users WHERE is_admin)::int AS admins,
                (SELECT count(*) FROM users WHERE is_tester)::int AS testers,
                (SELECT count(*) FROM beta_access_requests WHERE status = 'pending')::int AS pending_requests,
                (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::int AS new_this_week,
                (SELECT count(*) FROM shared_sessions WHERE ended_at IS NULL)::int AS open_shared_sessions`),
            pool.query(`SELECT id, admin_username, target_username, action, created_at
                FROM admin_actions ORDER BY id DESC LIMIT 25`),
        ]);
        const c = counts.rows[0];
        res.json({
            users: c.users,
            withAccess: c.with_access,
            admins: c.admins,
            testers: c.testers,
            pendingRequests: c.pending_requests,
            newThisWeek: c.new_this_week,
            openSharedSessions: c.open_shared_sessions,
            actions: actions.rows.map(a => ({
                id: a.id, admin: a.admin_username, target: a.target_username, action: a.action, createdAt: a.created_at,
            })),
        });
    } catch (err) {
        serverError(res, err);
    }
});

// Beta requests, oldest first: ?status=pending (default) | all
app.get("/api/admin/requests", async (req, res) => {
    const all = req.query.status === "all";
    try {
        const result = await pool.query(
            `${ADMIN_USER_SELECT}
            WHERE beta_access_requests.user_id IS NOT NULL AND ($1 OR beta_access_requests.status = 'pending')
            ORDER BY beta_access_requests.status <> 'pending', beta_access_requests.created_at`,
            [all]
        );
        res.json(result.rows.map(toAdminUser));
    } catch (err) {
        serverError(res, err);
    }
});

// Approve (gives pro) or decline an open request. Answers with the updated user.
for (const decision of ["approve", "decline"]) {
    app.post(`/api/admin/requests/:userId/${decision}`, async (req, res) => {
        const targetId = idParam(req.params.userId);
        if (!targetId) return adminFail(res, 404, "REQUEST_NOT_FOUND", "Request not found");
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(
                `UPDATE beta_access_requests SET status = $1, decided_at = now()
                WHERE user_id = $2 AND status = 'pending'
                RETURNING user_id`,
                [decision === "approve" ? "approved" : "declined", targetId]
            );
            if (result.rows.length === 0) {
                await client.query("ROLLBACK");
                return adminFail(res, 404, "REQUEST_NOT_FOUND", "No open request from this user");
            }
            const target = await client.query("SELECT id, username FROM users WHERE id = $1", [targetId]);
            if (decision === "approve") await client.query("UPDATE users SET is_pro = true WHERE id = $1", [targetId]);
            await logAdminAction(client, req.admin, target.rows[0], `${decision}_request`);
            await client.query("COMMIT");
            forgetAccount(targetId);
            res.json(await loadAdminUser(pool, targetId));
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            serverError(res, err);
        } finally {
            client.release();
        }
    });
}

// Forget a request (e.g. declined by mistake), so the user can ask again
app.delete("/api/admin/requests/:userId", async (req, res) => {
    const targetId = idParam(req.params.userId);
    if (!targetId) return adminFail(res, 404, "REQUEST_NOT_FOUND", "Request not found");
    try {
        const result = await pool.query("DELETE FROM beta_access_requests WHERE user_id = $1 RETURNING user_id", [targetId]);
        if (result.rows.length === 0) return adminFail(res, 404, "REQUEST_NOT_FOUND", "Request not found");
        const target = await pool.query("SELECT id, username FROM users WHERE id = $1", [targetId]);
        await logAdminAction(pool, req.admin, target.rows[0], "reset_request");
        res.json(await loadAdminUser(pool, targetId));
    } catch (err) {
        serverError(res, err);
    }
});

// All users, newest first; ?q= searches username, display name and email
app.get("/api/admin/users", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    try {
        const result = await pool.query(
            `${ADMIN_USER_SELECT}
            WHERE $1 = '' OR users.username ILIKE $2 OR users.display_name ILIKE $2 OR users.email ILIKE $2
            ORDER BY users.created_at DESC, users.id DESC
            LIMIT 200`,
            [q, `%${q.replace(/[\\%_]/g, "\\$&")}%`]
        );
        res.json(result.rows.map(toAdminUser));
    } catch (err) {
        serverError(res, err);
    }
});

// Give or take away pro / admin / tester: { isPro?, isAdmin?, isTester? }. Not for yourself, and owners keep admin.
app.patch("/api/admin/users/:id", async (req, res) => {
    const targetId = idParam(req.params.id);
    const { isPro, isAdmin, isTester } = req.body ?? {};
    if (!targetId) return adminFail(res, 404, "USER_NOT_FOUND", "User not found");
    if (targetId === req.admin.id) return adminFail(res, 400, "SELF", "You can't change your own access");
    const changes = [isPro, isAdmin, isTester];
    if (changes.some(value => value !== undefined && typeof value !== "boolean") || changes.every(value => value === undefined)) {
        return adminFail(res, 400, "INVALID_CHANGE", "Send isPro, isAdmin and/or isTester as true or false");
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const before = await client.query("SELECT id, username, is_pro, is_admin, is_tester, is_owner FROM users WHERE id = $1 FOR UPDATE", [targetId]);
        const target = before.rows[0];
        if (!target) {
            await client.query("ROLLBACK");
            return adminFail(res, 404, "USER_NOT_FOUND", "User not found");
        }
        // owners stay admin (the database would switch it back on anyway)
        if (isAdmin === false && target.is_owner) {
            await client.query("ROLLBACK");
            return adminFail(res, 403, "OWNER", "This admin can't be removed");
        }
        if (isPro !== undefined && isPro !== target.is_pro) {
            await client.query("UPDATE users SET is_pro = $1 WHERE id = $2", [isPro, targetId]);
            await logAdminAction(client, req.admin, target, isPro ? "grant_pro" : "revoke_pro");
        }
        if (isAdmin !== undefined && isAdmin !== target.is_admin) {
            await client.query("UPDATE users SET is_admin = $1 WHERE id = $2", [isAdmin, targetId]);
            await logAdminAction(client, req.admin, target, isAdmin ? "grant_admin" : "revoke_admin");
        }
        if (isTester !== undefined && isTester !== target.is_tester) {
            await client.query("UPDATE users SET is_tester = $1 WHERE id = $2", [isTester, targetId]);
            await logAdminAction(client, req.admin, target, isTester ? "grant_tester" : "revoke_tester");
        }
        // giving pro or tester answers an open request
        if (isPro || isTester) {
            await client.query(
                "UPDATE beta_access_requests SET status = 'approved', decided_at = now() WHERE user_id = $1 AND status = 'pending'",
                [targetId]
            );
        }
        await client.query("COMMIT");
        forgetAccount(targetId);
        // without access the sockets lose it too; whoever still has it connects again
        if (isPro === false || isAdmin === false || isTester === false) realtime.disconnectUser(targetId);
        res.json(await loadAdminUser(pool, targetId));
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        serverError(res, err);
    } finally {
        client.release();
    }
});

//PUT endpoints

// Edit my profile: display name and email (the username stays fixed, friends add you by it).
// A new email address (not only in other upper/lower case) has to be confirmed again.
app.put("/api/users", async (req, res) => {
    const userId = req.user.userId;
    const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";

    if (!displayName || displayName.length > 50) {
        return res.status(400).json({ error: "Display name must be 1-50 characters", code: "INVALID_DISPLAY_NAME" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        return res.status(400).json({ error: "Invalid email address", code: "INVALID_EMAIL" });
    }

    try {
        const result = await pool.query(
            `UPDATE users SET display_name = $1, email = $2,
                email_verified = users.email_verified AND coalesce(lower(old.email) = lower($2), false)
            FROM (SELECT email FROM users WHERE id = $3) AS old
            WHERE users.id = $3
            RETURNING users.username, users.display_name, users.birth_date, users.email, users.email_verified,
                users.created_at, users.language, lower(old.email) IS DISTINCT FROM lower(users.email) AS email_changed`,
            [displayName, email, userId]
        );
        const { email_changed: emailChanged, language, ...user } = result.rows[0];

        if (emailChanged) {
            const rawToken = await createVerificationToken(pool, userId);
            try {
                await sendVerificationMail(user.email, rawToken, language);
            } catch (err) {
                // the profile is saved; a new mail can be requested later
                console.error("Verification mail failed:", err);
            }
        }
        res.json(user);
    } catch (err) {
        if (err.code === "23505") {
            return res.status(409).json({ error: "Email already in use", code: "EMAIL_TAKEN" });
        }
        serverError(res, err);
    }
});

// The app tells where I am and which language I use: { timezone ("Europe/Berlin"), language ("de" | "en") },
// both optional. Reminder mails use them (a task at 09:00 is reminded at 09:00 there, in my language).
app.put("/api/users/locale", async (req, res) => {
    const { timezone, language } = req.body ?? {};
    if (timezone !== undefined && !(await validTimezone(timezone))) return invalidInput(res, "timezone");
    if (language !== undefined && !LANGUAGES.includes(language)) return invalidInput(res, "language");
    try {
        await pool.query(
            "UPDATE users SET timezone = COALESCE($1, timezone), language = COALESCE($2, language) WHERE id = $3",
            [timezone ?? null, language ?? null, req.user.userId]
        );
        res.json({ timezone: timezone ?? null, language: language ?? null });
    } catch (err) {
        serverError(res, err);
    }
});

// When tasks without a time of day are reminded: { time: "HH:MM" } in my time zone. Their
// reminders count from it ("at the start" = that time on the day, "1 day before" = the day
// before), for pushes, mails and in the app. Answers { allDayReminderTime }.
app.put("/api/users/reminder-time", async (req, res) => {
    const time = cleanTime(req.body?.time);
    if (!time) return invalidInput(res, "time");
    try {
        await pool.query("UPDATE users SET allday_reminder_time = $1 WHERE id = $2", [time, req.user.userId]);
        res.json({ allDayReminderTime: time });
    } catch (err) {
        serverError(res, err);
    }
});

// The intro tour was closed (finished or skipped): it doesn't open by itself again, on no device
app.put("/api/users/tour-seen", async (req, res) => {
    try {
        await pool.query("UPDATE users SET tour_seen_at = COALESCE(tour_seen_at, now()) WHERE id = $1", [req.user.userId]);
        res.json({ tourSeen: true });
    } catch (err) {
        serverError(res, err);
    }
});

// Change my password. Needs the current one, so a stolen session can't lock the owner out;
// failed attempts count towards the same limit as logins.
app.put("/api/users/password", authLimiter, async (req, res) => {
    const userId = req.user.userId;
    const { currentPassword, newPassword } = req.body ?? {};

    if (!validPassword(newPassword)) {
        // bcrypt only uses the first 72 bytes
        return res.status(400).json({ error: "New password must be 8-72 characters", code: "WEAK_PASSWORD" });
    }
    if (typeof currentPassword !== "string" || !currentPassword || currentPassword.length > 1000) {
        return res.status(400).json({ error: "Current password is required", code: "WRONG_PASSWORD" });
    }

    try {
        const result = await pool.query("SELECT password_hash FROM users WHERE id = $1", [userId]);
        const matches = result.rows.length > 0 && await bcrypt.compare(currentPassword, result.rows[0].password_hash);
        if (!matches) {
            return res.status(401).json({ error: "Current password is wrong", code: "WRONG_PASSWORD" });
        }
        const passwordHash = await bcrypt.hash(newPassword, 10);
        // all other logins end; this device gets a fresh token and stays signed in
        const updated = await pool.query(
            `UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2
            RETURNING id, username, token_version`,
            [passwordHash, userId]
        );
        forgetAccount(userId);
        // the signed-out devices get no more pushes; this one signs up again (the app does that)
        await pool.query("DELETE FROM push_subscriptions WHERE user_id = $1", [userId]);
        // open sockets used the old token; this device connects again with the new one
        realtime.disconnectUser(userId);
        res.json({ message: "Password changed", token: signToken(updated.rows[0]) });
    } catch (err) {
        serverError(res, err);
    }
});

// Sign out everywhere: every login token of this account stops working (this one too)
app.post("/api/users/logout-all", async (req, res) => {
    try {
        await pool.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [req.user.userId]);
        // no device of a signed-out account gets pushes any more
        await pool.query("DELETE FROM push_subscriptions WHERE user_id = $1", [req.user.userId]);
        forgetAccount(req.user.userId);
        realtime.disconnectUser(req.user.userId);
        res.json({ message: "Signed out everywhere" });
    } catch (err) {
        serverError(res, err);
    }
});

// Delete my account for good: { password }. Needs the password, so a stolen session can't do it;
// failed attempts count towards the same limit as logins. Tasks, groups and my own sessions go
// with it (their tables don't cascade); everything else that points at the account either
// cascades or keeps a null in its place (admin log, shared session history).
// The last admin can't leave, so there is always somebody to run the beta.
app.delete("/api/users", authLimiter, async (req, res) => {
    const userId = req.user.userId;
    const password = req.body?.password;
    if (typeof password !== "string" || !password || password.length > 1000) {
        return res.status(400).json({ error: "Password is required", code: "WRONG_PASSWORD" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query("SELECT password_hash, is_admin FROM users WHERE id = $1 FOR UPDATE", [userId]);
        const user = result.rows[0];
        if (!user || !await bcrypt.compare(password, user.password_hash)) {
            await client.query("ROLLBACK");
            return res.status(401).json({ error: "Password is wrong", code: "WRONG_PASSWORD" });
        }
        if (user.is_admin) {
            const admins = await client.query("SELECT count(*)::int AS n FROM users WHERE is_admin");
            if (admins.rows[0].n <= 1) {
                await client.query("ROLLBACK");
                return res.status(409).json({ error: "The last admin can't delete their account", code: "LAST_ADMIN" });
            }
        }

        await client.query(
            "DELETE FROM sessions WHERE user_id = $1 OR group_id IN (SELECT id FROM groups WHERE user_id = $1)",
            [userId]
        );
        await client.query("DELETE FROM tasks WHERE user_id = $1", [userId]);
        await client.query("DELETE FROM groups WHERE user_id = $1", [userId]);
        // my families stay for the others: the longest member takes over (a family nobody
        // else joined goes with the account)
        await client.query(
            `UPDATE families SET owner_id = heir.user_id
            FROM (
                SELECT DISTINCT ON (family_id) family_id, user_id FROM family_members
                WHERE status = 'joined' AND user_id <> $1
                ORDER BY family_id, joined_at, user_id
            ) AS heir
            WHERE families.id = heir.family_id AND families.owner_id = $1`,
            [userId]
        );
        await client.query("DELETE FROM users WHERE id = $1", [userId]);
        await client.query("COMMIT");
        forgetAccount(userId);
        realtime.disconnectUser(userId);
        res.json({ message: "Account deleted" });
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        serverError(res, err);
    } finally {
        client.release();
    }
});

app.put("/api/tasks/:id", async (req, res) => {
    const id = idParam(req.params.id);
    const userId = req.user.userId;
    if (!id) return notFound(res, "Task");
    const name = cleanText(req.body?.name, TASK_NAME_MAX);
    const description = cleanText(req.body?.description, TASK_DESCRIPTION_MAX);
    const due = cleanDate(req.body?.due);
    const prio = cleanPrio(req.body?.prio);
    const done = req.body?.done ?? false;
    // the optional fields are only changed when they are sent, so older clients keep them
    const extras = readTaskExtras(req.body);
    if (!name) return invalidInput(res, "name");
    if (description === undefined) return invalidInput(res, "description");
    if (due === undefined) return invalidInput(res, "due");
    if (prio === undefined) return invalidInput(res, "prio");
    if (typeof done !== "boolean") return invalidInput(res, "done");
    if (extras.error) return invalidInput(res, extras.error);
    if (extras.values.due_time && !due) return invalidInput(res, "due_time");
    if (extras.values.repeat && !due) return invalidInput(res, "repeat");

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const before = await client.query(
            `SELECT done, kind, user_id FROM tasks WHERE id = $1 AND id IN (${accessibleTaskIds("$2")}) FOR UPDATE`,
            [id, userId]
        );
        if (before.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Task not found" });
        }
        const old = before.rows[0];
        const isOwner = old.user_id === userId;
        // task or event, and its type, are the owner's to choose
        const kind = isOwner && extras.values.kind ? extras.values.kind : old.kind;
        if (isOwner && kind !== "event") extras.values.event_type_id = null;
        const invalid = kind === "event" && !due ? "due"
            : isOwner && !(await ownEventType(client, extras.values.event_type_id, userId)) ? "event_type_id"
            : null;
        if (invalid) {
            await client.query("ROLLBACK");
            return invalidInput(res, invalid);
        }

        // an end only for something that repeats; a new rhythm forgets the repeats left out
        if ("repeat" in extras.values && !extras.values.repeat) extras.values.repeat_left = null;

        // an event is done when it's over (syncEvents below), never by hand
        const values = [name, due, description, prio, kind === "event" ? Boolean(old.done) : done, id, userId];
        // completed_at: set when the task becomes done (SET sees the old row), cleared when reopened
        const sets = ["name = $1", "due = $2", "description = $3", "prio = $4", "done = $5",
            "completed_at = CASE WHEN NOT $5 THEN NULL WHEN tasks.done THEN tasks.completed_at ELSE now() END"];
        for (const [column, value] of Object.entries(extras.values)) {
            values.push(value);
            // e.g. mails go to the owner, so only the owner turns them on or off ($7: me)
            sets.push(OWNER_ONLY_FIELDS.includes(column)
                ? `${column} = CASE WHEN tasks.user_id = $7 THEN $${values.length} ELSE tasks.${column} END`
                : `${column} = $${values.length}`);
        }
        // without a day there is no time of day and no repeating either
        if (!due && !("due_time" in extras.values)) sets.push("due_time = NULL");
        if (!due && !("repeat" in extras.values)) sets.push("repeat = NULL", "repeat_left = NULL");
        if ("repeat" in extras.values) {
            values.push(extras.values.repeat);
            sets.push(`repeat_skip = CASE WHEN tasks.repeat IS DISTINCT FROM $${values.length} THEN '{}' ELSE tasks.repeat_skip END`);
        }

        await client.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $6 AND id IN (${accessibleTaskIds("$7")})`, values);
        const [synced] = await syncEvents(client, "tasks.id = $1", [id]);
        const nextId = kind === "event" ? synced?.nextId ?? null
            : old.done || !done ? null : await createNextRepeat(client, id);
        await client.query("COMMIT");

        const task = await loadTask(id, userId);
        // a repeating task that was just done comes back with the next one
        res.json(nextId ? { ...task, nextTask: await loadTask(nextId, userId) } : task);
        if (task.sharedWith.length > 0 || !task.isOwner) notifyTaskPeople(await taskPeople(id, userId), id);
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        serverError(res, err);
    } finally {
        client.release();
    }
});

// The next one of a repeating task that was just done: the same task (owner, fields, groups)
// on the first day of its rhythm that isn't in the past and wasn't left out (repeat_skip),
// linked by repeat_from_id. Nothing when the task doesn't repeat, its end is reached
// (repeat_left) or its next one already exists (done, reopened, done again).
// Returns the new task's id or null.
async function createNextRepeat(db, taskId) {
    const result = await db.query(
        `WITH source AS (
            SELECT * FROM tasks
            WHERE id = $1 AND repeat IS NOT NULL AND due IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM tasks AS next WHERE next.repeat_from_id = $1)
        ), next_due AS (
            SELECT n, ${repeatDueSql("source", "n")} AS due
            FROM source, generate_series(1, 4000) AS n
            WHERE ${repeatDueSql("source", "n")} >= current_date
                AND NOT ${repeatDueSql("source", "n")} = ANY(source.repeat_skip)
                -- every step counts, also the ones jumped over
                AND (source.repeat_left IS NULL OR n <= source.repeat_left)
            ORDER BY n
            LIMIT 1
        )
        INSERT INTO tasks (name, due, description, prio, user_id, due_time, duration_minutes,
            reminders, location, link, details, repeat, repeat_from_id, color, reminder_email, kind, event_type_id,
            repeat_left, repeat_skip)
        SELECT source.name, next_due.due, source.description, source.prio, source.user_id, source.due_time,
            source.duration_minutes, source.reminders, source.location, source.link, source.details,
            source.repeat, source.id, source.color, source.reminder_email, source.kind, source.event_type_id,
            source.repeat_left - next_due.n,
            ARRAY(SELECT day FROM unnest(source.repeat_skip) AS day WHERE day > next_due.due)
        FROM source, next_due
        RETURNING id`,
        [taskId]
    );
    const nextId = result.rows[0]?.id ?? null;
    if (nextId) {
        await db.query(
            "INSERT INTO task_groups (task_id, group_id) SELECT $1, group_id FROM task_groups WHERE task_id = $2",
            [nextId, taskId]
        );
    }
    return nextId;
}

// { name, description, color? }; without color the colour stays as it is
app.put("/api/groups/:id", async (req, res) => {
    const id = idParam(req.params.id);
    const userId = req.user.userId;
    if (!id) return notFound(res, "Group");
    const name = cleanText(req.body?.name, GROUP_NAME_MAX);
    const description = cleanText(req.body?.description, GROUP_DESCRIPTION_MAX);
    const keepColor = req.body?.color === undefined;
    const color = keepColor ? null : TASK_EXTRAS.color(req.body.color);
    if (!name) return invalidInput(res, "name");
    if (description === undefined) return invalidInput(res, "description");
    if (color === undefined) return invalidInput(res, "color");

    try {
        const result = await pool.query(
            `UPDATE groups
            SET name = $1, description = $2, color = CASE WHEN $5 THEN color ELSE $6 END
            WHERE id = $3 AND user_id = $4
            RETURNING *`,
            [name, description, id, userId, keepColor, color]
        );

        if(result.rows.length === 0) {
            return res.status(404).json({ error: "Group not found" });
        }

        res.json(result.rows[0]);
    } catch (err) { 
        serverError(res, err);
    }
});

app.put("/api/notes/:id", async (req, res) => {
    const id = idParam(req.params.id);
    const content = cleanText(req.body?.content, NOTE_MAX);
    const userId = req.user.userId;
    if (!id) return notFound(res, "Note");
    if (content === undefined) return invalidInput(res, "content");

    try {
        const result = await pool.query(
            `UPDATE notes
            SET content = $1
            WHERE id = $2
            AND task_id IN (${accessibleTaskIds("$3")})
            RETURNING *`,
            [content, id, userId]
        )

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Note not found" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        serverError(res, err);
    }
})

//DELETE endpoints
// Deleting a repeating task asks what goes (?scope=):
//   one        only this one; an open one that repeats leaves its next one behind
//   following  this one and the ones after it (repeat_from_id links them)
//   all        the whole row of them, the done ones before it, too
// Without scope only this one goes (like one, but without a next one: older apps).
// ?occurrence=YYYY-MM-DD names a coming repeat of this (open) task that the app shows but that
// doesn't exist yet: one leaves that day out (repeat_skip), following lets the task end before
// it (repeat_left), all is the same as for the task itself.
// -> { message, deletedIds, task (this task, changed when it stays), nextTask? (took its place) }
app.delete("/api/tasks/:id", async (req, res) => {
    const id = idParam(req.params.id);
    const userId = req.user.userId;
    if (!id) return notFound(res, "Task");
    const scope = req.query.scope ?? null;
    if (scope !== null && !["one", "following", "all"].includes(scope)) return invalidInput(res, "scope");
    const occurrence = req.query.occurrence === undefined ? null : cleanDate(req.query.occurrence);
    if (occurrence === undefined || (occurrence && !scope)) return invalidInput(res, "occurrence");

    const client = await pool.connect();
    try {
        // who else had it, asked before it's gone
        const others = await taskPeople(id, userId);
        await client.query("BEGIN");
        const found = await client.query("SELECT done, repeat FROM tasks WHERE id = $1 AND user_id = $2 FOR UPDATE", [id, userId]);
        if (found.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Task not found" });
        }
        const task = found.rows[0];

        if (occurrence && scope !== "all") {
            // which step of the rhythm that day is (it has to be one of the coming ones)
            const step = await client.query(
                `SELECT n FROM tasks AS t, generate_series(1, 4000) AS n
                WHERE t.id = $1 AND t.repeat IS NOT NULL AND ${repeatDueSql("t", "n")} = $2::date
                LIMIT 1`,
                [id, occurrence]
            );
            if (step.rows.length === 0 || task.done) {
                await client.query("ROLLBACK");
                return invalidInput(res, "occurrence");
            }
            const left = step.rows[0].n - 1;
            if (scope === "one") {
                await client.query(
                    "UPDATE tasks SET repeat_skip = array_append(repeat_skip, $2::date) WHERE id = $1 AND NOT $2::date = ANY(repeat_skip)",
                    [id, occurrence]
                );
            } else {
                // the ones before that day stay; none left means it doesn't repeat any more
                await client.query(
                    `UPDATE tasks SET repeat = CASE WHEN $2 = 0 THEN NULL ELSE repeat END,
                        repeat_left = CASE WHEN $2 = 0 THEN NULL ELSE LEAST(COALESCE(repeat_left, $2), $2) END,
                        repeat_skip = CASE WHEN $2 = 0 THEN '{}' ELSE repeat_skip END
                    WHERE id = $1`,
                    [id, left]
                );
            }
            await client.query("COMMIT");
            res.json({ message: "Task changed", deletedIds: [], task: await loadTask(id, userId) });
            notifyTaskPeople(others, id);
            return;
        }

        // the row this task belongs to: the ones it came from and the ones that came from it
        const chain = await client.query(
            `WITH RECURSIVE before AS (
                SELECT id, repeat_from_id FROM tasks WHERE id = $1
                UNION SELECT tasks.id, tasks.repeat_from_id FROM tasks JOIN before ON tasks.id = before.repeat_from_id
            ), after AS (
                SELECT id FROM tasks WHERE id = $1
                UNION SELECT tasks.id FROM tasks JOIN after ON tasks.repeat_from_id = after.id
            )
            SELECT id, 'before' AS side FROM before WHERE id <> $1
            UNION ALL SELECT id, 'after' FROM after WHERE id <> $1`,
            [id]
        );
        const ids = [id];
        for (const row of chain.rows) {
            if (scope === "all" || (scope === "following" && row.side === "after")) ids.push(row.id);
        }

        // only this one: an open repeating one hands over to its next one first
        const nextId = scope === "one" && !task.done && task.repeat ? await createNextRepeat(client, id) : null;
        const result = await client.query("DELETE FROM tasks WHERE id = ANY($1::int[]) AND user_id = $2 RETURNING id", [ids, userId]);
        await client.query("COMMIT");

        res.json({
            message: "Task deleted",
            deletedIds: result.rows.map(row => row.id),
            task: { id },
            ...(nextId ? { nextTask: await loadTask(nextId, userId) } : {}),
        });
        notifyTaskPeople(others, id);
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        serverError(res, err);
    } finally {
        client.release();
    }
});

app.delete("/api/groups/:id", async (req, res) => {
    const id = idParam(req.params.id);
    const userId = req.user.userId;
    if (!id) return notFound(res, "Group");

    try {
        const result = await pool.query(
            "DELETE FROM groups WHERE id = $1 AND user_id = $2 RETURNING *",
            [id, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Group not found" });
        }

        res.json({ message: "Group deleted", group: result.rows[0] });
    } catch (err) {
        serverError(res, err);
    }
});

app.delete("/api/task-groups/:taskId/:groupId", async (req, res) => {
    const taskId = idParam(req.params.taskId);
    const groupId = idParam(req.params.groupId);
    const userId = req.user.userId;
    if (!taskId || !groupId) return notFound(res, "Connection");

    try {
        const result = await pool.query(
            `DELETE FROM task_groups
             WHERE task_id = $1 
             AND group_id = $2 
             AND task_id IN (${accessibleTaskIds("$3")})
             AND group_id IN (SELECT id FROM groups WHERE user_id = $3)
             RETURNING *`,
             [taskId, groupId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Connection not found" })
        }

        res.json({ message: "Connection deleted", connection: result.rows[0] })
    } catch (err) {
        serverError(res, err);
    }
});

app.delete("/api/notes/:id", async (req, res) => {
    const id = idParam(req.params.id);
    const userId = req.user.userId;
    if (!id) return notFound(res, "Note");

    try {
        const result = await pool.query(
            `DELETE FROM notes
             WHERE id = $1
            AND task_id IN (${accessibleTaskIds("$2")})
            RETURNING *`,
            [id, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Note not found" });
        }

        res.json({ message: "Note deleted", note: result.rows[0] });
    } catch (err) {
        serverError(res, err);
    }
})

// ---------- Tester feedback ----------
// What testers think of what they test (the app's Tester page): per topic stars 1-5 and/or a
// comment, changed as often as they like. Topics: 'ui:<variant>' (interface variants) and
// 'feature:<name>'; the list of what is tested lives in the app, so a new topic needs no
// change here. Admins read everything together under /api/admin/tester-feedback.
const TESTER_TOPIC = /^[a-z0-9]+:[a-z0-9-]{1,48}$/;
const TESTER_COMMENT_MAX = 2000;

const testerFeedbackJson = (row) => ({
    topic: row.topic,
    rating: row.rating,
    comment: row.comment,
    updatedAt: row.updated_at,
});

app.get("/api/tester/feedback", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT topic, rating, comment, updated_at FROM tester_feedback WHERE user_id = $1 ORDER BY topic",
            [req.user.userId]
        );
        res.json(result.rows.map(testerFeedbackJson));
    } catch (err) {
        serverError(res, err);
    }
});

// { rating?: 1-5 | null, comment?: string | null }: only the fields sent change. Both empty
// in the end removes the entry.
app.put("/api/tester/feedback/:topic", async (req, res) => {
    const topic = req.params.topic;
    if (!TESTER_TOPIC.test(topic)) return res.status(400).json({ error: "Invalid topic", code: "INVALID_TOPIC" });
    const body = req.body ?? {};
    const hasRating = Object.hasOwn(body, "rating");
    const hasComment = Object.hasOwn(body, "comment");
    if (!hasRating && !hasComment) return res.status(400).json({ error: "Nothing to save", code: "EMPTY_FEEDBACK" });
    if (hasRating && body.rating !== null && !(Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5)) {
        return res.status(400).json({ error: "Rating must be 1-5", code: "INVALID_RATING" });
    }
    if (hasComment && body.comment !== null && typeof body.comment !== "string") {
        return res.status(400).json({ error: "Invalid comment", code: "INVALID_COMMENT" });
    }
    const comment = hasComment && body.comment !== null ? body.comment.trim() || null : null;
    if (comment && comment.length > TESTER_COMMENT_MAX) {
        return res.status(400).json({ error: `Comment must be at most ${TESTER_COMMENT_MAX} characters`, code: "INVALID_COMMENT" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const before = (await client.query(
            "SELECT rating, comment FROM tester_feedback WHERE user_id = $1 AND topic = $2 FOR UPDATE",
            [req.user.userId, topic]
        )).rows[0];
        const rating = hasRating ? body.rating : before?.rating ?? null;
        const nextComment = hasComment ? comment : before?.comment ?? null;
        let saved = null;
        if (rating === null && nextComment === null) {
            await client.query("DELETE FROM tester_feedback WHERE user_id = $1 AND topic = $2", [req.user.userId, topic]);
        } else {
            saved = (await client.query(
                `INSERT INTO tester_feedback (user_id, topic, rating, comment) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id, topic) DO UPDATE SET rating = $3, comment = $4, updated_at = now()
                 RETURNING topic, rating, comment, updated_at`,
                [req.user.userId, topic, rating, nextComment]
            )).rows[0];
        }
        await client.query("COMMIT");
        res.json(saved ? testerFeedbackJson(saved) : { topic, rating: null, comment: null, updatedAt: null });
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        serverError(res, err);
    } finally {
        client.release();
    }
});

app.delete("/api/tester/feedback/:topic", async (req, res) => {
    if (!TESTER_TOPIC.test(req.params.topic)) return res.status(400).json({ error: "Invalid topic", code: "INVALID_TOPIC" });
    try {
        await pool.query("DELETE FROM tester_feedback WHERE user_id = $1 AND topic = $2", [req.user.userId, req.params.topic]);
        res.json({ deleted: true });
    } catch (err) {
        serverError(res, err);
    }
});

// Everything testers said, per topic: how many rated, the average, how the stars spread, and
// the comments (newest first) with who wrote them.
app.get("/api/admin/tester-feedback", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT f.topic, f.rating, f.comment, f.updated_at, u.id AS user_id, u.username, u.display_name
             FROM tester_feedback f JOIN users u ON u.id = f.user_id
             ORDER BY f.topic, f.updated_at DESC`
        );
        const topics = new Map();
        for (const row of result.rows) {
            if (!topics.has(row.topic)) {
                topics.set(row.topic, { topic: row.topic, ratings: 0, average: null, spread: [0, 0, 0, 0, 0], entries: [] });
            }
            const topic = topics.get(row.topic);
            if (row.rating !== null) {
                topic.ratings += 1;
                topic.spread[row.rating - 1] += 1;
            }
            topic.entries.push({
                user: { id: row.user_id, username: row.username, displayName: row.display_name },
                rating: row.rating,
                comment: row.comment,
                updatedAt: row.updated_at,
            });
        }
        for (const topic of topics.values()) {
            const sum = topic.spread.reduce((total, count, i) => total + count * (i + 1), 0);
            topic.average = topic.ratings ? Math.round((sum / topic.ratings) * 100) / 100 : null;
        }
        const testers = new Set(result.rows.map(row => row.user_id)).size;
        res.json({ testers, topics: [...topics.values()] });
    } catch (err) {
        serverError(res, err);
    }
});

// ---------- Friends ----------
// Only public profile fields ever leave the server: never email or birth date.
// Errors carry a `code` so the frontend can show a translated message.

const publicUser = (row, prefix = "") => ({
    id: row[`${prefix}id`],
    username: row[`${prefix}username`],
    displayName: row[`${prefix}display_name`],
});

// Sending requests answers "does this username exist?", so it's limited per IP
const friendRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    skip: (req) => req.method === "OPTIONS",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later", code: "RATE_LIMITED" },
});

// ---------- online status ----------
// Whether somebody has the app open right now (realtime.js counts the open connections). Their
// friends and the people in their open shared sessions and families see it, unless they
// switched it off (users.show_online). Nothing about it is stored.
// `row`: a users row with id and show_online.
const showsOnline = (row) => Boolean(row.show_online) && realtime.isOnline(row.id);

// Everybody who may see my status: friends, people in my open shared sessions, my families
async function presenceAudience(userId) {
    const result = await pool.query(
        `SELECT friend.id FROM (${friendIdsOf("$1::int")}) AS friend(id)
        UNION SELECT other.user_id FROM shared_session_members AS mine
            JOIN shared_sessions ON shared_sessions.id = mine.session_id AND shared_sessions.ended_at IS NULL
            JOIN shared_session_members AS other ON other.session_id = mine.session_id AND other.status = 'joined'
            WHERE mine.user_id = $1 AND mine.status = 'joined' AND other.user_id <> $1
        UNION SELECT other.user_id FROM family_members AS mine
            JOIN family_members AS other ON other.family_id = mine.family_id AND other.status = 'joined'
            WHERE mine.user_id = $1 AND mine.status = 'joined' AND other.user_id <> $1`,
        [userId]
    );
    return result.rows.map(row => row.id);
}

// Tells the people concerned who have the app open that I came online or went away
async function announcePresence(userId, online) {
    if (online) {
        const me = await pool.query("SELECT show_online FROM users WHERE id = $1", [userId]);
        if (!me.rows[0]?.show_online) return;
    }
    for (const id of await presenceAudience(userId)) {
        if (realtime.isOnline(id)) realtime.toUser(id, "presence:changed", { userId, online });
    }
}
realtime.onPresence(announcePresence);

// Accepted friends, sorted by name; online: has the app open right now (see above)
app.get("/api/friends", async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `SELECT users.id, users.username, users.display_name, friendships.responded_at AS since,
                users.avatar_emoji, users.profile_color, users.status_text, users.level, users.show_online
            FROM friendships
            JOIN users ON users.id = CASE WHEN friendships.requester_id = $1
                THEN friendships.addressee_id ELSE friendships.requester_id END
            WHERE friendships.status = 'accepted'
                AND $1 IN (friendships.requester_id, friendships.addressee_id)
            ORDER BY lower(COALESCE(users.display_name, users.username))`,
            [userId]
        );
        // friends also see each other's avatar and status (see /api/profiles)
        res.json(result.rows.map(row => ({
            ...publicUser(row), since: row.since,
            emoji: row.avatar_emoji, color: row.profile_color, status: row.status_text, level: row.level,
            online: showsOnline(row),
        })));
    } catch (err) {
        serverError(res, err);
    }
});

// Open requests: incoming (waiting for me) and outgoing (waiting for them), newest first
app.get("/api/friends/requests", async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `SELECT friendships.id AS request_id, friendships.created_at,
                friendships.addressee_id = $1 AS incoming,
                users.id, users.username, users.display_name
            FROM friendships
            JOIN users ON users.id = CASE WHEN friendships.requester_id = $1
                THEN friendships.addressee_id ELSE friendships.requester_id END
            WHERE friendships.status = 'pending'
                AND $1 IN (friendships.requester_id, friendships.addressee_id)
            ORDER BY friendships.created_at DESC`,
            [userId]
        );
        const toRequest = row => ({ id: row.request_id, user: publicUser(row), createdAt: row.created_at });
        res.json({
            incoming: result.rows.filter(row => row.incoming).map(toRequest),
            outgoing: result.rows.filter(row => !row.incoming).map(toRequest),
        });
    } catch (err) {
        serverError(res, err);
    }
});

// Send a request by exact username. If that person already asked me, this accepts it.
app.post("/api/friends/requests", friendRequestLimiter, async (req, res) => {
    const userId = req.user.userId;
    const username = typeof req.body?.username === "string" ? req.body.username.trim().replace(/^@/, "") : "";

    if (!username) {
        return res.status(400).json({ error: "Username is required", code: "USERNAME_REQUIRED" });
    }

    try {
        const target = await pool.query("SELECT id, username, display_name FROM users WHERE username = $1", [username]);
        if (target.rows.length === 0) {
            return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
        }
        const other = target.rows[0];
        if (other.id === userId) {
            return res.status(400).json({ error: "You can't add yourself", code: "SELF" });
        }

        const existing = await pool.query(
            `SELECT id, requester_id, status FROM friendships
            WHERE LEAST(requester_id, addressee_id) = LEAST($1::int, $2::int)
                AND GREATEST(requester_id, addressee_id) = GREATEST($1::int, $2::int)`,
            [userId, other.id]
        );
        const pair = existing.rows[0];

        if (pair?.status === "accepted") {
            return res.status(409).json({ error: "You are already friends", code: "ALREADY_FRIENDS" });
        }
        if (pair && pair.requester_id === userId) {
            return res.status(409).json({ error: "Request already sent", code: "ALREADY_REQUESTED" });
        }
        if (pair) {
            // they asked me first: sending back counts as accepting
            const accepted = await pool.query(
                `UPDATE friendships SET status = 'accepted', responded_at = now()
                WHERE id = $1 RETURNING responded_at`,
                [pair.id]
            );
            realtime.toUser(other.id, "friends:changed", {});
            return res.json({ status: "accepted", friend: { ...publicUser(other), since: accepted.rows[0].responded_at } });
        }

        const created = await pool.query(
            `INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2) RETURNING id, created_at`,
            [userId, other.id]
        );
        realtime.toUser(other.id, "friends:changed", {});
        pushInvite("friendRequest", [other.id], userId);
        res.status(201).json({
            status: "pending",
            request: { id: created.rows[0].id, user: publicUser(other), createdAt: created.rows[0].created_at },
        });
    } catch (err) {
        if (err.code === "23505") {
            // both sent at the same moment: the unique pair index caught it
            return res.status(409).json({ error: "Request already exists", code: "ALREADY_REQUESTED" });
        }
        serverError(res, err);
    }
});

// Accept a request sent to me
app.post("/api/friends/requests/:id/accept", async (req, res) => {
    const userId = req.user.userId;
    const requestId = idParam(req.params.id);
    if (!requestId) return res.status(404).json({ error: "Request not found", code: "REQUEST_NOT_FOUND" });
    try {
        const result = await pool.query(
            `UPDATE friendships SET status = 'accepted', responded_at = now()
            WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
            RETURNING requester_id, responded_at`,
            [requestId, userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Request not found", code: "REQUEST_NOT_FOUND" });
        }
        const friend = await pool.query("SELECT id, username, display_name FROM users WHERE id = $1", [result.rows[0].requester_id]);
        realtime.toUser(result.rows[0].requester_id, "friends:changed", {});
        res.json({ friend: { ...publicUser(friend.rows[0]), since: result.rows[0].responded_at } });
    } catch (err) {
        serverError(res, err);
    }
});

// Decline a request sent to me, or cancel one I sent
app.delete("/api/friends/requests/:id", async (req, res) => {
    const userId = req.user.userId;
    const requestId = idParam(req.params.id);
    if (!requestId) return res.status(404).json({ error: "Request not found", code: "REQUEST_NOT_FOUND" });
    try {
        const result = await pool.query(
            `DELETE FROM friendships
            WHERE id = $1 AND status = 'pending' AND $2 IN (requester_id, addressee_id)
            RETURNING id, CASE WHEN requester_id = $2 THEN addressee_id ELSE requester_id END AS other_id`,
            [requestId, userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Request not found", code: "REQUEST_NOT_FOUND" });
        }
        realtime.toUser(result.rows[0].other_id, "friends:changed", {});
        res.json({ id: result.rows[0].id });
    } catch (err) {
        serverError(res, err);
    }
});

// Remove a friend (by their user id)
app.delete("/api/friends/:userId", async (req, res) => {
    const userId = req.user.userId;
    const friendId = idParam(req.params.userId);
    if (!friendId) return res.status(404).json({ error: "Friend not found", code: "FRIEND_NOT_FOUND" });
    try {
        const result = await pool.query(
            `DELETE FROM friendships
            WHERE status = 'accepted'
                AND LEAST(requester_id, addressee_id) = LEAST($1::int, $2::int)
                AND GREATEST(requester_id, addressee_id) = GREATEST($1::int, $2::int)
            RETURNING id`,
            [userId, friendId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Friend not found", code: "FRIEND_NOT_FOUND" });
        }
        realtime.toUser(friendId, "friends:changed", {});
        res.json({ userId: friendId });
    } catch (err) {
        serverError(res, err);
    }
});

// ---------- Profiles ----------
// Anybody signed in can open a profile by username, but only sees username and display name
// (what a friend request reveals anyway). Friends and I myself also see what I set up for my
// profile (bio, status, colour, banner, ...), our mutual friends and, unless I switched it off
// (show_stats), my focus statistics. Email, birth date and timezone never leave the server.

// The lists of choices (and the level each needs) are in utils/progress.js, the same as in the
// frontend (src/features/profile/profileOptions.js, src/features/progress/progress.js)
const BIO_MAX = 280;
const STATUS_MAX = 80;
const STUDY_MAX = 60;
const INTERESTS_MAX = 6;
const INTEREST_MAX = 24;
const MUTUAL_FRIENDS_MAX = 24;
// the heat map on the profile: 26 weeks up to today
const STATS_DAYS = 182;
const DAY_MS = 24 * 60 * 60 * 1000;

// Opening profiles answers "does this username exist?", so it is limited per account
const profileLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: limitFromEnv("RATE_LIMIT_PROFILE", 300),
    skip: (req) => req.method === "OPTIONS",
    keyGenerator: (req) => `user:${req.user.userId}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later", code: "RATE_LIMITED" },
});

// Ids of my accepted friends, as SQL for `IN (...)`; `param` is the placeholder of my id
const friendIdsOf = (param) => `
    SELECT CASE WHEN requester_id = ${param} THEN addressee_id ELSE requester_id END
    FROM friendships WHERE status = 'accepted' AND ${param} IN (requester_id, addressee_id)`;

// Focus statistics of one user. Days are counted in their own timezone (users.timezone, as for
// reminder mails): a session at 23:30 in Berlin belongs to that day, not the next one.
async function loadStats(userId) {
    const result = await pool.query(
        `WITH me AS (SELECT COALESCE(timezone, 'Europe/Berlin') AS tz FROM users WHERE id = $1),
        local AS (
            SELECT (sessions.date AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE me.tz AS at,
                COALESCE(sessions.time_ms, 0)::bigint AS ms
            FROM sessions, me
            WHERE sessions.user_id = $1 AND sessions.date IS NOT NULL
        )
        SELECT
            (SELECT to_char((now() AT TIME ZONE tz)::date, 'YYYY-MM-DD') FROM me) AS today,
            (SELECT COALESCE(json_agg(json_build_object('day', day, 'ms', ms, 'sessions', n, 'longest', longest) ORDER BY day), '[]')
                FROM (SELECT to_char(at::date, 'YYYY-MM-DD') AS day, sum(ms) AS ms, count(*) AS n, max(ms) AS longest
                    FROM local GROUP BY at::date) AS days) AS days,
            (SELECT COALESCE(json_agg(json_build_object('hour', hour, 'ms', ms)), '[]')
                FROM (SELECT extract(hour FROM at)::int AS hour, sum(ms) AS ms FROM local GROUP BY 1) AS hours) AS hours,
            (SELECT COALESCE(json_agg(json_build_object('name', name, 'color', color, 'ms', ms) ORDER BY ms DESC), '[]')
                FROM (SELECT groups.name, groups.color, sum(sessions.time_ms) AS ms
                    FROM sessions JOIN groups ON groups.id = sessions.group_id
                    WHERE sessions.user_id = $1 AND sessions.time_ms > 0
                    GROUP BY groups.id ORDER BY ms DESC LIMIT 3) AS top) AS top_groups,
            (SELECT count(*) FILTER (WHERE done)::int FROM tasks WHERE user_id = $1 AND kind = 'task') AS tasks_done,
            (SELECT count(*) FILTER (WHERE done AND completed_at >= now() - interval '7 days')::int
                FROM tasks WHERE user_id = $1 AND kind = 'task') AS tasks_done_week,
            (SELECT count(*)::int FROM friendships
                WHERE status = 'accepted' AND $1 IN (requester_id, addressee_id)) AS friends,
            (SELECT count(*)::int FROM shared_session_members WHERE user_id = $1 AND status = 'joined') AS shared_sessions,
            (SELECT COALESCE(sum(time_ms), 0)::bigint FROM shared_session_time WHERE user_id = $1) AS shared_ms`,
        [userId]
    );
    return summarizeStats(result.rows[0]);
}

// The numbers the profile shows, from the per-day and per-hour sums
function summarizeStats(row) {
    const days = row.days.map(d => ({ ...d, ms: Number(d.ms), longest: Number(d.longest) }));
    const active = days.filter(d => d.ms > 0);
    const byDay = new Map(active.map(d => [d.day, d.ms]));
    const time = (day) => Date.parse(`${day}T00:00:00Z`);
    const today = time(row.today);
    const dayBefore = (n) => new Date(today - n * DAY_MS).toISOString().slice(0, 10);

    // focus per day, oldest first, the last one is today
    const daily = Array.from({ length: STATS_DAYS }, (_, i) => byDay.get(dayBefore(STATS_DAYS - 1 - i)) ?? 0);
    const sumOf = (from, to) => daily.slice(STATS_DAYS - to, STATS_DAYS - from).reduce((a, b) => a + b, 0);

    // a streak still counts while today has no session yet: it only ends after a day without one
    let currentStreak = 0;
    for (let n = byDay.has(row.today) ? 0 : 1; byDay.has(dayBefore(n)); n++) currentStreak++;
    let longestStreak = 0;
    let run = 0;
    active.forEach((d, i) => {
        run = i > 0 && time(d.day) - time(active[i - 1].day) === DAY_MS ? run + 1 : 1;
        longestStreak = Math.max(longestStreak, run);
    });

    // Monday first, like the calendar
    const weekdays = Array(7).fill(0);
    for (const d of active) weekdays[(new Date(time(d.day)).getUTCDay() + 6) % 7] += d.ms;

    const parts = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    for (const { hour, ms } of row.hours) {
        const part = hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 17 ? "afternoon" : hour >= 17 && hour < 22 ? "evening" : "night";
        parts[part] += Number(ms);
    }
    const favoriteTime = Object.entries(parts).reduce((best, entry) => (entry[1] > best[1] ? entry : best), [null, 0])[0];

    const totalMs = days.reduce((sum, d) => sum + d.ms, 0);
    const sessions = days.reduce((sum, d) => sum + d.sessions, 0);
    const best = active.reduce((top, d) => (!top || d.ms > top.ms ? d : top), null);

    return {
        today: row.today,
        totalMs,
        sessions,
        activeDays: active.length,
        avgSessionMs: sessions > 0 ? Math.round(totalMs / sessions) : 0,
        longestSessionMs: days.reduce((max, d) => Math.max(max, d.longest), 0),
        currentStreak,
        longestStreak,
        todayMs: daily[STATS_DAYS - 1],
        weekMs: sumOf(0, 7),
        lastWeekMs: sumOf(7, 14),
        monthMs: sumOf(0, 30),
        bestDay: best ? { day: best.day, ms: best.ms } : null,
        weekdays,
        favoriteTime,
        daily,
        topGroups: row.top_groups.map(g => ({ name: g.name, color: g.color, ms: Number(g.ms) })),
        tasksDone: row.tasks_done,
        tasksDoneWeek: row.tasks_done_week,
        friends: row.friends,
        sharedSessions: row.shared_sessions,
        sharedMs: Number(row.shared_ms),
    };
}

// A profile as `viewerId` may see it, or null when there is no such user.
// relation: 'self' | 'friend' | 'incoming' (they asked me) | 'outgoing' (I asked them) | 'none';
// requestId is the open friend request, to accept or withdraw it right from the profile.
async function loadProfile(where, value, viewerId) {
    const result = await pool.query(
        `SELECT users.id, users.username, users.display_name, users.created_at, users.bio, users.status_text,
            users.study, users.interests, users.profile_color, users.banner, users.avatar_emoji, users.show_stats,
            users.level, users.avatar_frame, users.profile_title, users.showcase_badges, users.share_activity,
            users.show_online,
            friendships.id AS friendship_id, friendships.status AS friendship_status,
            friendships.requester_id, friendships.responded_at
        FROM users
        LEFT JOIN friendships
            ON LEAST(friendships.requester_id, friendships.addressee_id) = LEAST(users.id, $2::int)
            AND GREATEST(friendships.requester_id, friendships.addressee_id) = GREATEST(users.id, $2::int)
        WHERE ${where === "id" ? "users.id = $1" : "lower(users.username) = lower($1)"}`,
        [value, viewerId]
    );
    const row = result.rows[0];
    if (!row) return null;

    const relation = row.id === viewerId ? "self"
        : row.friendship_status === "accepted" ? "friend"
        : row.friendship_status === "pending" ? (row.requester_id === viewerId ? "outgoing" : "incoming")
        : "none";
    const profile = {
        ...publicUser(row),
        relation,
        ...(relation === "incoming" || relation === "outgoing" ? { requestId: row.friendship_id } : {}),
    };
    if (relation !== "self" && relation !== "friend") return profile;

    const statsVisible = relation === "self" || row.show_stats;
    const [stats, mutual] = await Promise.all([
        statsVisible ? loadStats(row.id) : null,
        relation === "friend"
            ? pool.query(
                `SELECT users.id, users.username, users.display_name, users.avatar_emoji, users.profile_color,
                    count(*) OVER ()::int AS total
                FROM users
                WHERE users.id IN (${friendIdsOf("$1::int")}) AND users.id IN (${friendIdsOf("$2::int")})
                ORDER BY lower(COALESCE(users.display_name, users.username))
                LIMIT ${MUTUAL_FRIENDS_MAX}`,
                [row.id, viewerId]
            )
            : null,
    ]);

    return {
        ...profile,
        memberSince: row.created_at,
        ...(relation === "friend" ? { friendsSince: row.responded_at, online: showsOnline(row) } : {}),
        bio: row.bio,
        status: row.status_text,
        study: row.study,
        interests: row.interests,
        color: row.profile_color,
        banner: row.banner,
        emoji: row.avatar_emoji,
        // the highest level reached, and what it unlocked
        level: row.level,
        frame: row.avatar_frame,
        title: row.profile_title,
        // pinned badges only while they are earned (the numbers can go down again)
        showcase: stats ? row.showcase_badges.filter(id => BADGES[id]?.(stats)) : row.showcase_badges,
        // only I see the switches themselves; friends see `stats: null` when it is off
        ...(relation === "self" ? { showStats: row.show_stats, shareActivity: row.share_activity, showOnline: row.show_online } : {}),
        stats,
        ...(mutual ? {
            mutualFriends: mutual.rows.map(m => ({ ...publicUser(m), emoji: m.avatar_emoji, color: m.profile_color })),
            mutualFriendCount: mutual.rows[0]?.total ?? 0,
        } : {}),
    };
}

// Somebody's profile by username (with or without "@"); 404 USER_NOT_FOUND when there is none
app.get("/api/profiles/:username", profileLimiter, async (req, res) => {
    const username = String(req.params.username).trim().replace(/^@/, "");
    if (!username || username.length > 30) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    try {
        const profile = await loadProfile("username", username, req.user.userId);
        if (!profile) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
        res.json(profile);
    } catch (err) {
        serverError(res, err);
    }
});

// My own profile with all statistics
app.get("/api/profile", async (req, res) => {
    try {
        res.json(await loadProfile("id", req.user.userId, req.user.userId));
    } catch (err) {
        serverError(res, err);
    }
});

// Set up my profile. Every field is optional, only the ones sent change; empty text or null clears:
// { bio, status, study, interests: [...], color, banner, emoji, frame, title, showcase: [...],
// showStats, shareActivity, showOnline }. Choices above my level: 403 LEVEL_LOCKED { field, level }.
// Answers with my profile.
app.put("/api/profile", async (req, res) => {
    const body = req.body ?? {};
    const columns = {};

    const text = { bio: ["bio", BIO_MAX], status: ["status_text", STATUS_MAX], study: ["study", STUDY_MAX] };
    for (const [field, [column, max]] of Object.entries(text)) {
        if (!(field in body)) continue;
        const value = cleanText(body[field], max);
        if (value === undefined) return invalidInput(res, field);
        columns[column] = value;
    }

    if ("interests" in body) {
        const list = body.interests ?? [];
        if (!Array.isArray(list) || list.length > INTERESTS_MAX * 2) return invalidInput(res, "interests");
        const interests = [];
        for (const item of list) {
            const tag = cleanText(item, INTEREST_MAX);
            if (tag === undefined) return invalidInput(res, "interests");
            // empty ones and the same tag twice (in any case) are dropped
            if (tag && !interests.some(t => t.toLowerCase() === tag.toLowerCase())) interests.push(tag);
        }
        if (interests.length > INTERESTS_MAX) return invalidInput(res, "interests");
        columns.interests = interests;
    }

    // choices from a list, some of them unlocked by level (utils/progress.js)
    const choices = {
        color: ["profile_color", PROFILE_COLORS], banner: ["banner", PROFILE_BANNERS], emoji: ["avatar_emoji", PROFILE_EMOJIS],
        frame: ["avatar_frame", AVATAR_FRAMES], title: ["profile_title", PROFILE_TITLES],
    };
    const gated = {};
    for (const [field, [column, allowed]] of Object.entries(choices)) {
        if (!(field in body)) continue;
        const value = body[field] ?? null;
        if (value !== null && !allowed.includes(value)) return invalidInput(res, field);
        columns[column] = value;
        gated[field] = { column, value };
    }

    // up to three earned badges, pinned to the profile in this order
    if ("showcase" in body) {
        const list = body.showcase ?? [];
        if (!Array.isArray(list) || list.length > SHOWCASE_MAX || new Set(list).size !== list.length
            || list.some(id => typeof id !== "string" || !BADGES[id])) return invalidInput(res, "showcase");
        columns.showcase_badges = list;
        gated.showcase = { column: "showcase_badges", value: list };
    }

    for (const [field, column] of [["showStats", "show_stats"], ["shareActivity", "share_activity"], ["showOnline", "show_online"]]) {
        if (!(field in body)) continue;
        if (typeof body[field] !== "boolean") return invalidInput(res, field);
        columns[column] = body[field];
    }

    try {
        // a choice my level hasn't unlocked yet is refused, unless it is what I already have
        if (Object.keys(gated).length > 0) {
            const current = (await pool.query(
                "SELECT profile_color, banner, avatar_emoji, avatar_frame, profile_title, showcase_badges FROM users WHERE id = $1",
                [req.user.userId]
            )).rows[0];
            const changed = Object.entries(gated)
                .filter(([, { column, value }]) => JSON.stringify(current[column] ?? null) !== JSON.stringify(value));
            if (changed.length > 0) {
                const level = await progress.unlockLevel(pool, req.user.userId);
                for (const [field, { value }] of changed) {
                    const needed = progress.requiredLevel(field, value);
                    if (needed > level) {
                        return res.status(403).json({ error: `Unlocked at level ${needed}`, code: "LEVEL_LOCKED", field, level: needed });
                    }
                }
                if (changed.some(([field]) => field === "showcase") && gated.showcase.value.length > 0) {
                    const earned = progress.earnedBadges(await loadStats(req.user.userId));
                    if (gated.showcase.value.some(id => !earned.includes(id))) {
                        return res.status(403).json({ error: "Badge not earned yet", code: "BADGE_NOT_EARNED", field: "showcase" });
                    }
                }
            }
        }

        const names = Object.keys(columns);
        if (names.length > 0) {
            // the column names come from the lists above, never from the request
            await pool.query(
                `UPDATE users SET ${names.map((name, i) => `${name} = $${i + 2}`).join(", ")} WHERE id = $1`,
                [req.user.userId, ...Object.values(columns)]
            );
        }
        res.json(await loadProfile("id", req.user.userId, req.user.userId));
        // switched on or off: the others see it right away
        if ("show_online" in columns) {
            await announcePresence(req.user.userId, columns.show_online && realtime.isOnline(req.user.userId));
        }
    } catch (err) {
        serverError(res, err);
    }
});

// ---------- Shared tasks ----------
// The owner sends a task to friends; each gets an invite (status 'pending'). Accepting makes it
// the same task for both (see accessibleTaskIds): either can change it or mark it done, each
// keeps it in their own groups. Only the owner can delete it; a friend can leave it.

// At most this many people per task
const MAX_TASK_SHARES = 20;

// Send my task to friends: { userIds: [...] }. Anybody who isn't my friend, already has it or
// is me is skipped. Answers with the task (its sharedWith shows the new invites).
app.post("/api/tasks/:id/shares", friendRequestLimiter, async (req, res) => {
    const userId = req.user.userId;
    const taskId = idParam(req.params.id);
    const friendIds = idList(req.body?.userIds).filter(id => id !== userId);
    if (!taskId) return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
    if (friendIds.length === 0) return invalidInput(res, "userIds");

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // locks the task, so two requests at once can't go over the limit together
        const task = await client.query("SELECT id FROM tasks WHERE id = $1 AND user_id = $2 FOR UPDATE", [taskId, userId]);
        if (task.rows.length === 0) {
            await client.query("ROLLBACK");
            return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
        }
        const existing = await client.query("SELECT count(*)::int AS count FROM task_shares WHERE task_id = $1", [taskId]);
        if (existing.rows[0].count + friendIds.length > MAX_TASK_SHARES) {
            await client.query("ROLLBACK");
            return fail(res, 409, "TOO_MANY_SHARES", "This task is shared with too many people");
        }
        const shared = await client.query(
            `INSERT INTO task_shares (task_id, user_id, invited_by)
            SELECT $1, friend.id, $2
            FROM unnest($3::int[]) AS friend(id)
            WHERE EXISTS (
                SELECT 1 FROM friendships
                WHERE status = 'accepted'
                    AND LEAST(requester_id, addressee_id) = LEAST($2::int, friend.id)
                    AND GREATEST(requester_id, addressee_id) = GREATEST($2::int, friend.id)
            )
            ON CONFLICT (task_id, user_id) DO NOTHING
            RETURNING user_id`,
            [taskId, userId, friendIds]
        );
        await client.query("COMMIT");
        const sharedTask = await loadTask(taskId, userId);
        res.status(201).json(sharedTask);
        notifyTaskPeople(await taskPeople(taskId, userId), taskId);
        pushInvite("taskShared", shared.rows.map(row => row.user_id), userId, sharedTask?.name);
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        serverError(res, err);
    } finally {
        client.release();
    }
});

// Tasks friends sent me that I haven't answered yet, newest first:
// [{ id, createdAt, from: user, task: { id, name, due, due_time, duration_minutes, location, description } }]
app.get("/api/task-shares", async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `SELECT task_shares.id, task_shares.created_at,
                tasks.id AS task_id, tasks.name, tasks.due, to_char(tasks.due_time, 'HH24:MI') AS due_time,
                tasks.duration_minutes, tasks.location, tasks.description, tasks.color,
                users.id AS from_id, users.username AS from_username, users.display_name AS from_display_name
            FROM task_shares
            JOIN tasks ON tasks.id = task_shares.task_id
            JOIN users ON users.id = tasks.user_id
            WHERE task_shares.user_id = $1 AND task_shares.status = 'pending'
            ORDER BY task_shares.created_at DESC, task_shares.id DESC`,
            [userId]
        );
        res.json(result.rows.map(row => ({
            id: row.id,
            createdAt: row.created_at,
            from: publicUser(row, "from_"),
            task: {
                id: row.task_id,
                name: row.name,
                due: row.due,
                due_time: row.due_time,
                duration_minutes: row.duration_minutes,
                location: row.location,
                description: row.description,
                color: row.color,
            },
        })));
    } catch (err) {
        serverError(res, err);
    }
});

// Accept a task sent to me: answers with the task, which is now in my list
app.post("/api/task-shares/:id/accept", async (req, res) => {
    const userId = req.user.userId;
    const shareId = idParam(req.params.id);
    if (!shareId) return fail(res, 404, "SHARE_NOT_FOUND", "Invite not found");
    try {
        const result = await pool.query(
            `UPDATE task_shares SET status = 'accepted', responded_at = now()
            WHERE id = $1 AND user_id = $2 AND status = 'pending'
            RETURNING task_id`,
            [shareId, userId]
        );
        if (result.rows.length === 0) return fail(res, 404, "SHARE_NOT_FOUND", "Invite not found");
        const taskId = result.rows[0].task_id;
        res.json(await loadTask(taskId, userId));
        notifyTaskPeople(await taskPeople(taskId, userId), taskId);
    } catch (err) {
        serverError(res, err);
    }
});

// Decline an invite, leave a task shared with me, or (as the task's owner) take it back from
// somebody. Leaving also takes the task out of the leaver's groups.
app.delete("/api/task-shares/:id", async (req, res) => {
    const userId = req.user.userId;
    const shareId = idParam(req.params.id);
    if (!shareId) return fail(res, 404, "SHARE_NOT_FOUND", "Invite not found");

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(
            `DELETE FROM task_shares
            USING tasks
            WHERE task_shares.id = $1 AND tasks.id = task_shares.task_id
                AND $2 IN (task_shares.user_id, tasks.user_id)
            RETURNING task_shares.id, task_shares.task_id, task_shares.user_id`,
            [shareId, userId]
        );
        if (result.rows.length === 0) {
            await client.query("ROLLBACK");
            return fail(res, 404, "SHARE_NOT_FOUND", "Invite not found");
        }
        const share = result.rows[0];
        await client.query(
            `DELETE FROM task_groups
            USING groups
            WHERE task_groups.task_id = $1 AND groups.id = task_groups.group_id AND groups.user_id = $2`,
            [share.task_id, share.user_id]
        );
        await client.query("COMMIT");
        res.json({ id: share.id, taskId: share.task_id, userId: share.user_id });
        // the others who still have it, and the one who no longer does
        const others = await taskPeople(share.task_id, userId);
        if (share.user_id !== userId) others.push(share.user_id);
        notifyTaskPeople(others, share.task_id);
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        serverError(res, err);
    } finally {
        client.release();
    }
});

// ---------- Shared sessions ("Together") ----------
// A session has members (invited friends join it), tasks every member can see and work on,
// and time booked per task and person. Members report their time every few seconds
// (POST .../activity), which also tells the others what they are working on right now.
// Only joined members can see a session; for anybody else it doesn't exist (404).

const fail = (res, status, code, error) => res.status(status).json({ error, code });

// A member counts as working right now if they reported within this time. The client reports
// every 30 s (the others' clocks run on in their browsers in between), so this leaves room for
// one late report before somebody counts as gone.
const ONLINE_SECONDS = 75;
// Upper bound for one time report. The client reports every 30 s, but a browser
// throttles timers in background tabs, so a report can cover a few minutes.
const MAX_REPORT_MS = 5 * 60 * 1000;
// A report can't book more than the time since my previous report (plus this much for
// network delays), so nobody can inflate their time by sending reports quickly
const REPORT_SLACK_MS = limitFromEnv("TIME_REPORT_SLACK_MS", 5000);

const sessionName = (value) => typeof value === "string" ? value.trim().slice(0, 100) : "";

const idList = (value) => Array.isArray(value)
    ? [...new Set(value.map(idParam).filter(Boolean))]
    : [];

// My membership row joined with the session, or undefined
async function getMembership(sessionId, userId) {
    const result = await pool.query(
        `SELECT shared_sessions.owner_id, shared_sessions.name, shared_sessions.ended_at, shared_session_members.status
        FROM shared_session_members
        JOIN shared_sessions ON shared_sessions.id = shared_session_members.session_id
        WHERE shared_session_members.session_id = $1 AND shared_session_members.user_id = $2`,
        [sessionId, userId]
    );
    return result.rows[0];
}

// Answers the request itself when I'm not allowed to change the session (not joined, or it ended)
async function requireOpenSession(req, res) {
    const sessionId = idParam(req.params.id);
    const membership = sessionId && await getMembership(sessionId, req.user.userId);
    if (!membership || membership.status !== "joined") {
        fail(res, 404, "SESSION_NOT_FOUND", "Session not found");
        return null;
    }
    if (membership.ended_at) {
        fail(res, 409, "SESSION_ENDED", "This session has ended");
        return null;
    }
    return { sessionId, ...membership, isOwner: membership.owner_id === req.user.userId };
}

// Adds an entry to a session's activity feed; resolves to its id
async function logEvent(db, sessionId, userId, type, { taskId = null, taskName = null, text = null, targetId = null } = {}) {
    const result = await db.query(
        `INSERT INTO shared_session_events (session_id, user_id, type, task_id, task_name, text, target_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [sessionId, userId, type, taskId, taskName, text, targetId]
    );
    return result.rows[0].id;
}

// How many feed entries the session page gets
const EVENT_LIMIT = 60;

// Chat messages are short; this many per person and minute is plenty for a real conversation
const messageLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    skip: (req) => req.method === "OPTIONS",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many messages, please slow down", code: "RATE_LIMITED" },
});

// Invites the given users to a session, skipping anybody who isn't my friend or is already in it.
// Resolves to the ids of the people invited now.
async function inviteFriends(db, sessionId, userId, friendIds) {
    if (friendIds.length === 0) return 0;
    const result = await db.query(
        `INSERT INTO shared_session_members (session_id, user_id, status, invited_by)
        SELECT $1, invitee.id, 'invited', $2
        FROM unnest($3::int[]) AS invitee(id)
        WHERE EXISTS (
            SELECT 1 FROM friendships
            WHERE status = 'accepted'
                AND LEAST(requester_id, addressee_id) = LEAST($2::int, invitee.id)
                AND GREATEST(requester_id, addressee_id) = GREATEST($2::int, invitee.id)
        )
        ON CONFLICT DO NOTHING
        RETURNING user_id`,
        [sessionId, userId, friendIds]
    );
    return result.rows.map(row => row.user_id);
}

// Tells the joined members (and `also`) that a session changed; their open pages load it again
async function notifySession(sessionId, also = []) {
    const result = await pool.query(
        "SELECT user_id FROM shared_session_members WHERE session_id = $1 AND status = 'joined'",
        [sessionId]
    );
    for (const id of new Set([...result.rows.map(row => row.user_id), ...also])) {
        realtime.toUser(id, "session:changed", { sessionId });
    }
}

// A notice in the assignee's inbox: who gave them which task in which session. Title and body
// are the task's and the session's names; the app words it in the reader's language from data.
// A failure here doesn't undo the assignment (that's already answered).
async function noticeTaskAssigned(sessionId, taskId, taskName, byId, assigneeId) {
    try {
        const result = await pool.query(
            `INSERT INTO notifications (user_id, kind, title, body, data)
            SELECT $1, 'task_assigned', left($2, 120), shared_sessions.name,
                jsonb_build_object('sessionId', shared_sessions.id, 'taskId', $3::int,
                    'by', jsonb_build_object('id', users.id, 'username', users.username, 'displayName', users.display_name))
            FROM shared_sessions, users
            WHERE shared_sessions.id = $4 AND users.id = $5
            RETURNING id, kind, title, body, data, created_at, read_at`,
            [assigneeId, taskName, taskId, sessionId, byId]
        );
        const notice = result.rows[0];
        if (notice) {
            realtime.toUser(assigneeId, "notification:new", toNotice(notice));
            const from = notice.data.by;
            pushLater(pool, [assigneeId], "social", (language) => PUSH_TEXTS.taskAssigned({ from, name: taskName, session: notice.body, sessionId }, language));
        }
    } catch (err) {
        console.error(err);
    }
}

// Somebody got a session invite or lost one: their list of invites loads again
function notifyInvites(userIds) {
    for (const id of userIds) realtime.toUser(id, "invites:changed", {});
}

// ---------- sub-groups in sessions and families (experimental, testers) ----------
// A session's or a family's entries sorted into named groups ("Kapitel 1", "Einkauf").
// Everybody sees them (the session / family carries `groups`, each entry its `groupId`), only
// testers make or delete them and put entries in (routes under /api/tester, `group_id` on the
// entry routes). Deleting a group keeps its entries.
const SUB_GROUP_NAME_MAX = 40;
const SUB_GROUPS_MAX = 20;
const SUB_GROUPS = {
    session: { table: "shared_session_groups", parent: "session_id" },
    family: { table: "family_groups", parent: "family_id" },
};

// [{ id, name }] of one session / family, by name
async function loadSubGroups(kind, parentId) {
    const { table, parent } = SUB_GROUPS[kind];
    const result = await pool.query(`SELECT id, name FROM ${table} WHERE ${parent} = $1 ORDER BY lower(name), id`, [parentId]);
    return result.rows;
}

// The sub-group an entry goes into: `group_id` from a request, checked to be one of this
// session's / family's. { value } (null: none), {} when it wasn't sent, { forbidden } for
// somebody who isn't a tester, or { error }.
async function readSubGroup(req, kind, parentId) {
    if (req.body?.group_id === undefined) return {};
    if (!hasTesterAccess(req.account)) return { forbidden: true };
    if (req.body.group_id === null || req.body.group_id === "") return { value: null };
    const id = idParam(req.body.group_id);
    if (!id) return { error: "group_id" };
    const { table, parent } = SUB_GROUPS[kind];
    const found = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 AND ${parent} = $2`, [id, parentId]);
    return found.rows.length > 0 ? { value: id } : { error: "group_id" };
}

const testerRequired = (res) => fail(res, 403, "TESTER_REQUIRED", "Only for testers");

// { name }: a new sub-group. Answers the request itself and resolves to false when it can't be made.
async function addSubGroup(res, kind, parentId, userId, body) {
    const name = cleanText(body?.name, SUB_GROUP_NAME_MAX);
    if (!name) {
        invalidInput(res, "name");
        return false;
    }
    const { table, parent } = SUB_GROUPS[kind];
    const existing = await pool.query(
        `SELECT count(*)::int AS n, COALESCE(bool_or(lower(name) = lower($2)), false) AS taken FROM ${table} WHERE ${parent} = $1`,
        [parentId, name]
    );
    if (existing.rows[0].taken) {
        fail(res, 409, "SUB_GROUP_EXISTS", "There is a group with this name already");
        return false;
    }
    if (existing.rows[0].n >= SUB_GROUPS_MAX) {
        fail(res, 409, "SUB_GROUPS_FULL", `At most ${SUB_GROUPS_MAX} groups`);
        return false;
    }
    await pool.query(`INSERT INTO ${table} (${parent}, name, created_by) VALUES ($1, $2, $3)`, [parentId, name, userId]);
    return true;
}

// Deletes a sub-group (its entries stay, without a group). Answers 404 itself and resolves to false.
async function removeSubGroup(res, kind, parentId, groupIdValue) {
    const { table, parent } = SUB_GROUPS[kind];
    const groupId = idParam(groupIdValue);
    const removed = groupId && await pool.query(`DELETE FROM ${table} WHERE id = $1 AND ${parent} = $2 RETURNING id`, [groupId, parentId]);
    if (!removed || removed.rows.length === 0) {
        fail(res, 404, "SUB_GROUP_NOT_FOUND", "Group not found");
        return false;
    }
    return true;
}

app.post("/api/tester/shared-sessions/:id/groups", async (req, res) => {
    const userId = req.user.userId;
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;
        if (!await addSubGroup(res, "session", session.sessionId, userId, req.body)) return;
        await sendSharedSession(res, session.sessionId, userId, 201);
        await notifySession(session.sessionId);
    } catch (err) {
        serverError(res, err);
    }
});

app.delete("/api/tester/shared-sessions/:id/groups/:groupId", async (req, res) => {
    const userId = req.user.userId;
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;
        if (!await removeSubGroup(res, "session", session.sessionId, req.params.groupId)) return;
        await sendSharedSession(res, session.sessionId, userId);
        await notifySession(session.sessionId);
    } catch (err) {
        serverError(res, err);
    }
});

app.post("/api/tester/families/:id/groups", async (req, res) => {
    const userId = req.user.userId;
    try {
        const family = await requireFamily(req, res);
        if (!family) return;
        if (!await addSubGroup(res, "family", family.familyId, userId, req.body)) return;
        await sendFamily(res, family.familyId, userId, 201);
        await notifyFamily(family.familyId);
    } catch (err) {
        serverError(res, err);
    }
});

app.delete("/api/tester/families/:id/groups/:groupId", async (req, res) => {
    const userId = req.user.userId;
    try {
        const family = await requireFamily(req, res);
        if (!family) return;
        if (!await removeSubGroup(res, "family", family.familyId, req.params.groupId)) return;
        await sendFamily(res, family.familyId, userId);
        await notifyFamily(family.familyId);
    } catch (err) {
        serverError(res, err);
    }
});

// Everything the session page shows:
// { id, name, createdAt, endedAt, owner, isOwner, me (my user id),
//   people: [{ user, status: 'joined' | 'invited' | 'left', isOwner, joinedAt, workingOn, totalMs }],
//   tasks:  [{ id, name, description, done, addedBy, assignee, sourceTaskId, createdAt, groupId, totalMs, time: [{ userId, ms }] }],
//   groups: [{ id, name }] (sub-groups, see above),
//   events: [{ id, type, user, target, taskId, taskName, text, createdAt }] (oldest first, the last EVENT_LIMIT) }
// 'left' people are no longer members but booked time, so they still show up in the totals.
async function loadSharedSession(sessionId, userId) {
    const [session, members, tasks, times, events, groups] = await Promise.all([
        pool.query(
            `SELECT shared_sessions.id, shared_sessions.name, shared_sessions.created_at, shared_sessions.ended_at,
                users.id AS owner_id, users.username AS owner_username, users.display_name AS owner_display_name
            FROM shared_sessions
            JOIN users ON users.id = shared_sessions.owner_id
            WHERE shared_sessions.id = $1`,
            [sessionId]
        ),
        pool.query(
            `SELECT shared_session_members.status, shared_session_members.joined_at,
                CASE WHEN shared_session_members.last_seen_at > now() - make_interval(secs => $2)
                    THEN shared_session_members.current_task_id END AS working_on,
                users.id, users.username, users.display_name, users.show_online
            FROM shared_session_members
            JOIN users ON users.id = shared_session_members.user_id
            WHERE shared_session_members.session_id = $1
            ORDER BY shared_session_members.status DESC, shared_session_members.joined_at, shared_session_members.invited_at`,
            [sessionId, ONLINE_SECONDS]
        ),
        pool.query(
            `SELECT shared_session_tasks.id, shared_session_tasks.name, shared_session_tasks.description,
                shared_session_tasks.done, shared_session_tasks.source_task_id, shared_session_tasks.created_at,
                shared_session_tasks.due, to_char(shared_session_tasks.due_time, 'HH24:MI') AS due_time,
                shared_session_tasks.prio, shared_session_tasks.duration_minutes, shared_session_tasks.location,
                shared_session_tasks.link, shared_session_tasks.details, shared_session_tasks.color,
                shared_session_tasks.kind, shared_session_tasks.group_id,
                users.id AS adder_id, users.username AS adder_username, users.display_name AS adder_display_name,
                assignee.id AS assignee_id, assignee.username AS assignee_username, assignee.display_name AS assignee_display_name
            FROM shared_session_tasks
            LEFT JOIN users ON users.id = shared_session_tasks.added_by
            LEFT JOIN users AS assignee ON assignee.id = shared_session_tasks.assignee_id
            WHERE shared_session_tasks.session_id = $1
            ORDER BY shared_session_tasks.id`,
            [sessionId]
        ),
        pool.query(
            `SELECT shared_session_time.task_id, shared_session_time.time_ms,
                users.id, users.username, users.display_name
            FROM shared_session_time
            JOIN shared_session_tasks ON shared_session_tasks.id = shared_session_time.task_id
            JOIN users ON users.id = shared_session_time.user_id
            WHERE shared_session_tasks.session_id = $1 AND shared_session_time.time_ms > 0
            ORDER BY shared_session_time.time_ms DESC`,
            [sessionId]
        ),
        pool.query(
            `SELECT * FROM (
                SELECT shared_session_events.id, shared_session_events.type, shared_session_events.task_id,
                    shared_session_events.task_name, shared_session_events.text, shared_session_events.created_at,
                    actor.id AS actor_id, actor.username AS actor_username, actor.display_name AS actor_display_name,
                    target.id AS target_id, target.username AS target_username, target.display_name AS target_display_name
                FROM shared_session_events
                LEFT JOIN users AS actor ON actor.id = shared_session_events.user_id
                LEFT JOIN users AS target ON target.id = shared_session_events.target_id
                WHERE shared_session_events.session_id = $1
                ORDER BY shared_session_events.id DESC
                LIMIT $2
            ) AS latest ORDER BY id`,
            [sessionId, EVENT_LIMIT]
        ),
        loadSubGroups("session", sessionId),
    ]);

    const row = session.rows[0];
    if (!row) return null;

    const people = new Map();
    for (const member of members.rows) {
        people.set(member.id, {
            user: publicUser(member),
            status: member.status,
            isOwner: member.id === row.owner_id,
            joinedAt: member.joined_at,
            workingOn: member.working_on,
            online: member.status === "joined" && showsOnline(member),
            totalMs: 0,
        });
    }

    const timeByTask = new Map();
    for (const time of times.rows) {
        const ms = Number(time.time_ms);
        if (!people.has(time.id)) {
            people.set(time.id, { user: publicUser(time), status: "left", isOwner: false, joinedAt: null, workingOn: null, totalMs: 0 });
        }
        people.get(time.id).totalMs += ms;
        if (!timeByTask.has(time.task_id)) timeByTask.set(time.task_id, []);
        timeByTask.get(time.task_id).push({ userId: time.id, ms });
    }

    return {
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        endedAt: row.ended_at,
        owner: publicUser(row, "owner_"),
        isOwner: row.owner_id === userId,
        me: userId,
        people: [...people.values()],
        tasks: tasks.rows.map(task => {
            const time = timeByTask.get(task.id) ?? [];
            return {
                id: task.id,
                name: task.name,
                description: task.description,
                done: task.done,
                due: task.due,
                due_time: task.due_time,
                prio: task.prio,
                duration_minutes: task.duration_minutes,
                location: task.location,
                link: task.link,
                details: task.details,
                color: task.color,
                kind: task.kind,
                addedBy: task.adder_id ? publicUser(task, "adder_") : null,
                assignee: task.assignee_id ? publicUser(task, "assignee_") : null,
                // only the person who shared it can do anything with their own task's id
                sourceTaskId: task.adder_id === userId ? task.source_task_id : null,
                createdAt: task.created_at,
                groupId: task.group_id,
                totalMs: time.reduce((sum, t) => sum + t.ms, 0),
                time,
            };
        }),
        groups,
        events: events.rows.map(event => ({
            id: event.id,
            type: event.type,
            user: event.actor_id ? publicUser(event, "actor_") : null,
            target: event.target_id ? publicUser(event, "target_") : null,
            taskId: event.task_id,
            taskName: event.task_name,
            text: event.text,
            createdAt: event.created_at,
        })),
    };
}

async function sendSharedSession(res, sessionId, userId, status = 200) {
    // events that ended since the last check are done
    await syncSessionEvents("shared_session_tasks.session_id = $1", [sessionId]);
    const session = await loadSharedSession(sessionId, userId);
    if (!session) return fail(res, 404, "SESSION_NOT_FOUND", "Session not found");
    res.status(status).json(session);
}

// My sessions (open first, newest first) and the invites waiting for me
app.get("/api/shared-sessions", async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `SELECT shared_sessions.id, shared_sessions.name, shared_sessions.created_at, shared_sessions.ended_at,
                shared_session_members.status, shared_session_members.invited_at,
                owner.id AS owner_id, owner.username AS owner_username, owner.display_name AS owner_display_name,
                inviter.id AS inviter_id, inviter.username AS inviter_username, inviter.display_name AS inviter_display_name,
                (SELECT count(*) FROM shared_session_members AS m
                    WHERE m.session_id = shared_sessions.id AND m.status = 'joined')::int AS member_count,
                (SELECT count(*) FROM shared_session_members AS m
                    WHERE m.session_id = shared_sessions.id AND m.current_task_id IS NOT NULL
                        AND m.last_seen_at > now() - make_interval(secs => $2))::int AS working_count,
                (SELECT COALESCE(sum(t.time_ms), 0) FROM shared_session_time AS t
                    JOIN shared_session_tasks AS st ON st.id = t.task_id
                    WHERE st.session_id = shared_sessions.id) AS total_ms,
                (SELECT COALESCE(sum(t.time_ms), 0) FROM shared_session_time AS t
                    JOIN shared_session_tasks AS st ON st.id = t.task_id
                    WHERE st.session_id = shared_sessions.id AND t.user_id = $1) AS my_ms
            FROM shared_session_members
            JOIN shared_sessions ON shared_sessions.id = shared_session_members.session_id
            JOIN users AS owner ON owner.id = shared_sessions.owner_id
            LEFT JOIN users AS inviter ON inviter.id = shared_session_members.invited_by
            WHERE shared_session_members.user_id = $1
            ORDER BY shared_sessions.ended_at IS NOT NULL, COALESCE(shared_sessions.ended_at, shared_sessions.created_at) DESC`,
            [userId, ONLINE_SECONDS]
        );
        const summary = row => ({
            id: row.id,
            name: row.name,
            createdAt: row.created_at,
            endedAt: row.ended_at,
            owner: publicUser(row, "owner_"),
            memberCount: row.member_count,
            workingCount: row.working_count,
            totalMs: Number(row.total_ms),
            myMs: Number(row.my_ms),
        });
        res.json({
            sessions: result.rows.filter(row => row.status === "joined").map(summary),
            invites: result.rows.filter(row => row.status === "invited").map(row => ({
                ...summary(row),
                invitedBy: row.inviter_id ? publicUser(row, "inviter_") : null,
                invitedAt: row.invited_at,
            })),
        });
    } catch (err) {
        serverError(res, err);
    }
});

// The tasks of all running sessions I joined, for the solo home page (one group per session):
// [{ id, name, me, groups: [{ id, name }], tasks: [{ id, name, description, done, assignee, addedBy,
//   createdAt, groupId, myMs, totalMs }] }] (no events)
// Registered before /:id, which would otherwise take "my-tasks" for an id.
app.get("/api/shared-sessions/my-tasks", async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `SELECT shared_sessions.id AS session_id, shared_sessions.name AS session_name,
                shared_session_tasks.id, shared_session_tasks.name, shared_session_tasks.description, shared_session_tasks.done,
                shared_session_tasks.created_at, shared_session_tasks.group_id,
                adder.id AS adder_id, adder.username AS adder_username, adder.display_name AS adder_display_name,
                assignee.id AS assignee_id, assignee.username AS assignee_username, assignee.display_name AS assignee_display_name,
                COALESCE((SELECT time_ms FROM shared_session_time
                    WHERE task_id = shared_session_tasks.id AND user_id = $1), 0) AS my_ms,
                COALESCE((SELECT sum(time_ms) FROM shared_session_time
                    WHERE task_id = shared_session_tasks.id), 0) AS total_ms
            FROM shared_session_members
            JOIN shared_sessions ON shared_sessions.id = shared_session_members.session_id
            -- only tasks: a session's events aren't worked on (they show in the session and its calendar)
            LEFT JOIN shared_session_tasks ON shared_session_tasks.session_id = shared_sessions.id
                AND shared_session_tasks.kind = 'task'
            LEFT JOIN users AS assignee ON assignee.id = shared_session_tasks.assignee_id
            LEFT JOIN users AS adder ON adder.id = shared_session_tasks.added_by
            WHERE shared_session_members.user_id = $1 AND shared_session_members.status = 'joined'
                AND shared_sessions.ended_at IS NULL
            ORDER BY lower(shared_sessions.name), shared_sessions.id, shared_session_tasks.id`,
            [userId]
        );
        const sessions = new Map();
        for (const row of result.rows) {
            if (!sessions.has(row.session_id)) {
                sessions.set(row.session_id, { id: row.session_id, name: row.session_name, me: userId, groups: [], tasks: [] });
            }
            if (row.id === null) continue; // a session without tasks yet
            sessions.get(row.session_id).tasks.push({
                id: row.id,
                name: row.name,
                description: row.description,
                done: row.done,
                assignee: row.assignee_id ? publicUser(row, "assignee_") : null,
                addedBy: row.adder_id ? publicUser(row, "adder_") : null,
                createdAt: row.created_at,
                groupId: row.group_id,
                myMs: Number(row.my_ms),
                totalMs: Number(row.total_ms),
            });
        }
        const groups = await pool.query(
            "SELECT id, name, session_id FROM shared_session_groups WHERE session_id = ANY($1) ORDER BY lower(name), id",
            [[...sessions.keys()]]
        );
        for (const group of groups.rows) sessions.get(group.session_id).groups.push({ id: group.id, name: group.name });
        res.json([...sessions.values()]);
    } catch (err) {
        serverError(res, err);
    }
});

// My work in shared sessions for the history, newest first; also sessions I have left:
// [{ id, name, endedAt, lastWorkedAt, myMs, tasks: [{ id, name, done, ms }] }]
app.get("/api/shared-sessions/history", async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `SELECT shared_sessions.id AS session_id, shared_sessions.name AS session_name, shared_sessions.ended_at,
                shared_session_tasks.id, shared_session_tasks.name, shared_session_tasks.done,
                shared_session_time.time_ms, shared_session_time.updated_at
            FROM shared_session_time
            JOIN shared_session_tasks ON shared_session_tasks.id = shared_session_time.task_id
            JOIN shared_sessions ON shared_sessions.id = shared_session_tasks.session_id
            WHERE shared_session_time.user_id = $1 AND shared_session_time.time_ms > 0
            ORDER BY shared_session_time.time_ms DESC`,
            [userId]
        );
        const sessions = new Map();
        for (const row of result.rows) {
            if (!sessions.has(row.session_id)) {
                sessions.set(row.session_id, {
                    id: row.session_id, name: row.session_name, endedAt: row.ended_at,
                    lastWorkedAt: row.updated_at, myMs: 0, tasks: [],
                });
            }
            const entry = sessions.get(row.session_id);
            const ms = Number(row.time_ms);
            entry.myMs += ms;
            if (row.updated_at > entry.lastWorkedAt) entry.lastWorkedAt = row.updated_at;
            entry.tasks.push({ id: row.id, name: row.name, done: row.done, ms });
        }
        res.json([...sessions.values()].sort((a, b) => b.lastWorkedAt - a.lastWorkedAt));
    } catch (err) {
        serverError(res, err);
    }
});

app.get("/api/shared-sessions/:id", async (req, res) => {
    const userId = req.user.userId;
    const sessionId = idParam(req.params.id);
    try {
        const membership = sessionId && await getMembership(sessionId, userId);
        if (!membership || membership.status !== "joined") {
            return fail(res, 404, "SESSION_NOT_FOUND", "Session not found");
        }
        await sendSharedSession(res, sessionId, userId);
    } catch (err) {
        serverError(res, err);
    }
});

// Start a session: { name, friendIds? }. Only friends can be invited.
app.post("/api/shared-sessions", async (req, res) => {
    const userId = req.user.userId;
    const name = sessionName(req.body?.name);
    if (!name) return fail(res, 400, "NAME_REQUIRED", "Name is required");

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const created = await client.query(
            "INSERT INTO shared_sessions (name, owner_id) VALUES ($1, $2) RETURNING id",
            [name, userId]
        );
        const sessionId = created.rows[0].id;
        await client.query(
            `INSERT INTO shared_session_members (session_id, user_id, status, invited_by, joined_at)
            VALUES ($1, $2, 'joined', $2, now())`,
            [sessionId, userId]
        );
        const invited = await inviteFriends(client, sessionId, userId, idList(req.body?.friendIds));
        await logEvent(client, sessionId, userId, "created", { text: name });
        await client.query("COMMIT");
        await sendSharedSession(res, sessionId, userId, 201);
        notifyInvites(invited);
        pushInvite("sessionInvite", invited, userId, name);
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        serverError(res, err);
    } finally {
        client.release();
    }
});

// Any member can invite their own friends: { userIds }
app.post("/api/shared-sessions/:id/invites", async (req, res) => {
    const userId = req.user.userId;
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;
        const invited = await inviteFriends(pool, session.sessionId, userId, idList(req.body?.userIds));
        if (invited.length === 0) return fail(res, 400, "NOTHING_TO_INVITE", "Nobody new to invite");
        await sendSharedSession(res, session.sessionId, userId);
        await notifySession(session.sessionId);
        notifyInvites(invited);
        pushInvite("sessionInvite", invited, userId, session.name);
    } catch (err) {
        serverError(res, err);
    }
});

// Accept an invite
app.post("/api/shared-sessions/:id/join", async (req, res) => {
    const userId = req.user.userId;
    const sessionId = idParam(req.params.id);
    if (!sessionId) return fail(res, 404, "INVITE_NOT_FOUND", "Invite not found");
    try {
        const result = await pool.query(
            `UPDATE shared_session_members SET status = 'joined', joined_at = now()
            WHERE session_id = $1 AND user_id = $2 AND status = 'invited'
                AND session_id IN (SELECT id FROM shared_sessions WHERE ended_at IS NULL)
            RETURNING session_id`,
            [sessionId, userId]
        );
        if (result.rows.length === 0) return fail(res, 404, "INVITE_NOT_FOUND", "Invite not found");
        await logEvent(pool, sessionId, userId, "joined");
        await sendSharedSession(res, sessionId, userId);
        await notifySession(sessionId);
    } catch (err) {
        serverError(res, err);
    }
});

// Leave or decline (my own id, or "me"), or, as the owner, remove a member or take back an invite.
// The owner can't leave their own session; they end or delete it instead.
app.delete("/api/shared-sessions/:id/members/:userId", async (req, res) => {
    const userId = req.user.userId;
    const sessionId = idParam(req.params.id);
    const targetId = req.params.userId === "me" ? userId : idParam(req.params.userId);
    if (!sessionId || !targetId) return fail(res, 404, "MEMBER_NOT_FOUND", "Member not found");
    try {
        const membership = await getMembership(sessionId, userId);
        if (!membership) return fail(res, 404, "SESSION_NOT_FOUND", "Session not found");
        const isOwner = membership.owner_id === userId;
        if (targetId !== userId && !isOwner) return fail(res, 403, "NOT_OWNER", "Only the owner can remove members");
        if (targetId === membership.owner_id) return fail(res, 400, "OWNER_CANNOT_LEAVE", "The owner can't leave the session");

        const result = await pool.query(
            "DELETE FROM shared_session_members WHERE session_id = $1 AND user_id = $2 RETURNING status",
            [sessionId, targetId]
        );
        if (result.rows.length === 0) return fail(res, 404, "MEMBER_NOT_FOUND", "Member not found");
        // declined or withdrawn invites don't make it into the feed
        if (result.rows[0].status === "joined" && !membership.ended_at) {
            if (targetId === userId) await logEvent(pool, sessionId, userId, "left");
            else await logEvent(pool, sessionId, userId, "removed", { targetId });
        }
        realtime.leaveSession(sessionId, targetId);
        res.json({ sessionId, userId: targetId });
        // the one who left (or was removed) too, so their page notices
        await notifySession(sessionId, [targetId]);
        if (result.rows[0].status === "invited") notifyInvites([targetId]);
    } catch (err) {
        serverError(res, err);
    }
});

// Add a task: { taskId } shares one of my own tasks (with its details), { name, ... } creates
// a new one; besides the name every field of SHARED_TASK_FIELDS is optional. group_id (testers):
// the session's sub-group it goes into.
app.post("/api/shared-sessions/:id/tasks", async (req, res) => {
    const userId = req.user.userId;
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;
        const subGroup = await readSubGroup(req, "session", session.sessionId);
        if (subGroup.forbidden) return testerRequired(res);
        if (subGroup.error) return invalidInput(res, subGroup.error);

        let task;
        if (req.body?.taskId !== undefined) {
            const own = await pool.query(
                `SELECT tasks.id, tasks.name, tasks.description, tasks.due, to_char(tasks.due_time, 'HH24:MI') AS due_time,
                    tasks.prio, tasks.duration_minutes, tasks.location, tasks.link, tasks.details,
                    -- an event without its own colour takes its type's (the type itself is personal)
                    COALESCE(tasks.color, event_types.color) AS color, tasks.kind
                FROM tasks LEFT JOIN event_types ON event_types.id = tasks.event_type_id
                WHERE tasks.id = $1 AND tasks.user_id = $2`,
                [idParam(req.body.taskId), userId]
            );
            if (own.rows.length === 0) return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
            const { id, name, ...fields } = own.rows[0];
            // older tasks may have a priority above what the form allows; it comes along as it is
            task = { name, fields, sourceTaskId: id };
        } else {
            const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, TASK_NAME_MAX) : "";
            if (!name) return fail(res, 400, "NAME_REQUIRED", "Name is required");
            const fields = readTaskExtras(req.body, SESSION_TASK_FIELDS);
            if (fields.error) return invalidInput(res, fields.error);
            if (fields.values.due_time && !fields.values.due) return invalidInput(res, "due_time");
            if (fields.values.kind === "event" && !fields.values.due) return invalidInput(res, "due");
            task = { name, fields: fields.values, sourceTaskId: null };
        }
        if ("value" in subGroup) task.fields.group_id = subGroup.value;

        const columns = ["session_id", "name", "added_by", "source_task_id", ...Object.keys(task.fields)];
        const values = [session.sessionId, task.name, userId, task.sourceTaskId, ...Object.values(task.fields)];
        const created = await pool.query(
            `INSERT INTO shared_session_tasks (${columns.join(", ")})
            VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
            values
        );
        // an event entered afterwards is over right away
        await syncSessionEvents("shared_session_tasks.id = $1", [created.rows[0].id], false);
        await logEvent(pool, session.sessionId, userId, "task_added", { taskId: created.rows[0].id, taskName: task.name });
        await sendSharedSession(res, session.sessionId, userId, 201);
        await notifySession(session.sessionId);
    } catch (err) {
        if (err.code === "23505") {
            return fail(res, 409, "TASK_ALREADY_SHARED", "This task is already in the session");
        }
        serverError(res, err);
    }
});

// Change a task: { done?, assigneeId? (a member's id, or null for nobody), name?, group_id?
// (testers), and any of SHARED_TASK_FIELDS (null clears one) }; what isn't sent stays as it is.
// Every member may change them. Done is also set on the personal task it was shared from, the
// details are not.
app.patch("/api/shared-sessions/:id/tasks/:taskId", async (req, res) => {
    const userId = req.user.userId;
    const taskId = idParam(req.params.taskId);
    const { done } = req.body ?? {};
    const changesAssignee = req.body && "assigneeId" in req.body;
    const assigneeId = changesAssignee && req.body.assigneeId !== null ? idParam(req.body.assigneeId) : null;
    const name = req.body?.name === undefined ? undefined : cleanText(req.body.name, TASK_NAME_MAX);
    const fields = readTaskExtras(req.body, SESSION_TASK_FIELDS);

    if (done !== undefined && typeof done !== "boolean") return fail(res, 400, "DONE_REQUIRED", "done must be true or false");
    if (name === null || (req.body?.name !== undefined && name === undefined)) return invalidInput(res, "name");
    if (fields.error) return invalidInput(res, fields.error);
    if (done === undefined && !changesAssignee && name === undefined && Object.keys(fields.values).length === 0
        && req.body?.group_id === undefined) {
        return fail(res, 400, "NOTHING_TO_CHANGE", "Send done, assigneeId or a field");
    }
    if (changesAssignee && req.body.assigneeId !== null && !assigneeId) return fail(res, 404, "MEMBER_NOT_FOUND", "Member not found");

    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;

        const before = await pool.query(
            "SELECT name, done, assignee_id, source_task_id, due, kind FROM shared_session_tasks WHERE id = $1 AND session_id = $2",
            [taskId, session.sessionId]
        );
        if (before.rows.length === 0) return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
        const task = before.rows[0];
        const subGroup = await readSubGroup(req, "session", session.sessionId);
        if (subGroup.forbidden) return testerRequired(res);
        if (subGroup.error) return invalidInput(res, subGroup.error);
        if ("value" in subGroup) fields.values.group_id = subGroup.value;

        // a time of day needs a day; taking the day away takes the time along
        const due = "due" in fields.values ? fields.values.due : task.due;
        if (fields.values.due_time && !due) return invalidInput(res, "due_time");
        if (!due && !("due_time" in fields.values)) fields.values.due_time = null;
        // an event happens on a day and is done once it's over, never by hand
        const kind = fields.values.kind ?? task.kind;
        if (kind === "event" && !due) return invalidInput(res, "due");
        if (kind === "event" && done !== undefined) {
            if (Object.keys(fields.values).length === 0 && !changesAssignee && name === undefined) {
                return fail(res, 400, "EVENT_NOT_DONE_BY_HAND", "An event is done once it is over");
            }
        }
        const setDone = kind === "event" ? undefined : done;

        if (assigneeId) {
            const member = await getMembership(session.sessionId, assigneeId);
            if (member?.status !== "joined") return fail(res, 404, "MEMBER_NOT_FOUND", "Member not found");
        }

        const values = [setDone ?? null, changesAssignee, assigneeId, taskId, name ?? null];
        const sets = ["done = COALESCE($1, done)", "assignee_id = CASE WHEN $2 THEN $3::int ELSE assignee_id END",
            "name = COALESCE($5, name)"];
        for (const [column, value] of Object.entries(fields.values)) {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        }
        await pool.query(`UPDATE shared_session_tasks SET ${sets.join(", ")} WHERE id = $4`, values);
        if (name) task.name = name;
        // a moved event can be over (or open again)
        if (kind === "event" || task.kind === "event") {
            await syncSessionEvents("shared_session_tasks.id = $1", [taskId], false);
        }

        if (setDone !== undefined && setDone !== task.done) {
            if (task.source_task_id) {
                await pool.query(
                    "UPDATE tasks SET done = $1, completed_at = CASE WHEN $1 THEN COALESCE(completed_at, now()) END WHERE id = $2",
                    [done, task.source_task_id]
                );
            }
            await logEvent(pool, session.sessionId, userId, done ? "task_done" : "task_reopened", { taskId, taskName: task.name });
        }
        const assignedToOther = changesAssignee && assigneeId !== task.assignee_id && assigneeId && assigneeId !== userId;
        if (changesAssignee && assigneeId !== task.assignee_id) {
            await logEvent(pool, session.sessionId, userId, "task_assigned", { taskId, taskName: task.name, targetId: assigneeId });
        }
        await sendSharedSession(res, session.sessionId, userId);
        await notifySession(session.sessionId);
        // the one who got it finds it in their inbox (not when I take a task myself)
        if (assignedToOther) await noticeTaskAssigned(session.sessionId, taskId, task.name, userId, assigneeId);
    } catch (err) {
        serverError(res, err);
    }
});

// Remove a task (whoever added it, or the owner). Tasks with booked time stay,
// otherwise the record of who worked on it would be lost; mark them done instead.
app.delete("/api/shared-sessions/:id/tasks/:taskId", async (req, res) => {
    const userId = req.user.userId;
    const taskId = idParam(req.params.taskId);
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;
        const task = await pool.query(
            `SELECT added_by,
                EXISTS (SELECT 1 FROM shared_session_time WHERE task_id = $1 AND time_ms > 0) AS has_time
            FROM shared_session_tasks WHERE id = $1 AND session_id = $2`,
            [taskId, session.sessionId]
        );
        if (task.rows.length === 0) return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
        if (task.rows[0].added_by !== userId && !session.isOwner) {
            return fail(res, 403, "NOT_ALLOWED", "Only who added the task or the owner can remove it");
        }
        if (task.rows[0].has_time) return fail(res, 409, "TASK_HAS_TIME", "Somebody already worked on this task");
        await pool.query("DELETE FROM shared_session_tasks WHERE id = $1", [taskId]);
        await sendSharedSession(res, session.sessionId, userId);
        await notifySession(session.sessionId);
    } catch (err) {
        serverError(res, err);
    }
});

// What I'm doing: { currentTaskId (null = not working), time?: { taskId, ms } }.
// `time` books the milliseconds worked since the last report on that task.
app.post("/api/shared-sessions/:id/activity", async (req, res) => {
    const userId = req.user.userId;
    const currentTaskId = req.body?.currentTaskId == null ? null : idParam(req.body.currentTaskId);
    const time = req.body?.time;
    const bookTaskId = time ? idParam(time.taskId) : null;
    const ms = time ? Math.round(Number(time.ms)) : 0;

    if (req.body?.currentTaskId != null && !currentTaskId) return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
    if (time && (!bookTaskId || !Number.isFinite(ms) || ms < 0 || ms > MAX_REPORT_MS)) {
        return fail(res, 400, "INVALID_TIME", `time.ms must be between 0 and ${MAX_REPORT_MS}`);
    }

    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;

        const wanted = [currentTaskId, bookTaskId].filter(Boolean);
        if (wanted.length > 0) {
            const found = await pool.query(
                "SELECT id, kind FROM shared_session_tasks WHERE session_id = $1 AND id = ANY($2::int[])",
                [session.sessionId, wanted]
            );
            if (found.rows.length < new Set(wanted).size) return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
            // an event happens, nobody works on it with the stopwatch
            if (found.rows.some(row => row.id === currentTaskId && row.kind === "event")) {
                return fail(res, 409, "EVENT_NOT_WORKED", "An event can't be worked on");
            }
        }

        let bookedMs = 0;
        if (bookTaskId && ms > 0) {
            const last = await pool.query(
                `SELECT EXTRACT(EPOCH FROM (now() - last_seen_at)) * 1000 AS since_ms
                FROM shared_session_members WHERE session_id = $1 AND user_id = $2`,
                [session.sessionId, userId]
            );
            // no report yet: only the slack (the app always reports "started" before any time)
            const sinceMs = last.rows[0]?.since_ms;
            const passedMs = sinceMs === null || sinceMs === undefined ? 0 : Math.max(0, Math.round(Number(sinceMs)));
            bookedMs = Math.min(ms, passedMs + REPORT_SLACK_MS);
        }
        if (bookedMs > 0) {
            await pool.query(
                `INSERT INTO shared_session_time (task_id, user_id, time_ms) VALUES ($1, $2, $3)
                ON CONFLICT (task_id, user_id)
                DO UPDATE SET time_ms = shared_session_time.time_ms + EXCLUDED.time_ms, updated_at = now()`,
                [bookTaskId, userId, bookedMs]
            );
            // ...and per day in my time zone, for XP and the challenges (utils/progress.js)
            await pool.query(
                `INSERT INTO shared_time_days (user_id, day, time_ms)
                SELECT id, (now() AT TIME ZONE COALESCE(timezone, 'Europe/Berlin'))::date, $2 FROM users WHERE id = $1
                ON CONFLICT (user_id, day) DO UPDATE SET time_ms = shared_time_days.time_ms + EXCLUDED.time_ms`,
                [userId, bookedMs]
            );
        }
        // the old values, to tell whether I just started on something
        const previous = await pool.query(
            `UPDATE shared_session_members AS m SET current_task_id = $1, last_seen_at = now()
            FROM shared_session_members AS old
            WHERE m.session_id = $2 AND m.user_id = $3
                AND old.session_id = m.session_id AND old.user_id = m.user_id
            RETURNING old.current_task_id,
                old.last_seen_at > now() - make_interval(secs => $4) AS was_online`,
            [currentTaskId, session.sessionId, userId, ONLINE_SECONDS]
        );
        const was = previous.rows[0];
        const workingChanged = (was?.was_online ? was.current_task_id : null) !== currentTaskId;
        const justStarted = currentTaskId && !(was?.was_online && was.current_task_id === currentTaskId);
        if (justStarted) {
            // pausing and going on with the same task shouldn't flood the feed
            const recent = await pool.query(
                `SELECT 1 FROM shared_session_events
                WHERE session_id = $1 AND user_id = $2 AND type = 'started' AND task_id = $3
                    AND created_at > now() - interval '15 minutes'
                    AND id = (SELECT max(id) FROM shared_session_events WHERE session_id = $1 AND user_id = $2)`,
                [session.sessionId, userId, currentTaskId]
            );
            if (recent.rows.length === 0) {
                const task = await pool.query("SELECT name FROM shared_session_tasks WHERE id = $1", [currentTaskId]);
                await logEvent(pool, session.sessionId, userId, "started", { taskId: currentTaskId, taskName: task.rows[0].name });
            }
        }
        await sendSharedSession(res, session.sessionId, userId);
        // the others only hear about it when what they see changed, not with every time report
        if (workingChanged) await notifySession(session.sessionId);
    } catch (err) {
        serverError(res, err);
    }
});

// End the session (owner). It stays visible with its totals, but nobody can change it any more.
app.post("/api/shared-sessions/:id/end", async (req, res) => {
    const userId = req.user.userId;
    const client = await pool.connect();
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;
        if (!session.isOwner) return fail(res, 403, "NOT_OWNER", "Only the owner can end the session");

        await client.query("BEGIN");
        await client.query("UPDATE shared_sessions SET ended_at = now() WHERE id = $1", [session.sessionId]);
        // open invites expire, nobody is working any more
        const expired = await client.query(
            "DELETE FROM shared_session_members WHERE session_id = $1 AND status = 'invited' RETURNING user_id",
            [session.sessionId]
        );
        await client.query("UPDATE shared_session_members SET current_task_id = NULL WHERE session_id = $1", [session.sessionId]);
        await logEvent(client, session.sessionId, userId, "ended");
        await client.query("COMMIT");
        await sendSharedSession(res, session.sessionId, userId);
        await notifySession(session.sessionId);
        notifyInvites(expired.rows.map(row => row.user_id));
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        serverError(res, err);
    } finally {
        client.release();
    }
});

// Chat: { text } goes into the activity feed
app.post("/api/shared-sessions/:id/messages", messageLimiter, async (req, res) => {
    const userId = req.user.userId;
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return fail(res, 400, "TEXT_REQUIRED", "Message is empty");
    if (text.length > 1000) return fail(res, 400, "TEXT_TOO_LONG", "Message is too long");
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;
        const eventId = await logEvent(pool, session.sessionId, userId, "message", { text });
        const loaded = await loadSharedSession(session.sessionId, userId);
        if (!loaded) return fail(res, 404, "SESSION_NOT_FOUND", "Session not found");
        res.status(201).json(loaded);
        // the other members (and my other tabs) get it right away
        const event = loaded.events.find(e => e.id === eventId);
        if (event) realtime.toSession(session.sessionId, "session:event", { sessionId: session.sessionId, event });
    } catch (err) {
        serverError(res, err);
    }
});

// Rename (owner): { name }
app.patch("/api/shared-sessions/:id", async (req, res) => {
    const userId = req.user.userId;
    const name = sessionName(req.body?.name);
    if (!name) return fail(res, 400, "NAME_REQUIRED", "Name is required");
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;
        if (!session.isOwner) return fail(res, 403, "NOT_OWNER", "Only the owner can rename the session");
        const result = await pool.query(
            "UPDATE shared_sessions SET name = $1 WHERE id = $2 AND name <> $1 RETURNING id",
            [name, session.sessionId]
        );
        if (result.rows.length > 0) await logEvent(pool, session.sessionId, userId, "renamed", { text: name });
        await sendSharedSession(res, session.sessionId, userId);
        await notifySession(session.sessionId);
    } catch (err) {
        serverError(res, err);
    }
});

// Delete the session with all its tasks and times (owner)
app.delete("/api/shared-sessions/:id", async (req, res) => {
    const userId = req.user.userId;
    const sessionId = idParam(req.params.id);
    if (!sessionId) return fail(res, 404, "SESSION_NOT_FOUND", "Session not found");
    try {
        // who was in it or invited, asked before it's gone
        const members = await pool.query(
            `SELECT shared_session_members.user_id, shared_session_members.status FROM shared_session_members
            JOIN shared_sessions ON shared_sessions.id = shared_session_members.session_id
            WHERE shared_session_members.session_id = $1 AND shared_sessions.owner_id = $2`,
            [sessionId, userId]
        );
        const result = await pool.query(
            "DELETE FROM shared_sessions WHERE id = $1 AND owner_id = $2 RETURNING id",
            [sessionId, userId]
        );
        if (result.rows.length === 0) return fail(res, 404, "SESSION_NOT_FOUND", "Session not found");
        realtime.closeSession(sessionId);
        res.json({ id: sessionId });
        for (const member of members.rows) {
            realtime.toUser(member.user_id, member.status === "invited" ? "invites:changed" : "session:changed", { sessionId });
        }
    } catch (err) {
        serverError(res, err);
    }
});

// ---------- Quidey Family ----------
// A fixed group of accounts with a calendar and a chat of their own, apart from the shared
// sessions. Members are friends of whoever invited them; only joined members see a family
// (for anybody else it doesn't exist: 404). Everybody in it can add, change and tick off
// calendar entries; removing one is for whoever added it and the owner.
// Live: "family:changed" { familyId } (members, name, entries, invites changed: load again)
// and "family:message" { familyId, message } go to the members' user rooms.
// Also: a board (one short text any member changes), an emoji and a colour (owner), who takes
// care of an entry (assignee, any joined member), and the members' week (XP, focus, streak) for
// those who show their statistics.

const FAMILY_NAME_MAX = 60;
const FAMILY_NOTE_MAX = 2000;
// the emojis a family can have (the same list as in the app, src/features/family/family.js)
const FAMILY_EMOJIS = ["🏡", "🌳", "⭐", "🌻", "🐾", "🎈", "🍀", "🔥", "🌙", "🎵", "☕", "📚", "🏖️", "❤️", "🦊", "🚀"];
const FAMILY_MEMBER_MAX = 20;
// families one account can be in (joined or invited)
const FAMILIES_PER_USER_MAX = 10;
const FAMILY_MESSAGE_PAGE = 100;
const familyBase = "/api/families";

const familyName = (value) => typeof value === "string" ? value.trim().slice(0, FAMILY_NAME_MAX) : "";

// My membership row with the family's owner, or undefined
async function getFamilyMembership(familyId, userId) {
    const result = await pool.query(
        `SELECT families.owner_id, families.name, family_members.status
        FROM family_members JOIN families ON families.id = family_members.family_id
        WHERE family_members.family_id = $1 AND family_members.user_id = $2`,
        [familyId, userId]
    );
    return result.rows[0];
}

// Answers the request itself when I'm not a joined member
async function requireFamily(req, res) {
    const familyId = idParam(req.params.id);
    const membership = familyId && await getFamilyMembership(familyId, req.user.userId);
    if (!membership || membership.status !== "joined") {
        fail(res, 404, "FAMILY_NOT_FOUND", "Family not found");
        return null;
    }
    return { familyId, name: membership.name, isOwner: membership.owner_id === req.user.userId };
}

// Whom to tell about a change: the joined members (with `invited` also the invited people),
// only those who may still use the app
async function familyMemberIds(familyId, { invited = false } = {}) {
    const result = await pool.query(
        `SELECT family_members.user_id FROM family_members JOIN users ON users.id = family_members.user_id
        WHERE family_members.family_id = $1 AND ${APP_ACCESS_SQL}
            ${invited ? "" : "AND family_members.status = 'joined'"}`,
        [familyId]
    );
    return result.rows.map(row => row.user_id);
}

// The members and invited people (and `also`) load the family or their list again
async function notifyFamily(familyId, also = []) {
    const ids = await familyMemberIds(familyId, { invited: true });
    for (const id of new Set([...ids, ...also])) realtime.toUser(id, "family:changed", { familyId });
}

// Invites my friends who aren't in it yet and still have room for another family.
// Resolves to the ids invited now, or { error } when the family would get too big.
async function inviteToFamily(db, familyId, userId, friendIds) {
    if (friendIds.length === 0) return [];
    const count = await db.query("SELECT count(*)::int AS n FROM family_members WHERE family_id = $1", [familyId]);
    if (count.rows[0].n + friendIds.length > FAMILY_MEMBER_MAX) return { error: "FAMILY_FULL" };
    const result = await db.query(
        `INSERT INTO family_members (family_id, user_id, status, invited_by)
        SELECT $1, invitee.id, 'invited', $2
        FROM unnest($3::int[]) AS invitee(id)
        WHERE EXISTS (
            SELECT 1 FROM friendships
            WHERE status = 'accepted'
                AND LEAST(requester_id, addressee_id) = LEAST($2::int, invitee.id)
                AND GREATEST(requester_id, addressee_id) = GREATEST($2::int, invitee.id)
        )
        AND (SELECT count(*) FROM family_members WHERE user_id = invitee.id) < $4
        ON CONFLICT DO NOTHING
        RETURNING user_id`,
        [familyId, userId, friendIds, FAMILIES_PER_USER_MAX]
    );
    return result.rows.map(row => row.user_id);
}

const toFamilyMessage = (row) => ({
    id: row.id,
    user: publicUser(row, "author_"),
    text: row.text,
    createdAt: row.created_at,
});

// Everything the family page shows:
// { id, name, emoji, color, createdAt, owner, isOwner, me,
//   note: { text, updatedAt, updatedBy } | null,
//   people: [{ user, status: 'joined' | 'invited', isOwner, joinedAt, online }],
//   tasks:  [{ id, name, description, done, due, due_time, prio, duration_minutes, location, link,
//              details, color, addedBy, assignee, createdAt, groupId }],
//   groups: [{ id, name }] (sub-groups, see loadSubGroups),
//   week:   { weekStart, people: [{ userId, xp, focusMin, streak }] } (joined members who show
//           their statistics, and me) }
async function loadFamily(familyId, userId) {
    const [family, members, tasks, groups] = await Promise.all([
        pool.query(
            `SELECT families.id, families.name, families.created_at, families.emoji, families.color,
                families.note, families.note_updated_at,
                users.id AS owner_id, users.username AS owner_username, users.display_name AS owner_display_name,
                editor.id AS editor_id, editor.username AS editor_username, editor.display_name AS editor_display_name,
                to_char(date_trunc('week', now() AT TIME ZONE COALESCE((SELECT timezone FROM users WHERE id = $2), 'Europe/Berlin')), 'YYYY-MM-DD') AS monday
            FROM families JOIN users ON users.id = families.owner_id
            LEFT JOIN users AS editor ON editor.id = families.note_updated_by
            WHERE families.id = $1`,
            [familyId, userId]
        ),
        pool.query(
            `SELECT family_members.status, family_members.joined_at, users.id, users.username, users.display_name,
                users.show_online, users.show_stats
            FROM family_members JOIN users ON users.id = family_members.user_id
            WHERE family_members.family_id = $1
            ORDER BY family_members.status DESC, family_members.joined_at, family_members.invited_at`,
            [familyId]
        ),
        pool.query(
            `SELECT family_tasks.id, family_tasks.name, family_tasks.description, family_tasks.done,
                family_tasks.due, to_char(family_tasks.due_time, 'HH24:MI') AS due_time, family_tasks.prio,
                family_tasks.duration_minutes, family_tasks.location, family_tasks.link, family_tasks.details,
                family_tasks.color, family_tasks.created_at, family_tasks.group_id,
                users.id AS adder_id, users.username AS adder_username, users.display_name AS adder_display_name,
                assignee.id AS assignee_id, assignee.username AS assignee_username, assignee.display_name AS assignee_display_name
            FROM family_tasks LEFT JOIN users ON users.id = family_tasks.added_by
            LEFT JOIN users AS assignee ON assignee.id = family_tasks.assignee_id
            WHERE family_tasks.family_id = $1
            ORDER BY family_tasks.due NULLS LAST, family_tasks.due_time NULLS FIRST, family_tasks.id`,
            [familyId]
        ),
        loadSubGroups("family", familyId),
    ]);
    const row = family.rows[0];
    if (!row) return null;

    // the week of the members who show their numbers (and mine)
    const weekIds = members.rows.filter(m => m.status === "joined" && (m.show_stats || m.id === userId)).map(m => m.id);
    const [weekXp, streaks] = await Promise.all([progress.loadXp(pool, weekIds, row.monday), progress.loadStreaks(pool, weekIds)]);

    return {
        id: row.id,
        name: row.name,
        emoji: row.emoji,
        color: row.color,
        createdAt: row.created_at,
        owner: publicUser(row, "owner_"),
        isOwner: row.owner_id === userId,
        me: userId,
        note: row.note ? {
            text: row.note,
            updatedAt: row.note_updated_at,
            updatedBy: row.editor_id ? publicUser(row, "editor_") : null,
        } : null,
        people: members.rows.map(member => ({
            user: publicUser(member),
            status: member.status,
            isOwner: member.id === row.owner_id,
            joinedAt: member.joined_at,
            online: member.status === "joined" && showsOnline(member),
        })),
        week: {
            weekStart: row.monday,
            people: weekIds.map(id => ({
                userId: id,
                xp: weekXp[id]?.xp ?? 0,
                // focus XP is one per minute (at most 600 a day)
                focusMin: weekXp[id]?.focusXp ?? 0,
                streak: streaks[id] ?? 0,
            })),
        },
        tasks: tasks.rows.map(task => ({
            id: task.id,
            name: task.name,
            description: task.description,
            done: task.done,
            due: task.due,
            due_time: task.due_time,
            prio: task.prio,
            duration_minutes: task.duration_minutes,
            location: task.location,
            link: task.link,
            details: task.details,
            color: task.color,
            addedBy: task.adder_id ? publicUser(task, "adder_") : null,
            assignee: task.assignee_id ? publicUser(task, "assignee_") : null,
            createdAt: task.created_at,
            groupId: task.group_id,
        })),
        groups,
    };
}

// Who takes care of an entry: `assignee_id` from a request, checked to be a joined member.
// { value } (null: nobody), {} when it wasn't sent, or { error }.
async function familyAssignee(familyId, body) {
    if (body?.assignee_id === undefined) return {};
    if (body.assignee_id === null || body.assignee_id === "") return { value: null };
    const id = idParam(body.assignee_id);
    if (!id) return { error: "assignee_id" };
    const member = await pool.query(
        "SELECT 1 FROM family_members WHERE family_id = $1 AND user_id = $2 AND status = 'joined'",
        [familyId, id]
    );
    return member.rows.length > 0 ? { value: id } : { error: "assignee_id" };
}

async function sendFamily(res, familyId, userId, status = 200) {
    const family = await loadFamily(familyId, userId);
    if (!family) return fail(res, 404, "FAMILY_NOT_FOUND", "Family not found");
    res.status(status).json(family);
}

// My families and the invites waiting for me:
// { families: [{ id, name, owner, isOwner, memberCount }], invites: [{ ...same, invitedBy, invitedAt }] }
app.get(familyBase, async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `SELECT families.id, families.name, families.owner_id, family_members.status, family_members.invited_at,
                families.emoji, families.color,
                owner.username AS owner_username, owner.display_name AS owner_display_name,
                inviter.id AS inviter_id, inviter.username AS inviter_username, inviter.display_name AS inviter_display_name,
                (SELECT count(*) FROM family_members AS m WHERE m.family_id = families.id AND m.status = 'joined')::int AS member_count
            FROM family_members
            JOIN families ON families.id = family_members.family_id
            JOIN users AS owner ON owner.id = families.owner_id
            LEFT JOIN users AS inviter ON inviter.id = family_members.invited_by
            WHERE family_members.user_id = $1
            ORDER BY lower(families.name), families.id`,
            [userId]
        );
        const summary = (row) => ({
            id: row.id,
            name: row.name,
            owner: publicUser(row, "owner_"),
            isOwner: row.owner_id === userId,
            memberCount: row.member_count,
            emoji: row.emoji,
            color: row.color,
        });
        res.json({
            families: result.rows.filter(row => row.status === "joined").map(summary),
            invites: result.rows.filter(row => row.status === "invited").map(row => ({
                ...summary(row),
                invitedBy: row.inviter_id ? publicUser(row, "inviter_") : null,
                invitedAt: row.invited_at,
            })),
        });
    } catch (err) {
        serverError(res, err);
    }
});

// Start a family: { name, friendIds? }
app.post(familyBase, async (req, res) => {
    const userId = req.user.userId;
    const name = familyName(req.body?.name);
    if (!name) return fail(res, 400, "NAME_REQUIRED", "Name is required");
    const friendIds = idList(req.body?.friendIds).filter(id => id !== userId);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // one at a time per account, so two quick requests can't pass the limit together
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
        const mine = await client.query("SELECT count(*)::int AS n FROM family_members WHERE user_id = $1", [userId]);
        if (mine.rows[0].n >= FAMILIES_PER_USER_MAX) {
            await client.query("ROLLBACK");
            return fail(res, 409, "TOO_MANY_FAMILIES", "You are in too many families already");
        }
        const created = await client.query("INSERT INTO families (name, owner_id) VALUES ($1, $2) RETURNING id", [name, userId]);
        const familyId = created.rows[0].id;
        await client.query(
            `INSERT INTO family_members (family_id, user_id, status, invited_by, joined_at)
            VALUES ($1, $2, 'joined', $2, now())`,
            [familyId, userId]
        );
        const invited = await inviteToFamily(client, familyId, userId, friendIds);
        if (invited.error) {
            await client.query("ROLLBACK");
            return fail(res, 400, invited.error, "Too many members");
        }
        await client.query("COMMIT");
        await sendFamily(res, familyId, userId, 201);
        for (const id of invited) realtime.toUser(id, "family:changed", { familyId });
        pushInvite("familyInvite", invited, userId, name);
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        serverError(res, err);
    } finally {
        client.release();
    }
});

app.get(`${familyBase}/:id`, async (req, res) => {
    try {
        const family = await requireFamily(req, res);
        if (!family) return;
        await sendFamily(res, family.familyId, req.user.userId);
    } catch (err) {
        serverError(res, err);
    }
});

// Change it: { name?, emoji?, color? } (owner), { note? } (any member; empty or null clears it).
// Only what is sent changes.
app.patch(`${familyBase}/:id`, async (req, res) => {
    const userId = req.user.userId;
    const body = req.body ?? {};
    const sets = {};
    if ("name" in body) {
        const name = familyName(body.name);
        if (!name) return fail(res, 400, "NAME_REQUIRED", "Name is required");
        sets.name = name;
    }
    if ("emoji" in body) {
        if (body.emoji !== null && !FAMILY_EMOJIS.includes(body.emoji)) return invalidInput(res, "emoji");
        sets.emoji = body.emoji;
    }
    if ("color" in body) {
        if (body.color !== null && !TASK_COLORS.includes(body.color)) return invalidInput(res, "color");
        sets.color = body.color;
    }
    const ownerOnly = Object.keys(sets).length > 0;
    if ("note" in body) {
        const note = cleanText(body.note, FAMILY_NOTE_MAX);
        if (note === undefined) return invalidInput(res, "note");
        sets.note = note;
        sets.note_updated_at = note === null ? null : new Date();
        sets.note_updated_by = note === null ? null : userId;
    }
    if (Object.keys(sets).length === 0) return fail(res, 400, "NOTHING_TO_CHANGE", "Send name, emoji, color or note");
    try {
        const family = await requireFamily(req, res);
        if (!family) return;
        if (ownerOnly && !family.isOwner) return fail(res, 403, "NOT_OWNER", "Only the owner can change the family");
        // the column names come from the code above, never from the request
        const columns = Object.keys(sets);
        await pool.query(
            `UPDATE families SET ${columns.map((column, i) => `${column} = $${i + 2}`).join(", ")} WHERE id = $1`,
            [family.familyId, ...Object.values(sets)]
        );
        await sendFamily(res, family.familyId, userId);
        await notifyFamily(family.familyId);
    } catch (err) {
        serverError(res, err);
    }
});

// Delete it with its calendar and chat (owner)
app.delete(`${familyBase}/:id`, async (req, res) => {
    try {
        const family = await requireFamily(req, res);
        if (!family) return;
        if (!family.isOwner) return fail(res, 403, "NOT_OWNER", "Only the owner can delete the family");
        const people = await familyMemberIds(family.familyId, { invited: true });
        await pool.query("DELETE FROM families WHERE id = $1", [family.familyId]);
        res.json({ id: family.familyId });
        for (const id of people) realtime.toUser(id, "family:changed", { familyId: family.familyId });
    } catch (err) {
        serverError(res, err);
    }
});

// Any member invites their own friends: { userIds }
app.post(`${familyBase}/:id/invites`, async (req, res) => {
    const userId = req.user.userId;
    try {
        const family = await requireFamily(req, res);
        if (!family) return;
        const invited = await inviteToFamily(pool, family.familyId, userId, idList(req.body?.userIds));
        if (invited.error) return fail(res, 400, invited.error, "Too many members");
        if (invited.length === 0) return fail(res, 400, "NOTHING_TO_INVITE", "Nobody new to invite");
        await sendFamily(res, family.familyId, userId);
        await notifyFamily(family.familyId);
        pushInvite("familyInvite", invited, userId, family.name);
    } catch (err) {
        serverError(res, err);
    }
});

// Accept an invite
app.post(`${familyBase}/:id/join`, async (req, res) => {
    const userId = req.user.userId;
    const familyId = idParam(req.params.id);
    if (!familyId) return fail(res, 404, "INVITE_NOT_FOUND", "Invite not found");
    try {
        const result = await pool.query(
            `UPDATE family_members SET status = 'joined', joined_at = now()
            WHERE family_id = $1 AND user_id = $2 AND status = 'invited' RETURNING family_id`,
            [familyId, userId]
        );
        if (result.rows.length === 0) return fail(res, 404, "INVITE_NOT_FOUND", "Invite not found");
        await sendFamily(res, familyId, userId);
        await notifyFamily(familyId);
    } catch (err) {
        serverError(res, err);
    }
});

// Leave or decline (my own id, or "me"), or, as the owner, remove somebody or take back an
// invite. The owner can't leave; they delete the family instead.
app.delete(`${familyBase}/:id/members/:userId`, async (req, res) => {
    const userId = req.user.userId;
    const familyId = idParam(req.params.id);
    const targetId = req.params.userId === "me" ? userId : idParam(req.params.userId);
    if (!familyId || !targetId) return fail(res, 404, "MEMBER_NOT_FOUND", "Member not found");
    try {
        const membership = await getFamilyMembership(familyId, userId);
        // an invite can be declined, but only members can do anything else
        if (!membership || (membership.status !== "joined" && targetId !== userId)) {
            return fail(res, 404, "FAMILY_NOT_FOUND", "Family not found");
        }
        const isOwner = membership.owner_id === userId;
        if (targetId !== userId && !isOwner) return fail(res, 403, "NOT_OWNER", "Only the owner can remove members");
        if (targetId === membership.owner_id) return fail(res, 400, "OWNER_CANNOT_LEAVE", "The owner can't leave the family");
        const result = await pool.query(
            "DELETE FROM family_members WHERE family_id = $1 AND user_id = $2 RETURNING status",
            [familyId, targetId]
        );
        if (result.rows.length === 0) return fail(res, 404, "MEMBER_NOT_FOUND", "Member not found");
        // what they took care of is nobody's again
        await pool.query("UPDATE family_tasks SET assignee_id = NULL WHERE family_id = $1 AND assignee_id = $2", [familyId, targetId]);
        res.json({ familyId, userId: targetId });
        await notifyFamily(familyId, [targetId]);
    } catch (err) {
        serverError(res, err);
    }
});

// A calendar entry (or, without a day, an item on the family's list):
// { name, assignee_id?, group_id? (testers: a sub-group), and any of SHARED_TASK_FIELDS }
app.post(`${familyBase}/:id/tasks`, async (req, res) => {
    const userId = req.user.userId;
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, TASK_NAME_MAX) : "";
    if (!name) return fail(res, 400, "NAME_REQUIRED", "Name is required");
    const fields = readTaskExtras(req.body, SHARED_TASK_FIELDS);
    if (fields.error) return invalidInput(res, fields.error);
    if (fields.values.due_time && !fields.values.due) return invalidInput(res, "due_time");
    try {
        const family = await requireFamily(req, res);
        if (!family) return;
        const assignee = await familyAssignee(family.familyId, req.body);
        if (assignee.error) return invalidInput(res, assignee.error);
        if ("value" in assignee) fields.values.assignee_id = assignee.value;
        const subGroup = await readSubGroup(req, "family", family.familyId);
        if (subGroup.forbidden) return testerRequired(res);
        if (subGroup.error) return invalidInput(res, subGroup.error);
        if ("value" in subGroup) fields.values.group_id = subGroup.value;
        const columns = ["family_id", "name", "added_by", ...Object.keys(fields.values)];
        const values = [family.familyId, name, userId, ...Object.values(fields.values)];
        await pool.query(
            `INSERT INTO family_tasks (${columns.join(", ")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")})`,
            values
        );
        await sendFamily(res, family.familyId, userId, 201);
        await notifyFamily(family.familyId);
    } catch (err) {
        serverError(res, err);
    }
});

// Change an entry: { done?, name?, assignee_id?, group_id? (testers), and any of SHARED_TASK_FIELDS (null clears one) }
app.patch(`${familyBase}/:id/tasks/:taskId`, async (req, res) => {
    const userId = req.user.userId;
    const taskId = idParam(req.params.taskId);
    const { done } = req.body ?? {};
    const name = req.body?.name === undefined ? undefined : cleanText(req.body.name, TASK_NAME_MAX);
    const fields = readTaskExtras(req.body, SHARED_TASK_FIELDS);
    if (done !== undefined && typeof done !== "boolean") return fail(res, 400, "DONE_REQUIRED", "done must be true or false");
    if (name === null || (req.body?.name !== undefined && name === undefined)) return invalidInput(res, "name");
    if (fields.error) return invalidInput(res, fields.error);
    if (done === undefined && name === undefined && Object.keys(fields.values).length === 0 && req.body?.assignee_id === undefined
        && req.body?.group_id === undefined) {
        return fail(res, 400, "NOTHING_TO_CHANGE", "Send done, name or a field");
    }
    try {
        const family = await requireFamily(req, res);
        if (!family) return;
        const assignee = await familyAssignee(family.familyId, req.body);
        if (assignee.error) return invalidInput(res, assignee.error);
        if ("value" in assignee) fields.values.assignee_id = assignee.value;
        const subGroup = await readSubGroup(req, "family", family.familyId);
        if (subGroup.forbidden) return testerRequired(res);
        if (subGroup.error) return invalidInput(res, subGroup.error);
        if ("value" in subGroup) fields.values.group_id = subGroup.value;
        const before = await pool.query("SELECT due FROM family_tasks WHERE id = $1 AND family_id = $2", [taskId, family.familyId]);
        if (before.rows.length === 0) return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
        // a time of day needs a day; taking the day away takes the time along
        const due = "due" in fields.values ? fields.values.due : before.rows[0].due;
        if (fields.values.due_time && !due) return invalidInput(res, "due_time");
        if (!due && !("due_time" in fields.values)) fields.values.due_time = null;

        const values = [taskId, done ?? null, name ?? null];
        const sets = ["done = COALESCE($2, done)", "name = COALESCE($3, name)"];
        for (const [column, value] of Object.entries(fields.values)) {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        }
        await pool.query(`UPDATE family_tasks SET ${sets.join(", ")} WHERE id = $1`, values);
        await sendFamily(res, family.familyId, userId);
        await notifyFamily(family.familyId);
    } catch (err) {
        serverError(res, err);
    }
});

// Remove an entry (whoever added it, or the owner)
app.delete(`${familyBase}/:id/tasks/:taskId`, async (req, res) => {
    const userId = req.user.userId;
    const taskId = idParam(req.params.taskId);
    try {
        const family = await requireFamily(req, res);
        if (!family) return;
        const task = await pool.query("SELECT added_by FROM family_tasks WHERE id = $1 AND family_id = $2", [taskId, family.familyId]);
        if (task.rows.length === 0) return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
        if (task.rows[0].added_by !== userId && !family.isOwner) {
            return fail(res, 403, "NOT_ALLOWED", "Only who added it or the owner can remove it");
        }
        await pool.query("DELETE FROM family_tasks WHERE id = $1", [taskId]);
        await sendFamily(res, family.familyId, userId);
        await notifyFamily(family.familyId);
    } catch (err) {
        serverError(res, err);
    }
});

// The chat, oldest first: the newest FAMILY_MESSAGE_PAGE, or those before ?before=<id>
app.get(`${familyBase}/:id/messages`, async (req, res) => {
    const before = req.query.before === undefined ? null : idParam(req.query.before);
    if (req.query.before !== undefined && !before) return invalidInput(res, "before");
    try {
        const family = await requireFamily(req, res);
        if (!family) return;
        const result = await pool.query(
            `SELECT * FROM (
                SELECT family_messages.id, family_messages.text, family_messages.created_at,
                    users.id AS author_id, users.username AS author_username, users.display_name AS author_display_name
                FROM family_messages JOIN users ON users.id = family_messages.user_id
                WHERE family_messages.family_id = $1 AND ($2::int IS NULL OR family_messages.id < $2)
                ORDER BY family_messages.id DESC
                LIMIT $3
            ) AS latest ORDER BY id`,
            [family.familyId, before, FAMILY_MESSAGE_PAGE]
        );
        res.json({ messages: result.rows.map(toFamilyMessage), hasMore: result.rows.length === FAMILY_MESSAGE_PAGE });
    } catch (err) {
        serverError(res, err);
    }
});

// Write in the chat: { text }; answers with the new message
app.post(`${familyBase}/:id/messages`, messageLimiter, async (req, res) => {
    const userId = req.user.userId;
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return fail(res, 400, "TEXT_REQUIRED", "Message is empty");
    if (text.length > 1000) return fail(res, 400, "TEXT_TOO_LONG", "Message is too long");
    try {
        const family = await requireFamily(req, res);
        if (!family) return;
        const result = await pool.query(
            `WITH created AS (
                INSERT INTO family_messages (family_id, user_id, text) VALUES ($1, $2, $3)
                RETURNING id, text, created_at, user_id
            )
            SELECT created.id, created.text, created.created_at,
                users.id AS author_id, users.username AS author_username, users.display_name AS author_display_name
            FROM created JOIN users ON users.id = created.user_id`,
            [family.familyId, userId, text]
        );
        const message = toFamilyMessage(result.rows[0]);
        res.status(201).json(message);
        for (const id of await familyMemberIds(family.familyId)) {
            realtime.toUser(id, "family:message", { familyId: family.familyId, message });
        }
    } catch (err) {
        serverError(res, err);
    }
});

// ---------- event types ----------
// Each user's own list of what their events are, e.g. "Arbeit", "Vorlesung", "Sport".
// Rows: { id, name, color, position }. The statistics add up past events per type.

const EVENT_TYPE_NAME_MAX = 40;
const EVENT_TYPES_MAX = 30;

const EVENT_TYPE_KEYWORDS_MAX = 20;
const EVENT_TYPE_KEYWORD_MAX = 40;

const toEventType = (row) => ({ id: row.id, name: row.name, color: row.color, position: row.position, keywords: row.keywords ?? [] });

// The words that pick a type by themselves: a list of strings, trimmed, without doubles (case
// doesn't count). undefined when it isn't such a list.
function cleanKeywords(value) {
    if (!Array.isArray(value) || value.length > EVENT_TYPE_KEYWORDS_MAX * 2) return undefined;
    const seen = new Set();
    const keywords = [];
    for (const item of value) {
        if (typeof item !== "string") return undefined;
        const word = item.trim();
        if (!word) continue;
        if (word.length > EVENT_TYPE_KEYWORD_MAX) return undefined;
        if (seen.has(word.toLowerCase())) continue;
        seen.add(word.toLowerCase());
        keywords.push(word);
    }
    return keywords.length > EVENT_TYPE_KEYWORDS_MAX ? undefined : keywords;
}

// The user's other devices load their tasks again (and with them the types)
const eventTypesChanged = (userId) => realtime.toUser(userId, "tasks:changed", {});

app.get("/api/event-types", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, name, color, position, keywords FROM event_types WHERE user_id = $1 ORDER BY position, id",
            [req.user.userId]
        );
        res.json(result.rows.map(toEventType));
    } catch (err) {
        serverError(res, err);
    }
});

// { name, color?, keywords? } -> the new type, at the end of the list
app.post("/api/event-types", async (req, res) => {
    const userId = req.user.userId;
    const name = cleanText(req.body?.name, EVENT_TYPE_NAME_MAX);
    const color = req.body?.color === undefined ? null : TASK_EXTRAS.color(req.body.color);
    const keywords = req.body?.keywords === undefined ? [] : cleanKeywords(req.body.keywords);
    if (!name) return invalidInput(res, "name");
    if (color === undefined) return invalidInput(res, "color");
    if (keywords === undefined) return invalidInput(res, "keywords");
    try {
        const result = await pool.query(
            `INSERT INTO event_types (user_id, name, color, position, keywords)
            SELECT $1, $2, $3, COALESCE(max(position) + 1, 0), $4 FROM event_types WHERE user_id = $1
            HAVING count(*) < ${EVENT_TYPES_MAX}
            ON CONFLICT (user_id, lower(name)) DO NOTHING
            RETURNING id, name, color, position, keywords`,
            [userId, name, color, keywords]
        );
        if (result.rows.length === 0) {
            const count = await pool.query("SELECT count(*)::int AS n FROM event_types WHERE user_id = $1", [userId]);
            return count.rows[0].n >= EVENT_TYPES_MAX
                ? fail(res, 400, "TOO_MANY_EVENT_TYPES", "Too many event types")
                : fail(res, 409, "EVENT_TYPE_EXISTS", "An event type with this name exists");
        }
        res.status(201).json(toEventType(result.rows[0]));
        eventTypesChanged(userId);
    } catch (err) {
        serverError(res, err);
    }
});

// { name?, color?, position?, keywords? }: only what is sent changes
app.put("/api/event-types/:id", async (req, res) => {
    const id = idParam(req.params.id);
    const userId = req.user.userId;
    if (!id) return notFound(res, "Event type");
    const sets = [];
    const values = [id, userId];
    if (req.body?.name !== undefined) {
        const name = cleanText(req.body.name, EVENT_TYPE_NAME_MAX);
        if (!name) return invalidInput(res, "name");
        values.push(name);
        sets.push(`name = $${values.length}`);
    }
    if (req.body?.color !== undefined) {
        const color = TASK_EXTRAS.color(req.body.color);
        if (color === undefined) return invalidInput(res, "color");
        values.push(color);
        sets.push(`color = $${values.length}`);
    }
    if (req.body?.position !== undefined) {
        const position = cleanMinutes(req.body.position, 0, 1000);
        if (position === undefined || position === null) return invalidInput(res, "position");
        values.push(position);
        sets.push(`position = $${values.length}`);
    }
    if (req.body?.keywords !== undefined) {
        const keywords = cleanKeywords(req.body.keywords);
        if (keywords === undefined) return invalidInput(res, "keywords");
        values.push(keywords);
        sets.push(`keywords = $${values.length}`);
    }
    if (sets.length === 0) return invalidInput(res, "name");
    try {
        const result = await pool.query(
            `UPDATE event_types SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING id, name, color, position, keywords`,
            values
        );
        if (result.rows.length === 0) return notFound(res, "Event type");
        res.json(toEventType(result.rows[0]));
        eventTypesChanged(userId);
    } catch (err) {
        if (err.code === "23505") return fail(res, 409, "EVENT_TYPE_EXISTS", "An event type with this name exists");
        serverError(res, err);
    }
});

// The type goes; its events stay, without a type
app.delete("/api/event-types/:id", async (req, res) => {
    const id = idParam(req.params.id);
    const userId = req.user.userId;
    if (!id) return notFound(res, "Event type");
    try {
        const result = await pool.query("DELETE FROM event_types WHERE id = $1 AND user_id = $2", [id, userId]);
        if (result.rowCount === 0) return notFound(res, "Event type");
        res.json({ message: "Event type deleted" });
        eventTypesChanged(userId);
    } catch (err) {
        serverError(res, err);
    }
});

// ---------- statistics for a period ----------
// GET /api/stats?from=YYYY-MM-DD&to=YYYY-MM-DD (both days included, both optional: without
// them everything). Days are the user's own (users.timezone). Only the user's own data:
//   focus:     { ms, sessions, days: [{ day, ms }] }                  solo focus sessions
//   events:    { ms, count, days: [{ day, ms }], types: [{ id, name, color, ms, count }] }
//              past events (time = their duration), per type; id null = without a type
//   groups:    [{ name, color, ms }]  focus per group, the six biggest
//   tasksDone: tasks ticked off in the period (events don't count)
//   firstDay:  the first day with anything at all, to draw "everything" from there
const STATS_DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATS_MAX_DAYS = 3700;

app.get("/api/stats", async (req, res) => {
    const userId = req.user.userId;
    const dayOf = (value) => {
        if (value === undefined || value === "") return null;
        return typeof value === "string" && STATS_DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : undefined;
    };
    const from = dayOf(req.query.from);
    const to = dayOf(req.query.to);
    if (from === undefined) return invalidInput(res, "from");
    if (to === undefined) return invalidInput(res, "to");
    if (from && to && (from > to || Date.parse(to) - Date.parse(from) > STATS_MAX_DAYS * DAY_MS)) return invalidInput(res, "to");

    try {
        const result = await pool.query(
            `WITH me AS (SELECT COALESCE(timezone, 'Europe/Berlin') AS tz FROM users WHERE id = $1),
            focus AS (
                SELECT ((sessions.date AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE me.tz)::date AS day,
                    COALESCE(sessions.time_ms, 0)::bigint AS ms, sessions.group_id
                FROM sessions, me
                WHERE sessions.user_id = $1 AND sessions.date IS NOT NULL
            ),
            focus_in AS (
                SELECT * FROM focus WHERE ($2::date IS NULL OR day >= $2::date) AND ($3::date IS NULL OR day <= $3::date)
            ),
            events AS (
                SELECT tasks.due AS day, COALESCE(tasks.duration_minutes, 0)::bigint * 60000 AS ms, tasks.event_type_id
                FROM tasks
                WHERE tasks.user_id = $1 AND tasks.kind = 'event' AND tasks.done
            ),
            events_in AS (
                SELECT * FROM events WHERE ($2::date IS NULL OR day >= $2::date) AND ($3::date IS NULL OR day <= $3::date)
            )
            SELECT
                (SELECT to_char((now() AT TIME ZONE tz)::date, 'YYYY-MM-DD') FROM me) AS today,
                (SELECT to_char(min(day), 'YYYY-MM-DD') FROM (SELECT day FROM focus UNION ALL SELECT day FROM events) AS all_days) AS first_day,
                (SELECT COALESCE(json_agg(json_build_object('day', to_char(day, 'YYYY-MM-DD'), 'ms', ms, 'n', n) ORDER BY day), '[]')
                    FROM (SELECT day, sum(ms) AS ms, count(*) AS n FROM focus_in GROUP BY day) AS d) AS focus_days,
                (SELECT COALESCE(json_agg(json_build_object('day', to_char(day, 'YYYY-MM-DD'), 'ms', ms, 'n', n) ORDER BY day), '[]')
                    FROM (SELECT day, sum(ms) AS ms, count(*) AS n FROM events_in GROUP BY day) AS d) AS event_days,
                (SELECT COALESCE(json_agg(json_build_object('id', id, 'name', name, 'color', color, 'ms', ms, 'count', n) ORDER BY ms DESC, n DESC), '[]')
                    FROM (SELECT events_in.event_type_id AS id, event_types.name, event_types.color, sum(events_in.ms) AS ms, count(*) AS n
                        FROM events_in LEFT JOIN event_types ON event_types.id = events_in.event_type_id
                        GROUP BY events_in.event_type_id, event_types.name, event_types.color) AS t) AS event_types,
                (SELECT COALESCE(json_agg(json_build_object('name', name, 'color', color, 'ms', ms) ORDER BY ms DESC), '[]')
                    FROM (SELECT groups.name, groups.color, sum(focus_in.ms) AS ms
                        FROM focus_in JOIN groups ON groups.id = focus_in.group_id
                        WHERE focus_in.ms > 0
                        GROUP BY groups.id ORDER BY ms DESC LIMIT 6) AS g) AS groups,
                (SELECT count(*)::int FROM tasks, me
                    WHERE tasks.user_id = $1 AND tasks.kind = 'task' AND tasks.done AND tasks.completed_at IS NOT NULL
                        AND ($2::date IS NULL OR (tasks.completed_at AT TIME ZONE me.tz)::date >= $2::date)
                        AND ($3::date IS NULL OR (tasks.completed_at AT TIME ZONE me.tz)::date <= $3::date)) AS tasks_done`,
            [userId, from, to]
        );
        const row = result.rows[0];
        const days = (list) => list.map(d => ({ day: d.day, ms: Number(d.ms), count: Number(d.n) }));
        const focusDays = days(row.focus_days);
        const eventDays = days(row.event_days);
        const sum = (list, key) => list.reduce((total, d) => total + d[key], 0);
        res.json({
            today: row.today,
            from,
            to,
            firstDay: row.first_day,
            focus: { ms: sum(focusDays, "ms"), sessions: sum(focusDays, "count"), days: focusDays.map(({ day, ms }) => ({ day, ms })) },
            events: {
                ms: sum(eventDays, "ms"),
                count: sum(eventDays, "count"),
                days: eventDays.map(({ day, ms }) => ({ day, ms })),
                types: row.event_types.map(type => ({ id: type.id, name: type.name, color: type.color, ms: Number(type.ms), count: Number(type.count) })),
            },
            groups: row.groups.map(group => ({ name: group.name, color: group.color, ms: Number(group.ms) })),
            tasksDone: row.tasks_done,
        });
    } catch (err) {
        serverError(res, err);
    }
});

// ---------- Progress: XP, levels, challenges ----------
// Worked out from the numbers on every look (utils/progress.js); reaching a challenge or a level
// is written once and posted to the feed of my friends (unless I switched sharing off).

// My friends and I load the feed again (sent when an entry of mine came or changed)
async function announceFeed(userId) {
    try {
        const result = await pool.query(friendIdsOf("$1::int"), [userId]);
        realtime.toUser(userId, "feed:changed", {});
        for (const row of result.rows) realtime.toUser(Object.values(row)[0], "feed:changed", {});
    } catch (err) {
        console.error(err);
    }
}

// My level, XP and today's and this week's challenges (completing what is reached)
app.get("/api/progress", async (req, res) => {
    try {
        res.json(await progress.evaluateProgress(pool, req.user.userId, announceFeed));
    } catch (err) {
        serverError(res, err);
    }
});

// This week among friends: XP since Monday (and the current streak) of me and the friends who
// show their statistics, most first
app.get("/api/progress/friends", async (req, res) => {
    const me = req.user.userId;
    try {
        const people = await pool.query(
            `SELECT id, username, display_name, avatar_emoji, profile_color, level, show_online,
                to_char(date_trunc('week', now() AT TIME ZONE COALESCE((SELECT timezone FROM users WHERE id = $1), 'Europe/Berlin')), 'YYYY-MM-DD') AS monday
            FROM users WHERE id = $1 OR (show_stats AND id IN (${friendIdsOf("$1::int")}))`,
            [me]
        );
        const monday = people.rows.find(row => row.id === me)?.monday ?? null;
        const ids = people.rows.map(row => row.id);
        const [xp, streaks] = await Promise.all([progress.loadXp(pool, ids, monday), progress.loadStreaks(pool, ids)]);
        const ranking = people.rows
            .map(row => ({
                user: { ...publicUser(row), emoji: row.avatar_emoji, color: row.profile_color, level: row.level },
                weekXp: xp[row.id]?.xp ?? 0,
                // days with focus in a row, and whether they have the app open (not for me)
                streak: streaks[row.id] ?? 0,
                ...(row.id === me ? {} : { online: showsOnline(row) }),
                me: row.id === me,
            }))
            .sort((a, b) => b.weekXp - a.weekXp || a.user.username.localeCompare(b.user.username));
        res.json({ weekStart: monday, ranking });
    } catch (err) {
        serverError(res, err);
    }
});

// ---------- Feed ----------
// What my friends and I did: a day's focus, challenges, levels, streaks, and short posts. Only
// friends see it; automatic entries only while their owner shares them (share_activity).
// Anybody can cheer a friend's entry on, once.

const FEED_PAGE = 30;
const FEED_POST_MAX = 280;

const feedPostLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: limitFromEnv("RATE_LIMIT_FEED_POST", 20),
    skip: (req) => req.method === "OPTIONS",
    keyGenerator: (req) => `user:${req.user.userId}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many posts, please slow down", code: "RATE_LIMITED" },
});

// Feed entries `me` may see, newest (last changed) first. One entry by id, or a page before a cursor.
async function loadFeed(me, { id = null, before = null, limit = FEED_PAGE } = {}) {
    const result = await pool.query(
        `SELECT e.id, e.kind, to_char(e.day, 'YYYY-MM-DD') AS day, e.data, e.created_at, e.updated_at,
            to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at, e.user_id,
            u.username, u.display_name, u.avatar_emoji, u.profile_color, u.level, u.avatar_frame,
            (SELECT count(*)::int FROM feed_cheers WHERE event_id = e.id) AS cheers,
            EXISTS (SELECT 1 FROM feed_cheers WHERE event_id = e.id AND user_id = $1) AS cheered,
            -- who cheered: only on my own entries (they are all my friends)
            CASE WHEN e.user_id = $1 THEN (
                SELECT COALESCE(json_agg(json_build_object('id', cu.id, 'username', cu.username, 'displayName', cu.display_name)), '[]')
                FROM (SELECT user_id FROM feed_cheers WHERE event_id = e.id ORDER BY created_at DESC LIMIT 3) AS c
                JOIN users AS cu ON cu.id = c.user_id) END AS cheerers
        FROM feed_events AS e JOIN users AS u ON u.id = e.user_id
        WHERE (e.user_id = $1 OR e.user_id IN (${friendIdsOf("$1::int")}))
            AND NOT (e.data ? 'hidden')
            AND (e.kind = 'post' OR e.user_id = $1 OR u.share_activity)
            AND ($2::int IS NULL OR e.id = $2)
            AND ($3::timestamptz IS NULL OR (e.updated_at, e.id) < ($3::timestamptz, $4::int))
        ORDER BY e.updated_at DESC, e.id DESC
        LIMIT $5`,
        [me, id, before?.at ?? null, before?.id ?? null, limit + 1]
    );
    const rows = result.rows.slice(0, limit);
    return {
        entries: rows.map(row => ({
            id: row.id,
            kind: row.kind,
            day: row.day,
            data: row.data,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            user: {
                ...publicUser({ id: row.user_id, username: row.username, display_name: row.display_name }),
                emoji: row.avatar_emoji, color: row.profile_color, level: row.level, frame: row.avatar_frame,
            },
            mine: row.user_id === me,
            cheers: row.cheers,
            cheered: row.cheered,
            ...(row.cheerers ? { cheerers: row.cheerers } : {}),
        })),
        next: result.rows.length > limit ? `${rows.at(-1).cursor_at}|${rows.at(-1).id}` : null,
    };
}

// A page of the feed: ?before=<next of the page before>
app.get("/api/feed", async (req, res) => {
    let before = null;
    if (req.query.before !== undefined) {
        const [at, id] = String(req.query.before).split("|");
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at ?? "") || !idParam(id)) return invalidInput(res, "before");
        before = { at, id: idParam(id) };
    }
    try {
        res.json(await loadFeed(req.user.userId, { before }));
    } catch (err) {
        serverError(res, err);
    }
});

// A short post for my friends: { text } (up to 280 characters)
app.post("/api/feed/posts", feedPostLimiter, async (req, res) => {
    const text = cleanText(req.body?.text, FEED_POST_MAX);
    if (!text) return invalidInput(res, "text");
    try {
        const result = await pool.query(
            "INSERT INTO feed_events (user_id, kind, data) VALUES ($1, 'post', $2) RETURNING id",
            [req.user.userId, { text }]
        );
        const { entries } = await loadFeed(req.user.userId, { id: result.rows[0].id });
        announceFeed(req.user.userId);
        res.status(201).json(entries[0]);
    } catch (err) {
        serverError(res, err);
    }
});

// Take one of my entries out of the feed. Today's focus entry stays out even as the day goes on.
app.delete("/api/feed/:id", async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return fail(res, 404, "FEED_ENTRY_NOT_FOUND", "Feed entry not found");
    try {
        const hidden = await pool.query(
            `UPDATE feed_events SET data = data || '{"hidden": true}' WHERE id = $1 AND user_id = $2 AND kind = 'day' RETURNING id`,
            [id, req.user.userId]
        );
        const deleted = hidden.rowCount > 0 ? hidden
            : await pool.query("DELETE FROM feed_events WHERE id = $1 AND user_id = $2 RETURNING id", [id, req.user.userId]);
        if (deleted.rowCount === 0) return fail(res, 404, "FEED_ENTRY_NOT_FOUND", "Feed entry not found");
        announceFeed(req.user.userId);
        res.status(204).end();
    } catch (err) {
        serverError(res, err);
    }
});

// Cheer a friend's entry on (PUT) or take it back (DELETE); answers { cheers, cheered }
async function setCheer(req, res, on) {
    const me = req.user.userId;
    const id = idParam(req.params.id);
    if (!id) return fail(res, 404, "FEED_ENTRY_NOT_FOUND", "Feed entry not found");
    try {
        const { entries } = await loadFeed(me, { id });
        const entry = entries[0];
        if (!entry) return fail(res, 404, "FEED_ENTRY_NOT_FOUND", "Feed entry not found");
        if (entry.mine) return fail(res, 400, "OWN_FEED_ENTRY", "You can't cheer on your own entry");
        const changed = on
            ? await pool.query("INSERT INTO feed_cheers (event_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, me])
            : await pool.query("DELETE FROM feed_cheers WHERE event_id = $1 AND user_id = $2", [id, me]);
        if (changed.rowCount > 0) {
            realtime.toUser(entry.user.id, "feed:changed", {});
            if (on) {
                const who = await pool.query("SELECT id, username, display_name FROM users WHERE id = $1", [me]);
                realtime.toUser(entry.user.id, "feed:cheered", { user: publicUser(who.rows[0]), entryId: id });
            }
        }
        const count = await pool.query("SELECT count(*)::int AS n FROM feed_cheers WHERE event_id = $1", [id]);
        res.json({ cheers: count.rows[0].n, cheered: on });
    } catch (err) {
        serverError(res, err);
    }
}
app.put("/api/feed/:id/cheer", (req, res) => setCheer(req, res, true));
app.delete("/api/feed/:id/cheer", (req, res) => setCheer(req, res, false));

// ---------- Push notifications ----------
// A device (browser) turns them on in the app's settings: it asks its push service for an
// address and hands it over here with its keys (see utils/push.js). One row per device; the
// account signed in there last owns it. Kinds per device: plan, digest, messages, social.

// Who did something, for the text of a push: { id, username, displayName }
async function pushSender(userId) {
    const result = await pool.query("SELECT id, username, display_name FROM users WHERE id = $1", [userId]);
    const user = result.rows[0];
    return user ? { id: user.id, username: user.username, displayName: user.display_name } : null;
}

// A "social" push to the people somebody just asked or invited; `name` is the session's,
// family's or task's. Fire and forget, like the realtime signals.
function pushInvite(text, userIds, fromId, name) {
    if (userIds.length === 0) return;
    pushSender(fromId)
        .then((from) => from && pushLater(pool, userIds, "social", (language) => PUSH_TEXTS[text]({ from, name }, language)))
        .catch((err) => console.error(err));
}

const PUSH_ENDPOINT_MAX = 1000;
const validEndpoint = (value) => typeof value === "string" && value.length <= PUSH_ENDPOINT_MAX && /^https:\/\/[^\s]+$/.test(value);
const validPushKey = (value, max) => typeof value === "string" && value.length >= 1 && value.length <= max && /^[A-Za-z0-9_=-]+$/.test(value);
const pushKindsJson = (row) => Object.fromEntries(PUSH_KINDS.map(kind => [kind, row[kind]]));

// The server's public key, which the browser needs to sign up; null: this server sends no pushes
app.get("/api/push/key", (req, res) => {
    res.json({ publicKey: PUSH_PUBLIC_KEY || null });
});

// This device wants pushes (again): { endpoint, keys: { p256dh, auth }, kinds?: { plan, digest, messages, social } }.
// Also called on every start of the app, so a renewed address or another account on the device
// is picked up. Kinds not sent stay as they were (all on for a new device). Answers { kinds }.
app.put("/api/push/subscription", async (req, res) => {
    const userId = req.user.userId;
    const { endpoint, keys, kinds } = req.body ?? {};
    if (!validEndpoint(endpoint)) return invalidInput(res, "endpoint");
    if (!validPushKey(keys?.p256dh, 200) || !validPushKey(keys?.auth, 100)) return invalidInput(res, "keys");
    if (kinds !== undefined && (typeof kinds !== "object" || kinds === null || Object.entries(kinds).some(([kind, on]) => !PUSH_KINDS.includes(kind) || typeof on !== "boolean"))) {
        return invalidInput(res, "kinds");
    }
    const wanted = PUSH_KINDS.map(kind => kinds?.[kind] ?? null);
    try {
        const saved = await pool.query(
            `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, plan, digest, messages, social)
            VALUES ($1, $2, $3, $4, COALESCE($5, true), COALESCE($6, true), COALESCE($7, true), COALESCE($8, true))
            ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                plan = COALESCE($5, push_subscriptions.plan), digest = COALESCE($6, push_subscriptions.digest),
                messages = COALESCE($7, push_subscriptions.messages), social = COALESCE($8, push_subscriptions.social),
                updated_at = now()
            RETURNING ${PUSH_KINDS.join(", ")}`,
            [userId, endpoint, keys.p256dh, keys.auth, ...wanted]
        );
        // a few devices per account: the ones not seen for the longest go
        await pool.query(
            `DELETE FROM push_subscriptions WHERE user_id = $1 AND id NOT IN (
                SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2)`,
            [userId, PUSH_MAX_DEVICES]
        );
        res.json({ kinds: pushKindsJson(saved.rows[0]) });
    } catch (err) {
        serverError(res, err);
    }
});

// This device turns them off (or signs out): { endpoint }. Answers the same when it wasn't there.
app.delete("/api/push/subscription", async (req, res) => {
    const endpoint = req.body?.endpoint;
    if (!validEndpoint(endpoint)) return invalidInput(res, "endpoint");
    try {
        await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2", [endpoint, req.user.userId]);
        res.json({ subscribed: false });
    } catch (err) {
        serverError(res, err);
    }
});

// A test notification to this device: { endpoint }. 404 when it isn't signed up (any more).
const pushTestLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    keyGenerator: (req) => `user:${req.user.userId}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later", code: "RATE_LIMITED" },
});

app.post("/api/push/test", pushTestLimiter, async (req, res) => {
    const endpoint = req.body?.endpoint;
    if (!validEndpoint(endpoint)) return invalidInput(res, "endpoint");
    try {
        const result = await pool.query(
            `SELECT push_subscriptions.id, push_subscriptions.user_id, push_subscriptions.endpoint, push_subscriptions.p256dh,
                push_subscriptions.auth, users.language
            FROM push_subscriptions JOIN users ON users.id = push_subscriptions.user_id
            WHERE push_subscriptions.endpoint = $1 AND push_subscriptions.user_id = $2`,
            [endpoint, req.user.userId]
        );
        const device = result.rows[0];
        if (!device) return res.status(404).json({ error: "This device is not signed up", code: "NOT_SUBSCRIBED" });
        const en = device.language === "en";
        const sent = await deliver(pool, device, "plan", {
            title: "Quidey",
            body: en ? "Notifications work on this device." : "Benachrichtigungen kommen auf diesem Gerät an.",
            url: "/settings#app",
            tag: "test",
        });
        if (!sent) return res.status(502).json({ error: "The push service refused it", code: "PUSH_FAILED" });
        res.json({ sent: true });
    } catch (err) {
        serverError(res, err);
    }
});

// ---------- Fokusraum: the alarm at the end of a countdown ----------
// The app sets it on start: { endsAt (ISO time), phase: 'timer' | 'focus' | 'short' | 'long' };
// the server pushes then (utils/focus.js). Pause and stop take it away. One per account.
const FOCUS_PHASES = ["timer", "focus", "short", "long"];
const FOCUS_ALARM_MAX_AHEAD = 6 * 60 * 60 * 1000;

app.put("/api/focus/alarm", async (req, res) => {
    const { endsAt, phase } = req.body ?? {};
    const at = typeof endsAt === "string" && endsAt.length <= 40 ? Date.parse(endsAt) : NaN;
    if (Number.isNaN(at) || at < Date.now() - 60 * 1000 || at > Date.now() + FOCUS_ALARM_MAX_AHEAD) return invalidInput(res, "endsAt");
    if (!FOCUS_PHASES.includes(phase)) return invalidInput(res, "phase");
    try {
        await pool.query(
            `INSERT INTO focus_alarms (user_id, fire_at, phase) VALUES ($1, $2, $3)
            ON CONFLICT (user_id) DO UPDATE SET fire_at = EXCLUDED.fire_at, phase = EXCLUDED.phase`,
            [req.user.userId, new Date(at).toISOString(), phase]
        );
        res.json({ endsAt: new Date(at).toISOString(), phase });
    } catch (err) {
        serverError(res, err);
    }
});

app.delete("/api/focus/alarm", async (req, res) => {
    try {
        await pool.query("DELETE FROM focus_alarms WHERE user_id = $1", [req.user.userId]);
        res.json({ alarm: null });
    } catch (err) {
        serverError(res, err);
    }
});

// ---------- Routines ----------
// A routine: { name, emoji?, steps: [{ title, minutes }], days: [1..7] (Monday = 1), atTime:
// "HH:MM" | null, remind }. The app guides through the steps; a finished (or ended) run is
// booked with POST /api/routines/:id/runs. Planned ones are pushed at their time (utils/focus.js).
const ROUTINE_MAX = 50;
const ROUTINE_STEPS_MAX = 30;
const ROUTINE_NAME_MAX = 60;
const ROUTINE_STEP_MAX = 80;

function cleanRoutine(body, partial) {
    const out = {};
    if (!partial || body.name !== undefined) {
        const name = cleanText(body.name, ROUTINE_NAME_MAX);
        if (!name) return { field: "name" };
        out.name = name;
    }
    if (body.emoji !== undefined) {
        const emoji = cleanText(body.emoji, 8);
        if (emoji === undefined) return { field: "emoji" };
        out.emoji = emoji;
    }
    if (!partial || body.steps !== undefined) {
        const steps = body.steps;
        if (!Array.isArray(steps) || steps.length < 1 || steps.length > ROUTINE_STEPS_MAX) return { field: "steps" };
        const clean = [];
        for (const step of steps) {
            const title = cleanText(step?.title, ROUTINE_STEP_MAX);
            const minutes = Number(step?.minutes ?? 0);
            if (!title || !Number.isInteger(minutes) || minutes < 0 || minutes > 240) return { field: "steps" };
            clean.push({ title, minutes });
        }
        out.steps = JSON.stringify(clean);
    }
    if (body.days !== undefined) {
        const days = body.days;
        if (!Array.isArray(days) || days.length > 7 || days.some(day => !Number.isInteger(day) || day < 1 || day > 7)) return { field: "days" };
        out.days = [...new Set(days)].sort();
    }
    if (body.atTime !== undefined) {
        if (body.atTime !== null && (typeof body.atTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.atTime))) return { field: "atTime" };
        out.at_time = body.atTime;
    }
    if (body.remind !== undefined) {
        if (typeof body.remind !== "boolean") return { field: "remind" };
        out.remind = body.remind;
    }
    return { values: out };
}

// how a routine is answered; the runs (routine_runs) as lastRunAt, doneToday (in my time zone)
// and runsThisWeek (the last 7 days)
const ROUTINE_SELECT = `
    SELECT routines.*, to_char(routines.at_time, 'HH24:MI') AS at_time_text,
        runs.last_run_at, runs.done_today, runs.runs_week
    FROM routines
    JOIN users ON users.id = routines.user_id
    LEFT JOIN LATERAL (
        SELECT max(finished_at) AS last_run_at,
            bool_or((finished_at AT TIME ZONE COALESCE(users.timezone, 'Europe/Berlin'))::date = (now() AT TIME ZONE COALESCE(users.timezone, 'Europe/Berlin'))::date) AS done_today,
            count(*) FILTER (WHERE finished_at > now() - interval '7 days')::int AS runs_week
        FROM routine_runs WHERE routine_runs.routine_id = routines.id
    ) AS runs ON true`;

const routineJson = (row) => ({
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    steps: row.steps,
    days: row.days ?? [],
    atTime: row.at_time_text ?? null,
    remind: row.remind,
    lastRunAt: row.last_run_at ?? null,
    doneToday: Boolean(row.done_today),
    runsThisWeek: row.runs_week ?? 0,
});

async function loadRoutine(id, userId) {
    const result = await pool.query(`${ROUTINE_SELECT} WHERE routines.id = $1 AND routines.user_id = $2`, [id, userId]);
    return result.rows[0] ? routineJson(result.rows[0]) : null;
}

app.get("/api/routines", async (req, res) => {
    try {
        const result = await pool.query(`${ROUTINE_SELECT} WHERE routines.user_id = $1 ORDER BY routines.at_time NULLS LAST, routines.id`, [req.user.userId]);
        res.json(result.rows.map(routineJson));
    } catch (err) {
        serverError(res, err);
    }
});

app.post("/api/routines", async (req, res) => {
    const { field, values } = cleanRoutine(req.body ?? {}, false);
    if (field) return invalidInput(res, field);
    try {
        const count = await pool.query("SELECT count(*)::int AS n FROM routines WHERE user_id = $1", [req.user.userId]);
        if (count.rows[0].n >= ROUTINE_MAX) return res.status(409).json({ error: "Too many routines", code: "ROUTINE_LIMIT" });
        const saved = await pool.query(
            `INSERT INTO routines (user_id, name, emoji, steps, days, at_time, remind)
            VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::smallint[], '{}'), $6, COALESCE($7, true)) RETURNING id`,
            [req.user.userId, values.name, values.emoji ?? null, values.steps, values.days ?? null, values.at_time ?? null, values.remind ?? null]
        );
        res.status(201).json(await loadRoutine(saved.rows[0].id, req.user.userId));
    } catch (err) {
        serverError(res, err);
    }
});

app.put("/api/routines/:id", async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return notFound(res, "Routine");
    const { field, values } = cleanRoutine(req.body ?? {}, true);
    if (field) return invalidInput(res, field);
    const columns = Object.keys(values);
    try {
        if (columns.length > 0) {
            const sets = columns.map((column, i) => `${column} = $${i + 3}${column === "steps" ? "::jsonb" : ""}`);
            // a changed plan may remind again today
            if (values.at_time !== undefined || values.days !== undefined) sets.push("reminded_on = NULL");
            const result = await pool.query(
                `UPDATE routines SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id`,
                [id, req.user.userId, ...columns.map(column => values[column])]
            );
            if (result.rows.length === 0) return notFound(res, "Routine");
        }
        const routine = await loadRoutine(id, req.user.userId);
        if (!routine) return notFound(res, "Routine");
        res.json(routine);
    } catch (err) {
        serverError(res, err);
    }
});

app.delete("/api/routines/:id", async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return notFound(res, "Routine");
    try {
        const result = await pool.query("DELETE FROM routines WHERE id = $1 AND user_id = $2 RETURNING id", [id, req.user.userId]);
        if (result.rows.length === 0) return notFound(res, "Routine");
        res.json({ deleted: id });
    } catch (err) {
        serverError(res, err);
    }
});

// A run through it: { startedAt, stepsDone, stepsTotal, seconds }
app.post("/api/routines/:id/runs", async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return notFound(res, "Routine");
    const { startedAt, stepsDone, stepsTotal, seconds } = req.body ?? {};
    const started = typeof startedAt === "string" && startedAt.length <= 40 ? Date.parse(startedAt) : NaN;
    if (Number.isNaN(started) || started > Date.now() + 60 * 1000 || started < Date.now() - 24 * 60 * 60 * 1000) return invalidInput(res, "startedAt");
    if (!Number.isInteger(stepsTotal) || stepsTotal < 1 || stepsTotal > ROUTINE_STEPS_MAX) return invalidInput(res, "stepsTotal");
    if (!Number.isInteger(stepsDone) || stepsDone < 0 || stepsDone > stepsTotal) return invalidInput(res, "stepsDone");
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 24 * 60 * 60) return invalidInput(res, "seconds");
    try {
        const result = await pool.query(
            `INSERT INTO routine_runs (routine_id, user_id, started_at, steps_done, steps_total, seconds)
            SELECT id, user_id, $3, $4, $5, $6 FROM routines WHERE id = $1 AND user_id = $2
            RETURNING id`,
            [id, req.user.userId, new Date(started).toISOString(), stepsDone, stepsTotal, seconds]
        );
        if (result.rows.length === 0) return notFound(res, "Routine");
        res.status(201).json(await loadRoutine(id, req.user.userId));
    } catch (err) {
        serverError(res, err);
    }
});

// ---------- Notebook (Fokusraum) ----------
// Notes of my own, on their own or about a task: { title, body, taskId?, pinned, attachments }.
// attachments: [{ kind: 'link', url, title? } | { kind: 'image', data: 'data:image/…;base64,…', name? }]
// (pictures made small by the app). The list leaves the pictures' data out (GET one note for it).
const NOTEBOOK_MAX = 300;
const NOTEBOOK_TITLE_MAX = 120;
const NOTEBOOK_BODY_MAX = 20000;
const NOTEBOOK_ATTACHMENTS_MAX = 10;
const NOTEBOOK_IMAGES_MAX = 4;
const NOTEBOOK_IMAGE_MAX = 400 * 1024;
const IMAGE_DATA = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const LINK_URL = /^https?:\/\/[^\s]+$/i;

function cleanAttachments(list) {
    if (!Array.isArray(list) || list.length > NOTEBOOK_ATTACHMENTS_MAX) return undefined;
    const clean = [];
    for (const item of list) {
        if (item?.kind === "link") {
            if (typeof item.url !== "string" || item.url.length > 2000 || !LINK_URL.test(item.url)) return undefined;
            const title = cleanText(item.title, 120);
            if (title === undefined) return undefined;
            clean.push({ kind: "link", url: item.url, ...(title ? { title } : {}) });
        } else if (item?.kind === "image") {
            if (typeof item.data !== "string" || item.data.length > NOTEBOOK_IMAGE_MAX || !IMAGE_DATA.test(item.data)) return undefined;
            const name = cleanText(item.name, 120);
            if (name === undefined) return undefined;
            clean.push({ kind: "image", data: item.data, ...(name ? { name } : {}) });
        } else {
            return undefined;
        }
    }
    if (clean.filter(item => item.kind === "image").length > NOTEBOOK_IMAGES_MAX) return undefined;
    return clean;
}

function cleanNote(body, partial) {
    const out = {};
    if (!partial || body.title !== undefined) {
        const title = cleanText(body.title ?? "", NOTEBOOK_TITLE_MAX);
        if (title === undefined) return { field: "title" };
        out.title = title ?? "";
    }
    if (!partial || body.body !== undefined) {
        if (body.body !== undefined && body.body !== null && (typeof body.body !== "string" || body.body.length > NOTEBOOK_BODY_MAX)) return { field: "body" };
        out.body = body.body ?? "";
    }
    if (body.pinned !== undefined) {
        if (typeof body.pinned !== "boolean") return { field: "pinned" };
        out.pinned = body.pinned;
    }
    if (body.taskId !== undefined) {
        if (body.taskId !== null && !idParam(body.taskId)) return { field: "taskId" };
        out.task_id = body.taskId === null ? null : idParam(body.taskId);
    }
    if (body.attachments !== undefined) {
        const attachments = cleanAttachments(body.attachments);
        if (!attachments) return { field: "attachments" };
        out.attachments = JSON.stringify(attachments);
    }
    if (!partial && !out.title && !out.body.trim() && !(body.attachments?.length)) return { field: "body" };
    return { values: out };
}

// full: with the pictures' data; otherwise only that they are there
const noteJson = (row, full) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    taskId: row.task_id,
    pinned: row.pinned,
    attachments: full ? row.attachments : row.attachments.map(item => item.kind === "image" ? { kind: "image", name: item.name ?? null } : item),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

// a task the note is about must be one I can see
async function taskVisible(taskId, userId) {
    if (!taskId) return true;
    const check = await pool.query(`SELECT 1 FROM (${accessibleTaskIds("$2")}) AS mine WHERE id = $1`, [taskId, userId]);
    return check.rows.length > 0;
}

app.get("/api/notebook", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM notebook_notes WHERE user_id = $1 ORDER BY pinned DESC, updated_at DESC",
            [req.user.userId]
        );
        res.json(result.rows.map(row => noteJson(row, false)));
    } catch (err) {
        serverError(res, err);
    }
});

app.get("/api/notebook/:id", async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return notFound(res, "Note");
    try {
        const result = await pool.query("SELECT * FROM notebook_notes WHERE id = $1 AND user_id = $2", [id, req.user.userId]);
        if (result.rows.length === 0) return notFound(res, "Note");
        res.json(noteJson(result.rows[0], true));
    } catch (err) {
        serverError(res, err);
    }
});

app.post("/api/notebook", async (req, res) => {
    const { field, values } = cleanNote(req.body ?? {}, false);
    if (field) return invalidInput(res, field);
    try {
        if (!await taskVisible(values.task_id, req.user.userId)) return notFound(res, "Task");
        const count = await pool.query("SELECT count(*)::int AS n FROM notebook_notes WHERE user_id = $1", [req.user.userId]);
        if (count.rows[0].n >= NOTEBOOK_MAX) return res.status(409).json({ error: "Too many notes", code: "NOTEBOOK_LIMIT" });
        const saved = await pool.query(
            `INSERT INTO notebook_notes (user_id, task_id, title, body, pinned, attachments)
            VALUES ($1, $2, $3, $4, COALESCE($5, false), COALESCE($6::jsonb, '[]'::jsonb)) RETURNING *`,
            [req.user.userId, values.task_id ?? null, values.title, values.body, values.pinned ?? null, values.attachments ?? null]
        );
        res.status(201).json(noteJson(saved.rows[0], true));
    } catch (err) {
        serverError(res, err);
    }
});

app.put("/api/notebook/:id", async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return notFound(res, "Note");
    const { field, values } = cleanNote(req.body ?? {}, true);
    if (field) return invalidInput(res, field);
    const columns = Object.keys(values);
    try {
        if (!await taskVisible(values.task_id, req.user.userId)) return notFound(res, "Task");
        const sets = columns.map((column, i) => `${column} = $${i + 3}${column === "attachments" ? "::jsonb" : ""}`);
        const result = await pool.query(
            `UPDATE notebook_notes SET ${[...sets, "updated_at = now()"].join(", ")} WHERE id = $1 AND user_id = $2 RETURNING *`,
            [id, req.user.userId, ...columns.map(column => values[column])]
        );
        if (result.rows.length === 0) return notFound(res, "Note");
        res.json(noteJson(result.rows[0], true));
    } catch (err) {
        serverError(res, err);
    }
});

app.delete("/api/notebook/:id", async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return notFound(res, "Note");
    try {
        const result = await pool.query("DELETE FROM notebook_notes WHERE id = $1 AND user_id = $2 RETURNING id", [id, req.user.userId]);
        if (result.rows.length === 0) return notFound(res, "Note");
        res.json({ deleted: id });
    } catch (err) {
        serverError(res, err);
    }
});

// Unknown routes, and errors no route handled (e.g. invalid JSON): short JSON answers,
// never Express's HTML page with a stack trace
app.use((req, res) => res.status(404).json({ error: "Not found" }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON", code: "INVALID_JSON" });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Request too large", code: "TOO_LARGE" });
    serverError(res, err);
});

// net start postgresql-x64-18

//listen for requests on this url; Socket.IO (realtime.js) shares the same server and port
const server = http.createServer(app);
realtime.initRealtime(server, { allowedOrigins, tokenAlgorithm: TOKEN_ALGORITHM });
// reminders by mail, checked once a minute
startReminderMails(pool, limitFromEnv("REMINDER_CHECK_MS", 60 * 1000));
// push notifications for tasks and events at their time, and the morning overview
startPushSchedule(pool, limitFromEnv("REMINDER_CHECK_MS", 60 * 1000));
// the end of a countdown (Fokusraum) and planned routines, every few seconds
startFocusSchedule(pool, limitFromEnv("FOCUS_CHECK_MS", 5 * 1000));
// events that are over are ticked off, also checked once a minute (first right away)
closePastEvents();
setInterval(closePastEvents, limitFromEnv("EVENT_CHECK_MS", 60 * 1000)).unref();
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});