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
const { hasAiAccess } = require("./utils/access");
const { available: aiAvailable, estimateHomeworkMinutes } = require("./utils/ai");

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
                // homework → suggestions (login only: the iCal link has none); its failure doesn't fail the timetable
                if (row.mode === "login") {
                    // the school's subjects and exams in Lernen (a failure doesn't fail the timetable)
                    await subjectsAndExams(row, userId).catch((err) => console.error("[untis] subjects/exams", err.message));
                }
                if (row.mode === "login" && row.homework_to_tasks) await homeworkSuggestions(row, userId).catch((err) => console.error("[untis] homework", err.message));
            } catch (err) {
                const code = err instanceof untis.UntisError ? err.code : "UNTIS_FAILED";
                await pool.query("UPDATE untis_accounts SET last_error = $2 WHERE user_id = $1", [userId, code]);
                throw err;
            }
        })().finally(() => syncing.delete(userId));
        syncing.set(userId, job);
        return job;
    }

    const SUBJECT_COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "violet", "pink"];

    // every Untis subject as a Lernen subject (one I have under that name is reused, else made with the
    // first colour not in use, cycling once all eight are), then the exams still to come as exam goals
    async function subjectsAndExams(row, userId) {
        const { rows: lessons } = await pool.query(
            "SELECT DISTINCT subject, subject_long FROM untis_lessons WHERE user_id = $1 AND subject <> ''", [userId]);
        const known = new Map(); // short name -> subject id
        for (const lesson of lessons) {
            const name = (lesson.subject_long || lesson.subject).slice(0, 60);
            let { rows: [subject] } = await pool.query(
                "SELECT id FROM subjects WHERE user_id = $1 AND (lower(name) = lower($2) OR lower(untis_name) = lower($2)) ORDER BY id LIMIT 1", [userId, name]);
            if (!subject) {
                const { rows: used } = await pool.query("SELECT color FROM subjects WHERE user_id = $1 AND NOT archived", [userId]);
                const taken = new Set(used.map(r => r.color));
                const color = SUBJECT_COLORS.find(c => !taken.has(c)) ?? SUBJECT_COLORS[used.length % SUBJECT_COLORS.length];
                ({ rows: [subject] } = await pool.query(
                    "INSERT INTO subjects (user_id, name, color, untis_name) VALUES ($1, $2, $3, $2) RETURNING id", [userId, name, color]));
            } else {
                await pool.query("UPDATE subjects SET untis_name = COALESCE(untis_name, $2) WHERE id = $1", [subject.id, name]);
            }
            known.set(lesson.subject, subject.id);
        }

        const { from, to } = await range(userId);
        const [{ rows: [{ today }] }] = await Promise.all([
            pool.query(`SELECT to_char((now() AT TIME ZONE COALESCE(timezone, 'Europe/Berlin'))::date, 'YYYY-MM-DD') AS today FROM users WHERE id = $1`, [userId]),
        ]);
        const ahead = new Date(Date.parse(to) + 120 * 86400000).toISOString().slice(0, 10);
        const exams = await untis.fetchExams({ server: row.server, school: row.school, username: row.username, password: untis.open(row.secret) }, from, ahead);
        const { rows: seen } = await pool.query("SELECT untis_id FROM untis_exams WHERE user_id = $1", [userId]);
        const done = new Set(seen.map(r => String(r.untis_id)));
        for (const exam of exams) {
            if (done.has(String(exam.id)) || exam.day < today || !known.has(exam.subject)) continue;
            const subjectId = known.get(exam.subject);
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const claimed = await client.query("INSERT INTO untis_exams (user_id, untis_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING untis_id", [userId, exam.id]);
                if (claimed.rowCount) {
                    // one I entered myself (same subject, same day) is that exam
                    const { rows: [mine] } = await client.query(
                        "SELECT id FROM goals WHERE user_id = $1 AND subject_id = $2 AND kind = 'exam' AND due = $3 LIMIT 1", [userId, subjectId, exam.day]);
                    let goalId = mine?.id;
                    if (!goalId) {
                        const { rows: [subject] } = await client.query("SELECT name FROM subjects WHERE id = $1", [subjectId]);
                        ({ rows: [{ id: goalId }] } = await client.query(
                            "INSERT INTO goals (user_id, subject_id, kind, name, due, due_time, plan_mode) VALUES ($1, $2, 'exam', $3, $4, $5, 'days') RETURNING id",
                            [userId, subjectId, `${subject.name}: Klausur`.slice(0, 200), exam.day, exam.time]));
                        await client.query(
                            "INSERT INTO goal_parts (goal_id, name, position, estimate_minutes, estimate_source) VALUES ($1, 'Lernen', 0, 120, 'default')", [goalId]);
                    }
                    await client.query("UPDATE untis_exams SET goal_id = $3 WHERE user_id = $1 AND untis_id = $2", [userId, exam.id, goalId]);
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

    const AI_ESTIMATES_PER_SYNC = 10;

    // homework not yet offered: a suggestion on its day, at the time of that subject's lesson, with the text and, for
    // accounts with AI access, an estimated working time; taken or dismissed ones are never offered again
    async function homeworkSuggestions(row, userId) {
        const { from, to } = await range(userId);
        const [{ rows: [{ today }] }, { rows: known }, { rows: [account] }] = await Promise.all([
            pool.query(`SELECT to_char((now() AT TIME ZONE COALESCE(timezone, 'Europe/Berlin'))::date, 'YYYY-MM-DD') AS today FROM users WHERE id = $1`, [userId]),
            pool.query("SELECT untis_homework_id FROM untis_homework_suggestions WHERE user_id = $1", [userId]),
            pool.query("SELECT is_pro, pro_until, is_admin FROM users WHERE id = $1", [userId]),
        ]);
        const seen = new Set(known.map(r => String(r.untis_homework_id)));
        const back = new Date(Date.parse(from) - 7 * 86400000).toISOString().slice(0, 10);
        const ahead = new Date(Date.parse(to) + 7 * 86400000).toISOString().slice(0, 10);
        const list = await untis.fetchHomework({ server: row.server, school: row.school, username: row.username, password: untis.open(row.secret) }, back, ahead);
        const mayAsk = hasAiAccess(account) && aiAvailable();
        let asked = 0;
        for (const hw of list) {
            if (hw.completed || seen.has(String(hw.id)) || hw.dueDay < today || !(hw.text || hw.remark)) continue;
            const lesson = hw.subject && (await pool.query(
                "SELECT start_min FROM untis_lessons WHERE user_id = $1 AND day = $2 AND subject = $3 AND status <> 'cancelled' ORDER BY start_min LIMIT 1",
                [userId, hw.dueDay, hw.subject])).rows[0];
            const time = lesson ? hhmm(lesson.start_min) : null;
            const subject = hw.subject && (await pool.query(
                `SELECT s.id FROM untis_lessons l JOIN subjects s ON lower(s.name) = lower(COALESCE(NULLIF(l.subject_long, ''), l.subject)) OR lower(s.untis_name) = lower(COALESCE(NULLIF(l.subject_long, ''), l.subject))
                 WHERE l.user_id = $1 AND l.subject = $2 AND s.user_id = $1 ORDER BY s.id LIMIT 1`, [userId, hw.subject])).rows[0];
            let minutes = null;
            if (mayAsk && asked < AI_ESTIMATES_PER_SYNC) {
                asked += 1;
                const days = Math.round((Date.parse(hw.dueDay) - Date.parse(today)) / 86400000);
                minutes = await estimateHomeworkMinutes({ text: [hw.text, hw.remark].filter(Boolean).join(" "), subject: hw.subject, daysUntilDue: days });
            }
            await pool.query(
                `INSERT INTO untis_homework_suggestions (user_id, untis_homework_id, subject_id, subject_name, text, remark, due, due_time, estimate_minutes, estimate_source)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
                [userId, hw.id, subject?.id ?? null, hw.subject || "", hw.text, hw.remark, hw.dueDay, time, minutes, minutes == null ? null : "ai"]);
        }
    }

    // the open suggestions, as the app lists them
    router.get("/suggestions", async (req, res) => {
        const { rows } = await pool.query(
            `SELECT h.id, h.subject_id, COALESCE(s.name, NULLIF(h.subject_name, ''), 'Untis') AS subject_name, h.text, h.remark,
                    to_char(h.due, 'YYYY-MM-DD') AS due, to_char(h.due_time, 'HH24:MI') AS due_time, h.estimate_minutes, h.estimate_source
             FROM untis_homework_suggestions h LEFT JOIN subjects s ON s.id = h.subject_id
             WHERE h.user_id = $1 AND h.state = 'open' ORDER BY h.due, h.id`, [req.user.userId]);
        res.json(rows.map(r => ({
            id: r.id, subjectId: r.subject_id, subjectName: r.subject_name, text: r.text, remark: r.remark,
            due: r.due, dueTime: r.due_time, estimateMinutes: r.estimate_minutes, estimateSource: r.estimate_source,
        })));
    });

    // takes one: the task on its day (the lesson's time, the text), with the minutes typed or estimated
    router.post("/suggestions/:id/take", async (req, res) => {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return fail(res, 404, "NOT_FOUND");
        const minutes = req.body?.minutes;
        if (minutes !== undefined && minutes !== null && !(Number.isInteger(minutes) && minutes >= 5 && minutes <= 600)) return fail(res, 400, "INVALID_INPUT", "minutes");
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const { rows: [hw] } = await client.query(
                `UPDATE untis_homework_suggestions SET state = 'taken' WHERE id = $1 AND user_id = $2 AND state = 'open'
                 RETURNING subject_name, text, remark, to_char(due, 'YYYY-MM-DD') AS due, due_time, estimate_minutes, subject_id`, [id, req.user.userId]);
            if (!hw) { await client.query("ROLLBACK"); return fail(res, 404, "NOT_FOUND"); }
            const { rows: [named] } = await client.query("SELECT name FROM subjects WHERE id = $1", [hw.subject_id]);
            const duration = Number.isInteger(minutes) ? minutes : hw.estimate_minutes;
            const { rows: [task] } = await client.query(
                "INSERT INTO tasks (name, due, due_time, description, duration_minutes, user_id, kind) VALUES ($1, $2, $3, $4, $5, $6, 'task') RETURNING id",
                [`${hw.subject_name || named?.name || "Untis"}: Hausaufgabe`.slice(0, 200), hw.due, hw.due_time, [hw.text, hw.remark].filter(Boolean).join("\n").slice(0, 2000), duration, req.user.userId]);
            await client.query("UPDATE untis_homework_suggestions SET task_id = $2 WHERE id = $1", [id, task.id]);
            await client.query("COMMIT");
            res.json({ taskId: task.id });
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    });

    router.post("/suggestions/:id/dismiss", async (req, res) => {
        const id = Number.parseInt(req.params.id, 10);
        const done = Number.isInteger(id) && await pool.query(
            "UPDATE untis_homework_suggestions SET state = 'dismissed' WHERE id = $1 AND user_id = $2 AND state = 'open'", [id, req.user.userId]);
        if (!done || done.rowCount === 0) return fail(res, 404, "NOT_FOUND");
        res.status(204).end();
    });

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
