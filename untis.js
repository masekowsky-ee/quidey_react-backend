// The timetable from WebUntis in the calendar (branch pro-features, later Quidey Pro).
// Mounted at /api/untis, behind authenticateToken + requirePro. utils/untis.js talks to WebUntis.
//
//   GET    /api/untis              → { available, connected, mode?, schoolLabel?, username?, lastSyncAt?, lastError? }
//   GET    /api/untis/schools?q=   → [{ server, school, label, address }] (the Untis school search)
//   PUT    /api/untis { mode: 'login', server, school, schoolLabel, username, password }
//                     | { mode: 'ical', url }      → signs in / reads once, stores (encrypted), fetches
//   DELETE /api/untis              → the login and every lesson gone (204)
//   POST   /api/untis/sync         → fetch again now (at most once a minute)
//   GET    /api/untis/lessons?from=&to= (≤ 62 days) → { lessons: [{ id, day, start, end, subject,
//          subjectLong, room, className, status, info }], lastSyncAt } — fetched again first when the
//          last fetch is older than 15 minutes, so the calendar is live while it's used.
// What is fetched: the last week and the next three weeks.

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const untis = require("./utils/untis");

const FRESH_MS = 15 * 60 * 1000;
const MANUAL_GAP_MS = 60 * 1000;
const RANGE_MAX_DAYS = 62;
const DAYS_BACK = 7;
const DAYS_AHEAD = 21;

const fail = (res, status, code, field) => res.status(status).json({ error: code, code, ...(field ? { field } : {}) });
const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

function untisFailure(res, err) {
    if (!(err instanceof untis.UntisError)) throw err;
    const status = err.code === "UNTIS_UNAVAILABLE" ? 503 : err.code === "UNTIS_LOGIN_FAILED" || err.code === "UNTIS_NOT_ALLOWED" ? 400 : 502;
    return fail(res, status, err.code);
}

