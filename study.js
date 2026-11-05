// Study goals (testers): subjects, goals with their parts, study settings.
// Mounted at /api/tester/study, behind authenticateToken + requireTester. Every id is checked
// against the caller (user_id); somebody else's id answers 404.

const express = require('express');
const { sessionCredit, isPending, isReplaceable } = require('./utils/studyStatus');
const { reviewMinutes, makeAiClient } = require('./utils/studyEstimate');
const { getClock, loadSessions, loadGoals, goalView, goalProgress } = require('./utils/studyLoad');

const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink'];
const KINDS = ['exam', 'assignment', 'presentation', 'other'];
const MODES = ['slots', 'days'];
const STATUSES = ['active', 'done', 'archived'];
const MAX_PARTS = 40;
const ESTIMATE_SOURCES = ['history', 'pages', 'ai', 'default', 'manual'];

const fail = (res, status, code, error) => res.status(status).json({ error, code });
const invalid = (res, field) => fail(res, 400, 'invalid_input', `Invalid ${field}`);
const notFound = (res) => fail(res, 404, 'not_found', 'Not found');

const idParam = (value) => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
};

// Name: single line, 1..max characters; null when invalid.
function cleanName(value, max) {
    if (typeof value !== 'string' || value.includes('\u0000')) return null;
    const name = value.replace(/\s+/g, ' ').trim();
    return name.length >= 1 && name.length <= max ? name : null;
}

const cleanEstimate = (value) => (Number.isInteger(value) && value >= 15 && value <= 1200 ? value : null);

function cleanDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const d = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Emoji: a short string or null; undefined when invalid.
function cleanEmoji(value) {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || value.includes('\u0000') || value.length > 16) return undefined;
    return value;
}