module.exports = function untisRouter({ pool }) {
    const router = express.Router();
    const syncing = new Map();

    const schoolSearch = rateLimit({
        windowMs: 60 * 1000, limit: 30, keyGenerator: (req) => String(req.user.userId),
        standardHeaders: false, legacyHeaders: false,
        message: { error: "Too many searches", code: "RATE_LIMITED" },
    });

    async function account(userId) {
        return (await pool.query("SELECT * FROM untis_accounts WHERE user_id = $1", [userId])).rows[0] ?? null;
    }

    function status(row) {
        if (!row) return { available: untis.canStorePasswords(), connected: false };
        return {
            available: untis.canStorePasswords(), connected: true, mode: row.mode,
            schoolLabel: row.school_label, username: row.username,
            lastSyncAt: row.last_sync_at, lastError: row.last_error, homeworkToTasks: row.homework_to_tasks,
        };
    }

    // the range to fetch, in the account's own days
    async function range(userId) {
        const { rows: [r] } = await pool.query(
            `SELECT to_char(d - $2::int, 'YYYY-MM-DD') AS "from", to_char(d + $3::int, 'YYYY-MM-DD') AS "to", tz
            FROM (SELECT (now() AT TIME ZONE COALESCE(timezone, 'Europe/Berlin'))::date AS d, COALESCE(timezone, 'Europe/Berlin') AS tz
                  FROM users WHERE id = $1) AS today`, [userId, DAYS_BACK, DAYS_AHEAD]);
        return r;
    }

    async function fetchFor(row, userId) {
        const { from, to, tz } = await range(userId);
        const secret = untis.open(row.secret);
        const lessons = row.mode === "login"
            ? await untis.fetchLessons({ server: row.server, school: row.school, username: row.username, password: secret }, from, to)
            : (await untis.fetchIcal(secret, tz)).filter(lesson => lesson.day >= from && lesson.day <= to);
        return { from, to, lessons };
    }

    async function store(userId, { from, to, lessons }) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("DELETE FROM untis_lessons WHERE user_id = $1 AND day BETWEEN $2 AND $3", [userId, from, to]);
            for (const l of lessons) {
                await client.query(
                    `INSERT INTO untis_lessons (user_id, external_id, day, start_min, end_min, subject, subject_long, room, class_name, status, info)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                    [userId, l.externalId, l.day, l.startMin, l.endMin, l.subject, l.subjectLong, l.room, l.className, l.status, l.info]);
            }
            await client.query("UPDATE untis_accounts SET last_sync_at = now(), last_error = NULL WHERE user_id = $1", [userId]);
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    }

    // one fetch per account at a time; a failure is noted, the lessons there stay
    function sync(userId) {
        if (syncing.has(userId)) return syncing.get(userId);
        const job = (async () => {
            const row = await account(userId);
            if (!row) return;
            try {
                await store(userId, await fetchFor(row, userId));
                // homework → tasks (login only: the iCal link has none); its failure doesn't fail the timetable
                if (row.mode === "login" && row.homework_to_tasks) await homeworkToTasks(row, userId).catch(() => {});
            } catch (err) {
                const code = err instanceof untis.UntisError ? err.code : "UNTIS_FAILED";
                await pool.query("UPDATE untis_accounts SET last_error = $2 WHERE user_id = $1", [userId, code]);
                throw err;
            }
        })().finally(() => syncing.delete(userId));
        syncing.set(userId, job);
        return job;
    }

    // homework not yet made into a task: a task on its day, at the time of that subject's lesson, with the text
    async function homeworkToTasks(row, userId) {
        const { from, to } = await range(userId);
        const [{ rows: [{ today }] }, { rows: known }] = await Promise.all([
            pool.query(`SELECT to_char((now() AT TIME ZONE COALESCE(timezone, 'Europe/Berlin'))::date, 'YYYY-MM-DD') AS today FROM users WHERE id = $1`, [userId]),
            pool.query("SELECT homework_id FROM untis_homework_tasks WHERE user_id = $1", [userId]),
        ]);
        const seen = new Set(known.map(r => String(r.homework_id)));
        const back = new Date(Date.parse(from) - 7 * 86400000).toISOString().slice(0, 10);
        const ahead = new Date(Date.parse(to) + 7 * 86400000).toISOString().slice(0, 10);
        const list = await untis.fetchHomework({ server: row.server, school: row.school, username: row.username, password: untis.open(row.secret) }, back, ahead);
        for (const hw of list) {
            if (hw.completed || seen.has(String(hw.id)) || hw.dueDay < today || !(hw.text || hw.remark)) continue;
            const lesson = hw.subject && (await pool.query(
                "SELECT start_min FROM untis_lessons WHERE user_id = $1 AND day = $2 AND subject = $3 AND status <> 'cancelled' ORDER BY start_min LIMIT 1",
                [userId, hw.dueDay, hw.subject])).rows[0];
            const time = lesson ? `${String(Math.floor(lesson.start_min / 60)).padStart(2, "0")}:${String(lesson.start_min % 60).padStart(2, "0")}` : null;
            const description = [hw.text, hw.remark].filter(Boolean).join("\n");
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const claimed = await client.query("INSERT INTO untis_homework_tasks (user_id, homework_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING homework_id", [userId, hw.id]);
                if (claimed.rowCount) {
                    const { rows: [task] } = await client.query(
                        "INSERT INTO tasks (name, due, due_time, description, user_id, kind) VALUES ($1, $2, $3, $4, $5, 'task') RETURNING id",
                        [`${hw.subject || "Untis"}: Hausaufgabe`, hw.dueDay, time, description.slice(0, 2000), userId]);
                    await client.query("UPDATE untis_homework_tasks SET task_id = $3 WHERE user_id = $1 AND homework_id = $2", [userId, hw.id, task.id]);
                }
                await client.query("COMMIT");
            } catch (err) {
                await client.query("ROLLBACK");
                throw err;
            } finally {
                client.release();
            }
        }
    }

    router.put("/settings", async (req, res) => {
        const row = await account(req.user.userId);
        if (!row) return fail(res, 404, "NOT_CONNECTED");
        if (typeof req.body?.homeworkToTasks !== "boolean") return fail(res, 400, "INVALID_INPUT", "homeworkToTasks");
        await pool.query("UPDATE untis_accounts SET homework_to_tasks = $2 WHERE user_id = $1", [req.user.userId, req.body.homeworkToTasks]);
        res.json(status(await account(req.user.userId)));
    });

    router.get("/", async (req, res) => {
        res.json(status(await account(req.user.userId)));
    });

    router.get("/schools", schoolSearch, async (req, res) => {
        const q = clip(req.query.q, 80);
        if (q.length < 3) return fail(res, 400, "INVALID_INPUT", "q");
        try {
            res.json(await untis.searchSchools(q));
        } catch (err) {
            return untisFailure(res, err);
        }
    });

    router.put("/", async (req, res) => {
        const userId = req.user.userId;
        if (!untis.canStorePasswords()) return fail(res, 503, "UNTIS_UNAVAILABLE");
        const body = req.body || {};
        let row;
        try {
            if (body.mode === "login") {
                const server = untis.validServer(body.server);
                const school = clip(body.school, 100);
                const username = clip(body.username, 100);
                const password = typeof body.password === "string" ? body.password : "";
                if (!server) return fail(res, 400, "INVALID_INPUT", "server");
                if (!school) return fail(res, 400, "INVALID_INPUT", "school");
                if (!username || !password || password.length > 200) return fail(res, 400, "INVALID_INPUT", "username");
                // signed in once now: wrong details are said at once, nothing stored
                await untis.login({ server, school, username, password });
                row = { mode: "login", server, school, school_label: clip(body.schoolLabel, 120) || school, username, secret: untis.seal(password) };
            } else if (body.mode === "ical") {
                const url = untis.validIcalUrl(body.url);
                if (!url) return fail(res, 400, "INVALID_INPUT", "url");
                await untis.fetchIcal(url);
                row = { mode: "ical", server: new URL(url).hostname, school: null, school_label: new URL(url).hostname, username: null, secret: untis.seal(url) };
            } else {
                return fail(res, 400, "INVALID_INPUT", "mode");
            }
        } catch (err) {
            return untisFailure(res, err);
        }
        await pool.query(
            `INSERT INTO untis_accounts (user_id, mode, server, school, school_label, username, secret)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, server = EXCLUDED.server, school = EXCLUDED.school,
                school_label = EXCLUDED.school_label, username = EXCLUDED.username, secret = EXCLUDED.secret,
                last_sync_at = NULL, last_error = NULL`,
            [userId, row.mode, row.server, row.school, row.school_label, row.username, row.secret]);
        await pool.query("DELETE FROM untis_lessons WHERE user_id = $1", [userId]);
        try {
            await sync(userId);
        } catch (err) {
            if (!(err instanceof untis.UntisError)) throw err;
        }
        res.json(status(await account(userId)));
    });

    router.delete("/", async (req, res) => {
        await pool.query("DELETE FROM untis_lessons WHERE user_id = $1", [req.user.userId]);
        await pool.query("DELETE FROM untis_accounts WHERE user_id = $1", [req.user.userId]);
        res.status(204).end();
    });

    router.post("/sync", async (req, res) => {
        const row = await account(req.user.userId);
        if (!row) return fail(res, 404, "NOT_CONNECTED");
        if (row.last_sync_at && Date.now() - new Date(row.last_sync_at).getTime() < MANUAL_GAP_MS) return res.json(status(row));
        try {
            await sync(req.user.userId);
        } catch (err) {
            if (!(err instanceof untis.UntisError)) throw err;
        }
        res.json(status(await account(req.user.userId)));
    });

    router.get("/lessons", async (req, res) => {
        const userId = req.user.userId;
        const from = typeof req.query.from === "string" && ISO.test(req.query.from) ? req.query.from : null;
        const to = typeof req.query.to === "string" && ISO.test(req.query.to) ? req.query.to : null;
        if (!from || !to || to < from || (Date.parse(to) - Date.parse(from)) / 86400000 > RANGE_MAX_DAYS) return fail(res, 400, "INVALID_INPUT", "range");
        const row = await account(userId);
        if (row && (!row.last_sync_at || Date.now() - new Date(row.last_sync_at).getTime() > FRESH_MS)) {
            // a failed fetch still answers with what is there
            await sync(userId).catch(() => {});
        }
        const { rows } = await pool.query(
            `SELECT id, to_char(day, 'YYYY-MM-DD') AS day, start_min, end_min, subject, subject_long, room, class_name, status, info
            FROM untis_lessons WHERE user_id = $1 AND day BETWEEN $2 AND $3 ORDER BY day, start_min`, [userId, from, to]);
        const fresh = row ? await account(userId) : null;
        res.json({
            lessons: rows.map(r => ({
                id: r.id, day: r.day, start: hhmm(r.start_min), end: hhmm(r.end_min), subject: r.subject, subjectLong: r.subject_long,
                room: r.room, className: r.class_name, status: r.status, info: r.info,
            })),
            lastSyncAt: fresh?.last_sync_at ?? null,
        });
    });

    return router;
};