module.exports = ({ pool, realtime }) => {
    const router = express.Router();
    const changed = (userId) => realtime.toUser(userId, 'tasks:changed', {});

    // Future (pending) sessions of these parts, from the database: [taskId].
    async function pendingTaskIds(db, userId, partIds, clock) {
        const sessions = await loadSessions(db, userId, partIds);
        return sessions.filter((s) => isPending(s, clock)).map((s) => s.taskId);
    }

    async function ownedSubject(db, userId, id) {
        if (id == null) return null;
        return (await db.query('SELECT * FROM subjects WHERE id = $1 AND user_id = $2', [id, userId])).rows[0] || null;
    }

    async function goalDetail(userId, id) {
        const [found] = await loadGoals(pool, userId, { id });
        return found ? goalView(found) : null;
    }

    const subjectView = (row, nextGoal = null) => ({
        id: row.id, name: row.name, emoji: row.emoji, color: row.color, archived: row.archived, nextGoal,
    });

    // Runs fn(client) in one transaction.
    async function inTransaction(fn) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    // ---------- subjects ----------
    router.get('/subjects', async (req, res) => {
        const userId = req.user.userId;
        const subjects = (await pool.query(
            'SELECT * FROM subjects WHERE user_id = $1 ORDER BY archived, lower(name), id', [userId]
        )).rows;
        const clock = await getClock(pool, userId);
        const goals = (await loadGoals(pool, userId)).filter((g) => g.goal.status === 'active'); // sorted by due
        res.json(subjects.map((s) => {
            const next = goals.find((g) => g.goal.subjectId === s.id);
            return subjectView(s, next ? {
                id: next.goal.id, name: next.goal.name, kind: next.goal.kind, due: next.goal.due,
                ...goalProgress(next, clock),
            } : null);
        }));
    });

    function cleanSubject(body, partial) {
        const out = {};
        if (!partial || body.name !== undefined) {
            const name = cleanName(body.name, 60);
            if (!name) return { field: 'name' };
            out.name = name;
        }
        if (body.emoji !== undefined) {
            const emoji = cleanEmoji(body.emoji);
            if (emoji === undefined) return { field: 'emoji' };
            out.emoji = emoji;
        }
        if (body.color !== undefined) {
            if (body.color !== null && !COLORS.includes(body.color)) return { field: 'color' };
            out.color = body.color;
        }
        if (body.archived !== undefined) {
            if (typeof body.archived !== 'boolean') return { field: 'archived' };
            out.archived = body.archived;
        }
        return { values: out };
    }

    router.post('/subjects', async (req, res) => {
        const { field, values } = cleanSubject(req.body || {}, false);
        if (field) return invalid(res, field);
        try {
            const row = (await pool.query(
                'INSERT INTO subjects (user_id, name, emoji, color) VALUES ($1, $2, $3, $4) RETURNING *',
                [req.user.userId, values.name, values.emoji ?? null, values.color ?? null]
            )).rows[0];
            res.status(201).json(subjectView(row));
        } catch (err) {
            if (err.code === '23505') return fail(res, 400, 'subject_exists', 'A subject with this name exists');
            throw err;
        }
    });

    router.patch('/subjects/:id', async (req, res) => {
        const userId = req.user.userId;
        const id = idParam(req.params.id);
        if (!(await ownedSubject(pool, userId, id))) return notFound(res);
        const { field, values } = cleanSubject(req.body || {}, true);
        if (field) return invalid(res, field);
        const keys = Object.keys(values);
        if (keys.length === 0) return invalid(res, 'body');
        try {
            const row = (await pool.query(
                `UPDATE subjects SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
                [id, userId, ...keys.map((k) => values[k])]
            )).rows[0];
            res.json(subjectView(row));
        } catch (err) {
            if (err.code === '23505') return fail(res, 400, 'subject_exists', 'A subject with this name exists');
            throw err;
        }
    });

    router.delete('/subjects/:id', async (req, res) => {
        const userId = req.user.userId;
        const id = idParam(req.params.id);
        if (!(await ownedSubject(pool, userId, id))) return notFound(res);
        const clock = await getClock(pool, userId);
        const client = await pool.connect();
        let removed = 0;
        try {
            await client.query('BEGIN');
            const partIds = (await client.query(
                'SELECT goal_parts.id FROM goal_parts JOIN goals ON goals.id = goal_parts.goal_id WHERE goals.subject_id = $1 AND goals.user_id = $2',
                [id, userId]
            )).rows.map((r) => r.id);
            const taskIds = await pendingTaskIds(client, userId, partIds, clock);
            if (taskIds.length) removed = (await client.query('DELETE FROM tasks WHERE id = ANY($1::int[]) AND user_id = $2', [taskIds, userId])).rowCount;
            await client.query('DELETE FROM subjects WHERE id = $1 AND user_id = $2', [id, userId]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
        changed(userId);
        res.json({ ok: true, removedSessions: removed });
    });

    // ---------- goals ----------
    router.get('/goals', async (req, res) => {
        const userId = req.user.userId;
        let subjectId = null;
        if (req.query.subject !== undefined) {
            subjectId = idParam(req.query.subject);
            if (subjectId == null) return invalid(res, 'subject');
        }
        res.json((await loadGoals(pool, userId, { subjectId })).map(goalView));
    });

    router.get('/goals/:id', async (req, res) => {
        const goal = await goalDetail(req.user.userId, idParam(req.params.id));
        if (!goal) return notFound(res);
        res.json(goal);
    });

    // Parts as sent by the client: [{ name, estimateMinutes, estimateSource? }] or null when invalid.
    function cleanParts(list) {
        const out = [];
        for (const raw of list) {
            if (!raw || typeof raw !== 'object') return null;
            const name = cleanName(raw.name, 200);
            const estimate = cleanEstimate(raw.estimateMinutes);
            if (!name || estimate == null) return null;
            const source = raw.estimateSource === undefined ? 'manual' : raw.estimateSource;
            if (!ESTIMATE_SOURCES.includes(source)) return null;
            out.push({ name, estimate, source });
        }
        return out;
    }

    router.post('/goals', async (req, res) => {
        const userId = req.user.userId;
        const body = req.body || {};
        const name = cleanName(body.name, 200);
        if (!name) return invalid(res, 'name');
        if (!KINDS.includes(body.kind)) return invalid(res, 'kind');
        if (!MODES.includes(body.planMode)) return invalid(res, 'planMode');
        const due = cleanDate(body.due);
        if (!due) return invalid(res, 'due');
        let dueTime = null;
        if (body.dueTime !== undefined && body.dueTime !== null) {
            if (typeof body.dueTime !== 'string' || !TIME.test(body.dueTime)) return invalid(res, 'dueTime');
            dueTime = body.dueTime;
        }
        const subjectId = idParam(body.subjectId);
        if (!(await ownedSubject(pool, userId, subjectId))) return notFound(res);
        if (!Array.isArray(body.parts)) return invalid(res, 'parts');
        if (body.parts.length === 0) return fail(res, 400, 'no_parts', 'A goal needs at least one part');
        const parts = cleanParts(body.parts);
        if (!parts) return invalid(res, 'parts');
        const exam = body.kind === 'exam';
        if (parts.length + (exam ? 1 : 0) > MAX_PARTS) return invalid(res, 'parts');
        const clock = await getClock(pool, userId);
        if (due < clock.today) return fail(res, 400, 'due_in_past', 'The due date is in the past');

        if (exam) {
            const lang = (await pool.query('SELECT language FROM users WHERE id = $1', [userId])).rows[0].language;
            parts.push({
                name: lang === 'en' ? 'Review' : 'Wiederholung', estimate: reviewMinutes(parts.map((p) => p.estimate)), source: 'default', role: 'review',
            });
        }
        const client = await pool.connect();
        let goalId;
        try {
            await client.query('BEGIN');
            goalId = (await client.query(
                `INSERT INTO goals (user_id, subject_id, kind, name, due, due_time, plan_mode)
                VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [userId, subjectId, body.kind, name, due, dueTime, body.planMode]
            )).rows[0].id;
            for (const [i, p] of parts.entries()) {
                await client.query(
                    `INSERT INTO goal_parts (goal_id, name, position, estimate_minutes, estimate_source, role)
                    VALUES ($1, $2, $3, $4, $5, $6)`,
                    [goalId, p.name, i, p.estimate, p.source, p.role || 'part']
                );
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
        res.status(201).json(await goalDetail(userId, goalId));
    });

    router.patch('/goals/:id', async (req, res) => {
        const userId = req.user.userId;
        const id = idParam(req.params.id);
        const current = (await pool.query(
            "SELECT to_char(due, 'YYYY-MM-DD') AS due FROM goals WHERE id = $1 AND user_id = $2", [id, userId]
        )).rows[0];
        if (!current) return notFound(res);
        const body = req.body || {};
        const sets = [];
        const params = [id, userId];
        const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
        if (body.name !== undefined) {
            const name = cleanName(body.name, 200);
            if (!name) return invalid(res, 'name');
            set('name', name);
        }
        if (body.kind !== undefined) {
            if (!KINDS.includes(body.kind)) return invalid(res, 'kind');
            set('kind', body.kind);
        }
        if (body.planMode !== undefined) {
            if (!MODES.includes(body.planMode)) return invalid(res, 'planMode');
            set('plan_mode', body.planMode);
        }
        if (body.status !== undefined) {
            if (!STATUSES.includes(body.status)) return invalid(res, 'status');
            set('status', body.status);
        }
        if (body.due !== undefined) {
            const due = cleanDate(body.due);
            if (!due) return invalid(res, 'due');
            if (due !== current.due && due < (await getClock(pool, userId)).today) return fail(res, 400, 'due_in_past', 'The due date is in the past');
            set('due', due);
        }
        if (body.dueTime !== undefined) {
            if (body.dueTime !== null && (typeof body.dueTime !== 'string' || !TIME.test(body.dueTime))) return invalid(res, 'dueTime');
            set('due_time', body.dueTime);
        }
        if (body.subjectId !== undefined) {
            const subjectId = idParam(body.subjectId);
            if (!(await ownedSubject(pool, userId, subjectId))) return notFound(res);
            set('subject_id', subjectId);
        }
        if (sets.length === 0) return invalid(res, 'body');
        await pool.query(`UPDATE goals SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`, params);
        res.json(await goalDetail(userId, id));
    });

    router.delete('/goals/:id', async (req, res) => {
        const userId = req.user.userId;
        const id = idParam(req.params.id);
        const mode = req.query.sessions === undefined ? 'keep' : req.query.sessions;
        if (mode !== 'keep' && mode !== 'delete') return invalid(res, 'sessions');
        if (!(await ownedGoal(pool, userId, id))) return notFound(res);
        let removed = 0;
        await inTransaction(async (client) => {
            if (mode === 'delete') {
                const partIds = (await client.query('SELECT id FROM goal_parts WHERE goal_id = $1', [id])).rows.map((r) => r.id);
                const doomed = await pendingTaskIds(client, userId, partIds, await getClock(client, userId));
                if (doomed.length) removed = (await client.query('DELETE FROM tasks WHERE id = ANY($1::int[]) AND user_id = $2', [doomed, userId])).rowCount;
            }
            await client.query('DELETE FROM goals WHERE id = $1 AND user_id = $2', [id, userId]); // parts go, tasks keep (goal_part_id -> null)
        });
        changed(userId);
        res.json({ ok: true, removedSessions: removed });
    });

    // ---------- parts ----------
    async function ownedGoal(db, userId, id) {
        if (id == null) return null;
        return (await db.query('SELECT id FROM goals WHERE id = $1 AND user_id = $2', [id, userId])).rows[0] || null;
    }

    async function ownedPart(db, userId, id) {
        if (id == null) return null;
        return (await db.query(
            `SELECT goal_parts.id, goal_parts.goal_id, goal_parts.done_at FROM goal_parts
            JOIN goals ON goals.id = goal_parts.goal_id WHERE goal_parts.id = $1 AND goals.user_id = $2`,
            [id, userId]
        )).rows[0] || null;
    }

    async function partDetail(userId, goalId, partId) {
        const goal = await goalDetail(userId, goalId);
        return goal.parts.find((p) => p.id === partId);
    }

    router.post('/goals/:id/parts', async (req, res) => {
        const userId = req.user.userId;
        const goalId = idParam(req.params.id);
        if (!(await ownedGoal(pool, userId, goalId))) return notFound(res);
        const [part] = cleanParts([req.body || {}]) || [];
        if (!part) return invalid(res, 'part');
        const client = await pool.connect();
        let partId;
        try {
            await client.query('BEGIN');
            await client.query('SELECT id FROM goals WHERE id = $1 FOR UPDATE', [goalId]);
            const count = (await client.query('SELECT count(*)::int AS n FROM goal_parts WHERE goal_id = $1', [goalId])).rows[0].n;
            if (count >= MAX_PARTS) {
                await client.query('ROLLBACK');
                return invalid(res, 'parts');
            }
            // a review part stays last
            const next = (await client.query(
                "SELECT COALESCE(max(position), -1) + 1 AS n FROM goal_parts WHERE goal_id = $1 AND role = 'part'", [goalId]
            )).rows[0].n;
            await client.query("UPDATE goal_parts SET position = position + 1 WHERE goal_id = $1 AND position >= $2", [goalId, next]);
            partId = (await client.query(
                `INSERT INTO goal_parts (goal_id, name, position, estimate_minutes, estimate_source)
                VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [goalId, part.name, next, part.estimate, part.source]
            )).rows[0].id;
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
        res.status(201).json(await partDetail(userId, goalId, partId));
    });

    // Finishing a part (inside the caller's transaction): its credit is kept, its replaceable sessions go,
    // their minutes count as freed. Returns how many tasks were deleted.
    async function finishPart(client, userId, part) {
        const clock = await getClock(client, userId);
        const sessions = await loadSessions(client, userId, [part.id]);
        const credit = Math.round(sessions.reduce((sum, s) => sum + sessionCredit(s), 0));
        const gone = sessions.filter((s) => isReplaceable(s, clock));
        await client.query('UPDATE goal_parts SET done_at = now(), actual_minutes = $2 WHERE id = $1', [part.id, credit]);
        if (!gone.length) return 0;
        const removed = (await client.query('DELETE FROM tasks WHERE id = ANY($1::int[]) AND user_id = $2', [gone.map((s) => s.taskId), userId])).rowCount;
        await client.query('UPDATE goals SET freed_minutes = freed_minutes + $2 WHERE id = $1', [part.goal_id, gone.reduce((sum, s) => sum + s.minutes, 0)]);
        return removed;
    }

    router.patch('/parts/:id', async (req, res) => {
        const userId = req.user.userId;
        const partId = idParam(req.params.id);
        if (!(await ownedPart(pool, userId, partId))) return notFound(res);
        const body = req.body || {};
        const sets = [];
        const params = [partId];
        const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
        if (body.name !== undefined) {
            const name = cleanName(body.name, 200);
            if (!name) return invalid(res, 'name');
            set('name', name);
        }
        if (body.estimateMinutes !== undefined) {
            const estimate = cleanEstimate(body.estimateMinutes);
            if (estimate == null) return invalid(res, 'estimateMinutes');
            set('estimate_minutes', estimate);
            set('estimate_source', 'manual');
        }
        if (body.doneAt === undefined && sets.length === 0) return invalid(res, 'body');
        let removed = 0;
        let goalId;
        const found = await inTransaction(async (client) => {
            const part = (await client.query(
                `SELECT goal_parts.id, goal_parts.goal_id, goal_parts.done_at FROM goal_parts
                JOIN goals ON goals.id = goal_parts.goal_id WHERE goal_parts.id = $1 AND goals.user_id = $2 FOR UPDATE OF goal_parts`,
                [partId, userId]
            )).rows[0];
            if (!part) return false;
            goalId = part.goal_id;
            if (sets.length) await client.query(`UPDATE goal_parts SET ${sets.join(', ')} WHERE id = $1`, params);
            if (body.doneAt !== undefined) {
                if (body.doneAt && !part.done_at) removed = await finishPart(client, userId, part);
                else if (!body.doneAt && part.done_at) await client.query('UPDATE goal_parts SET done_at = NULL, actual_minutes = NULL WHERE id = $1', [partId]);
            }
            return true;
        });
        if (!found) return notFound(res);
        if (removed) changed(userId);
        res.json(await partDetail(userId, goalId, partId));
    });

    router.delete('/parts/:id', async (req, res) => {
        const userId = req.user.userId;
        const partId = idParam(req.params.id);
        let removed = 0;
        const found = await inTransaction(async (client) => {
            const part = (await client.query(
                `SELECT goal_parts.id FROM goal_parts JOIN goals ON goals.id = goal_parts.goal_id
                WHERE goal_parts.id = $1 AND goals.user_id = $2 FOR UPDATE OF goal_parts`,
                [partId, userId]
            )).rows[0];
            if (!part) return false;
            const doomed = await pendingTaskIds(client, userId, [partId], await getClock(client, userId)); // past ones stay as plain tasks
            if (doomed.length) removed = (await client.query('DELETE FROM tasks WHERE id = ANY($1::int[]) AND user_id = $2', [doomed, userId])).rowCount;
            await client.query('DELETE FROM goal_parts WHERE id = $1', [partId]);
            return true;
        });
        if (!found) return notFound(res);
        if (removed) changed(userId);
        res.json({ ok: true, removedSessions: removed });
    });

    router.put('/goals/:id/parts/order', async (req, res) => {
        const userId = req.user.userId;
        const goalId = idParam(req.params.id);
        if (!(await ownedGoal(pool, userId, goalId))) return notFound(res);
        const ids = req.body && req.body.ids;
        if (!Array.isArray(ids) || !ids.every((x) => idParam(x))) return invalid(res, 'ids');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const have = (await client.query('SELECT id FROM goal_parts WHERE goal_id = $1 FOR UPDATE', [goalId])).rows.map((r) => r.id);
            if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((x) => have.includes(Number(x)))) {
                await client.query('ROLLBACK');
                return invalid(res, 'ids');
            }
            for (const [i, partId] of ids.entries()) await client.query('UPDATE goal_parts SET position = $2 WHERE id = $1', [partId, i]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
        res.json((await goalDetail(userId, goalId)).parts);
    });

    // ---------- settings ----------
    async function settingsView(userId) {
        const clock = await getClock(pool, userId);
        const windows = (await pool.query(
            `SELECT weekday, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS "end"
            FROM study_windows WHERE user_id = $1 ORDER BY weekday, start_time, id`,
            [userId]
        )).rows;
        return {
            windows: windows.map((w) => ({ weekday: w.weekday, start: w.start, end: w.end })),
            sessionMinutes: clock.sessionMinutes,
            dailyMaxMinutes: clock.dailyMaxMinutes,
            aiAuto: clock.aiAuto,
            aiAvailable: makeAiClient() !== null,
        };
    }

    router.get('/settings', async (req, res) => {
        res.json(await settingsView(req.user.userId));
    });

    router.put('/settings', async (req, res) => {
        const userId = req.user.userId;
        const body = req.body || {};
        let windows = null;
        if (body.windows !== undefined) {
            if (!Array.isArray(body.windows) || body.windows.length > 50) return fail(res, 400, 'invalid_window', 'windows must be a list');
            windows = [];
            for (const w of body.windows) {
                const ok = w && Number.isInteger(w.weekday) && w.weekday >= 1 && w.weekday <= 7
                    && typeof w.start === 'string' && typeof w.end === 'string' && TIME.test(w.start) && TIME.test(w.end) && w.start < w.end;
                if (!ok) return fail(res, 400, 'invalid_window', 'Invalid study window');
                windows.push(w);
            }
        }
        const sets = [];
        const params = [userId];
        const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
        if (body.sessionMinutes !== undefined) {
            if (!Number.isInteger(body.sessionMinutes) || body.sessionMinutes < 15 || body.sessionMinutes > 180) return invalid(res, 'sessionMinutes');
            set('study_session_minutes', body.sessionMinutes);
        }
        if (body.dailyMaxMinutes !== undefined) {
            if (!Number.isInteger(body.dailyMaxMinutes) || body.dailyMaxMinutes < 15 || body.dailyMaxMinutes > 720) return invalid(res, 'dailyMaxMinutes');
            set('study_daily_max_minutes', body.dailyMaxMinutes);
        }
        if (body.aiAuto !== undefined) {
            if (typeof body.aiAuto !== 'boolean') return invalid(res, 'aiAuto');
            set('study_ai_auto', body.aiAuto);
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (windows) {
                await client.query('DELETE FROM study_windows WHERE user_id = $1', [userId]);
                for (const w of windows) {
                    await client.query(
                        'INSERT INTO study_windows (user_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4)',
                        [userId, w.weekday, w.start, w.end]
                    );
                }
            }
            if (sets.length) await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
        res.json(await settingsView(userId));
    });

    return router;
};
