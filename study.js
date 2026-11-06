// Study goals (testers): subjects, goals with their parts, study settings.
// Mounted at /api/tester/study, behind authenticateToken + requireTester. Every id is checked
// against the caller (user_id); somebody else's id answers 404.

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { sessionCredit, isPending, isReplaceable, goalStatus } = require('./utils/studyStatus');
const {
    reviewMinutes, makeAiClient, estimateParts, askAi, aiModel, pageCount,
} = require('./utils/studyEstimate');
const { plan } = require('./utils/studyPlanner');
const {
    getClock, loadSessions, loadGoals, goalView, goalProgress, loadPlanInput, inputHash, ACTIVE_GOAL_SQL,
} = require('./utils/studyLoad');

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

// Thrown inside inTransaction to roll back and hand `value` to the caller instead of an error.
class Rollback {
    constructor(value) { this.value = value; }
}

// The planner refused its input (malformed date or minutes): answered with 400.
class PlanInputError extends Error {}

// Sessions in date order, untimed ones first on a day.
const bySlot = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    || (a.time != null) - (b.time != null)
    || (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)
    || (a.taskId ?? 0) - (b.taskId ?? 0);
const slot = (s) => ({ date: s.date, time: s.time ?? null });
const toHHMM = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// What applying would change, per goal (spec §3): each part's replaceable sessions are matched with
// its new ones in date order. Same day, time and length: unchanged; otherwise moved; new ones left over are
// new, old ones left over dropped. Missed sessions are dropped too.
function previewOf(goals, sessions, result, hash) {
    return {
        inputHash: hash,
        shortfall: result.shortfall,
        goals: goals.map(({ goal, parts }) => {
            const summary = { moved: 0, added: 0, dropped: 0, unchanged: 0 };
            const changes = [];
            for (const part of parts) {
                const old = sessions.filter((s) => s.partId === part.id && s.status === 'replaceable').sort(bySlot);
                const next = result.sessions.filter((s) => s.partId === part.id).sort(bySlot);
                const partName = part.name;
                for (let i = 0; i < Math.max(old.length, next.length); i++) {
                    const from = old[i];
                    const to = next[i];
                    if (from && to) {
                        if (from.date === to.date && (from.time ?? null) === (to.time ?? null) && from.minutes === to.minutes) {
                            summary.unchanged++;
                        } else {
                            summary.moved++;
                            changes.push({ type: 'moved', partName, from: slot(from), to: slot(to), minutes: to.minutes });
                        }
                    } else if (to) {
                        summary.added++;
                        changes.push({ type: 'new', partName, to: slot(to), minutes: to.minutes });
                    } else {
                        summary.dropped++;
                        changes.push({ type: 'dropped', partName, from: slot(from), minutes: from.minutes });
                    }
                }
                for (const s of sessions.filter((x) => x.partId === part.id && x.status === 'missed')) {
                    summary.dropped++;
                    changes.push({ type: 'dropped', partName, from: slot(s), minutes: s.minutes });
                }
            }
            // by the day they are about: where a session goes, or where it was
            changes.sort((a, b) => bySlot(a.to || a.from, b.to || b.from));
            return { goalId: goal.id, name: goal.name, summary, changes };
        }),
    };
}

module.exports = ({ pool, realtime, loadTask }) => {
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

    // Runs fn(client) in one transaction. fn may throw a Rollback to undo everything and return its value.
    async function inTransaction(fn) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            if (err instanceof Rollback) return err.value;
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
            // goals before tasks, by id, like POST /replan (no deadlock between them)
            await client.query('SELECT id FROM goals WHERE subject_id = $1 AND user_id = $2 ORDER BY id FOR UPDATE', [id, userId]);
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
            // the goal before its tasks, in the same order as POST /replan (no deadlock between them)
            await client.query('SELECT id FROM goals WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
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

    const sumMinutes = (rows) => rows.reduce((sum, r) => sum + (r.duration_minutes ?? 0), 0);

    // Deletes only the sessions that are still replaceable at delete time (the caller classified them
    // from an earlier read; the phone may have ticked, pinned or annotated one since, and PUT /api/tasks
    // takes no goal lock). Returns the rows really deleted: [{ id, duration_minutes }].
    async function deleteReplaceable(client, userId, ids) {
        if (!ids.length) return [];
        return (await client.query(
            `DELETE FROM tasks WHERE id = ANY($1::int[]) AND user_id = $2 AND goal_part_id IS NOT NULL
                AND NOT COALESCE(done, false) AND NOT COALESCE(plan_pinned, false)
                AND NOT EXISTS (SELECT 1 FROM session_tasks WHERE session_tasks.task_id = tasks.id AND session_tasks.time_ms > 0)
                AND NOT EXISTS (SELECT 1 FROM notes WHERE notes.task_id = tasks.id)
                AND NOT EXISTS (SELECT 1 FROM task_groups WHERE task_groups.task_id = tasks.id)
                AND NOT EXISTS (SELECT 1 FROM collection_items WHERE collection_items.task_id = tasks.id)
                AND NOT EXISTS (SELECT 1 FROM task_shares WHERE task_shares.task_id = tasks.id)
            RETURNING id, duration_minutes`,
            [ids, userId]
        )).rows;
    }

    // Locks the goal of one of my parts: goal before parts and tasks, the order POST /replan uses.
    async function lockGoalOfPart(client, userId, partId) {
        await client.query(
            `SELECT goals.id FROM goals JOIN goal_parts ON goal_parts.goal_id = goals.id
            WHERE goal_parts.id = $1 AND goals.user_id = $2 FOR UPDATE OF goals`,
            [partId, userId]
        );
    }

    // Finishing a part (inside the caller's transaction): its credit is kept, its replaceable sessions go,
    // their minutes count as freed. Returns how many tasks were deleted.
    async function finishPart(client, userId, part) {
        const clock = await getClock(client, userId);
        const sessions = await loadSessions(client, userId, [part.id]);
        const credit = Math.round(sessions.reduce((sum, s) => sum + sessionCredit(s), 0));
        const gone = sessions.filter((s) => isReplaceable(s, clock));
        await client.query('UPDATE goal_parts SET done_at = now(), actual_minutes = $2 WHERE id = $1', [part.id, credit]);
        if (!gone.length) return 0;
        const deleted = await deleteReplaceable(client, userId, gone.map((s) => s.taskId));
        if (deleted.length) await client.query('UPDATE goals SET freed_minutes = freed_minutes + $2 WHERE id = $1', [part.goal_id, sumMinutes(deleted)]);
        return deleted.length;
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
            await lockGoalOfPart(client, userId, partId);
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
            await lockGoalOfPart(client, userId, partId);
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

    // ---------- plan: preview, apply, "Jetzt lernen", unpin ----------
    // The plan as applying it now would write it: the loaded input, the planner's result, its
    // fingerprint and the preview.
    async function currentPlan(db, userId) {
        const loaded = await loadPlanInput(db, userId);
        let result;
        try {
            result = plan(loaded.input);
        } catch (err) {
            if (err instanceof TypeError) throw new PlanInputError(err.message);
            throw err;
        }
        const ids = (status) => loaded.sessions.filter((s) => s.status === status).map((s) => s.taskId).sort((a, b) => a - b);
        const hash = inputHash(loaded.input, { replaceable: ids('replaceable'), missed: ids('missed'), result });
        return { ...loaded, result, hash, preview: previewOf(loaded.goals, loaded.sessions, result, hash) };
    }

    const planInputFailed = (res, err) => {
        if (!(err instanceof PlanInputError)) throw err;
        return fail(res, 400, 'invalid_input', 'Invalid plan input');
    };

    // Only tasks that are sessions of my goals (spec §6: the planner writes nothing else).
    const MY_SESSION = `goal_part_id IN (SELECT goal_parts.id FROM goal_parts
        JOIN goals ON goals.id = goal_parts.goal_id WHERE goals.user_id = $2)`;

    router.get('/plan', async (req, res) => {
        try {
            res.json((await currentPlan(pool, req.user.userId)).preview);
        } catch (err) {
            planInputFailed(res, err);
        }
    });

    // All or nothing: the plan is computed again inside the transaction; when it is not the one
    // the preview showed (inputHash), nothing changes and the fresh preview comes back with 409.
    router.post('/replan', async (req, res) => {
        const userId = req.user.userId;
        const hash = req.body && req.body.inputHash;
        if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return invalid(res, 'inputHash');
        let outcome;
        try {
            outcome = await inTransaction(async (client) => {
                // two applies (or an apply and a goal edit) take turns; the sessions can't change under us
                await client.query(`SELECT id FROM goals WHERE user_id = $1 AND ${ACTIVE_GOAL_SQL} ORDER BY id FOR UPDATE OF goals`, [userId]);
                await client.query(
                    `SELECT tasks.id FROM tasks
                    JOIN goal_parts ON goal_parts.id = tasks.goal_part_id
                    JOIN goals ON goals.id = goal_parts.goal_id
                    WHERE tasks.user_id = $1 AND goals.user_id = $1 AND ${ACTIVE_GOAL_SQL}
                    ORDER BY tasks.id FOR UPDATE OF tasks`,
                    [userId]
                );
                const current = await currentPlan(client, userId);
                if (current.hash !== hash) throw new Rollback({ stale: current.preview });

                const gone = current.sessions.filter((s) => s.status !== 'kept').map((s) => s.taskId);
                if (gone.length) {
                    await client.query(`DELETE FROM tasks WHERE id = ANY($1::int[]) AND user_id = $2 AND ${MY_SESSION}`, [gone, userId]);
                }
                const colors = new Map((await client.query(
                    'SELECT id, color FROM subjects WHERE user_id = $1', [userId]
                )).rows.map((r) => [r.id, r.color]));
                const parts = new Map(current.goals.flatMap(({ goal, parts: list }) => list.map((p) => [p.id, { name: p.name, color: colors.get(goal.subjectId) ?? null }])));
                const rows = current.result.sessions.map((s) => ({ ...s, ...parts.get(s.partId) }));
                if (rows.length) {
                    await client.query(
                        `INSERT INTO tasks (kind, user_id, name, color, due, due_time, duration_minutes, goal_part_id, plan_pinned, reminders)
                        SELECT 'task', $1, name, color, due, due_time, minutes, part_id, false, '{}'
                        FROM unnest($2::text[], $3::text[], $4::date[], $5::time[], $6::int[], $7::int[])
                            AS s(name, color, due, due_time, minutes, part_id)`,
                        [userId, rows.map((r) => r.name), rows.map((r) => r.color), rows.map((r) => r.date),
                            rows.map((r) => r.time), rows.map((r) => r.minutes), rows.map((r) => r.partId)]
                    );
                }
                // only the goals just planned (goals of an archived subject keep theirs)
                await client.query('UPDATE goals SET freed_minutes = 0, behind_notified_minutes = 0 WHERE user_id = $1 AND id = ANY($2::int[])', [userId, current.goals.map((g) => g.goal.id)]);
                return { ok: true };
            });
        } catch (err) {
            return planInputFailed(res, err);
        }
        if (outcome.stale) return res.status(409).json({ error: 'The plan has changed', code: 'plan_changed', preview: outcome.stale });
        changed(userId);
        res.json({ ok: true });
    });

    // "Jetzt lernen": a pinned session of this part for now (slots: now rounded down to 5 minutes;
    // days: today without a time), as long as the session length. Only for a goal that is planned
    // (active, subject not archived) and whose day isn't over.
    router.post('/parts/:id/now', async (req, res) => {
        const userId = req.user.userId;
        const part = (await pool.query(
            `SELECT goal_parts.id, goal_parts.name, goals.plan_mode, to_char(goals.due, 'YYYY-MM-DD') AS due,
                subjects.color, (${ACTIVE_GOAL_SQL}) AS active
            FROM goal_parts
            JOIN goals ON goals.id = goal_parts.goal_id
            JOIN subjects ON subjects.id = goals.subject_id
            WHERE goal_parts.id = $2 AND goals.user_id = $1`,
            [userId, idParam(req.params.id)]
        )).rows[0];
        if (!part) return notFound(res);
        if (!part.active) return fail(res, 400, 'goal_not_active', 'The goal is not active');
        const clock = await getClock(pool, userId);
        if (part.due < clock.today) return fail(res, 400, 'due_in_past', 'The due date is in the past');
        const time = part.plan_mode === 'slots' ? toHHMM(Math.floor(clock.nowMinutes / 5) * 5) : null;
        const id = (await pool.query(
            `INSERT INTO tasks (kind, user_id, name, color, due, due_time, duration_minutes, goal_part_id, plan_pinned, reminders)
            VALUES ('task', $1, $2, $3, $4, $5, $6, $7, true, '{}') RETURNING id`,
            [userId, part.name, part.color, clock.today, time, clock.sessionMinutes, part.id]
        )).rows[0].id;
        changed(userId);
        res.status(201).json({ task: await loadTask(id, userId) });
    });

    // Gives a session back to the planner.
    router.post('/sessions/:taskId/unpin', async (req, res) => {
        const userId = req.user.userId;
        const { rowCount } = await pool.query(
            `UPDATE tasks SET plan_pinned = false WHERE id = $1 AND user_id = $2 AND ${MY_SESSION}`,
            [idParam(req.params.taskId), userId]
        );
        if (!rowCount) return notFound(res);
        changed(userId);
        res.json({ ok: true });
    });

    // ---------- status and estimates ----------
    // Parts that reached their estimate (credit) but are not ticked off: their replaceable sessions
    // go and count as freed time. One goal per transaction, the goal locked first (lock order goal -> tasks).
    async function releaseAhead(userId, goalIds) {
        let deleted = 0;
        for (const id of goalIds) {
            deleted += await inTransaction(async (client) => {
                await client.query('SELECT id FROM goals WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
                const [fresh] = await loadGoals(client, userId, { id });
                if (!fresh || fresh.goal.status !== 'active') return 0;
                const clock = await getClock(client, userId);
                const { aheadPartIds } = goalStatus({ ...fresh, busy: [] }, clock);
                const open = new Set(fresh.parts.filter((p) => !p.doneAt).map((p) => p.id));
                const gone = fresh.sessions.filter((s) => aheadPartIds.includes(s.partId) && open.has(s.partId) && isReplaceable(s, clock));
                if (!gone.length) return 0;
                const deleted = await deleteReplaceable(client, userId, gone.map((s) => s.taskId));
                if (deleted.length) await client.query('UPDATE goals SET freed_minutes = freed_minutes + $2 WHERE id = $1', [id, sumMinutes(deleted)]);
                return deleted.length;
            });
        }
        return deleted;
    }

    function statusOf({ goals, clock, input }) {
        return goals.map((g) => ({ g, status: goalStatus({ ...g, busy: input.busy }, clock) }));
    }

    router.get('/status', async (req, res) => {
        const userId = req.user.userId;
        let loaded = await loadPlanInput(pool, userId);
        const ahead = statusOf(loaded).filter(({ g, status }) => status.aheadPartIds.some((pid) => g.parts.find((p) => p.id === pid && !p.doneAt)));
        if (ahead.length && await releaseAhead(userId, ahead.map(({ g }) => g.goal.id))) {
            changed(userId);
            loaded = await loadPlanInput(pool, userId);
        }
        const notified = new Map((await pool.query(
            'SELECT id, behind_notified_minutes FROM goals WHERE user_id = $1', [userId]
        )).rows.map((r) => [r.id, r.behind_notified_minutes]));
        const rows = statusOf(loaded);
        res.json({
            goals: rows.map(({ g, status }) => ({
                goalId: g.goal.id, name: g.goal.name, behindMinutes: status.behindMinutes,
                conflictTaskIds: status.conflictTaskIds, freedMinutes: g.goal.freedMinutes,
            })),
            notifiedMinutes: Object.fromEntries(rows.map(({ g }) => [g.goal.id, notified.get(g.goal.id) ?? 0])),
            aiAvailable: makeAiClient() !== null,
        });
    });

    // "So lassen": the current deficit counts as seen.
    router.post('/goals/:id/dismiss', async (req, res) => {
        const userId = req.user.userId;
        const id = idParam(req.params.id);
        if (!(await ownedGoal(pool, userId, id))) return notFound(res);
        const mine = statusOf(await loadPlanInput(pool, userId)).find(({ g }) => g.goal.id === id);
        const behind = mine ? mine.status.behindMinutes : 0;
        await pool.query('UPDATE goals SET behind_notified_minutes = $3 WHERE id = $1 AND user_id = $2', [id, userId, behind]);
        res.json({ ok: true, notifiedMinutes: behind });
    });

    // 20 requests that really call the AI per user and day (in memory, spec §4). Called by hand: over the
    // cap the handler only flags the request, so the estimates are answered without AI.
    const aiLimiter = rateLimit({
        windowMs: 24 * 60 * 60 * 1000,
        limit: 20,
        keyGenerator: (req) => String(req.user.userId),
        standardHeaders: false,
        legacyHeaders: false,
        handler: (req, res, next) => { req.aiOverLimit = true; next(); },
    });
    const takeAiSlot = (req, res) => new Promise((resolve, reject) => {
        aiLimiter(req, res, (err) => (err ? reject(err) : resolve(!req.aiOverLimit)));
    });

    router.post('/estimate', async (req, res) => {
        const userId = req.user.userId;
        const body = req.body || {};
        const subjectName = cleanName(body.subjectName, 60);
        if (!subjectName) return invalid(res, 'subjectName');
        if (!KINDS.includes(body.kind)) return invalid(res, 'kind');
        const due = cleanDate(body.due);
        if (!due) return invalid(res, 'due');
        if (!Array.isArray(body.parts) || body.parts.length < 1 || body.parts.length > MAX_PARTS) return invalid(res, 'parts');
        const parts = body.parts.map((p) => cleanName(p, 200));
        if (parts.includes(null)) return invalid(res, 'parts');
        let subjectId = null;
        if (body.subjectId != null) {
            subjectId = idParam(body.subjectId);
            if (!(await ownedSubject(pool, userId, subjectId))) return notFound(res);
        }

        const rows = (await pool.query(
            `SELECT goals.subject_id, goals.kind, goal_parts.name, goal_parts.actual_minutes
            FROM goal_parts JOIN goals ON goals.id = goal_parts.goal_id
            WHERE goals.user_id = $1 AND goal_parts.role = 'part' AND goal_parts.done_at IS NOT NULL
                AND goal_parts.actual_minutes > 0`,
            [userId]
        )).rows;
        const sameKind = rows.filter((r) => r.kind === body.kind);
        const history = {
            sameSubjectKind: sameKind.filter((r) => r.subject_id === subjectId).map((r) => r.actual_minutes),
            sameKind: sameKind.map((r) => r.actual_minutes),
            minutesPerPage: rows.flatMap((r) => {
                const pages = pageCount(r.name);
                return pages ? [r.actual_minutes / pages] : [];
            }),
        };
        const named = parts.map((name) => ({ name }));
        let estimates = estimateParts({ parts: named, kind: body.kind, history });

        const clock = await getClock(pool, userId);
        const client = body.ai === true || clock.aiAuto ? makeAiClient() : null;
        const open = estimates.flatMap((e, i) => (e.source === 'default' ? [i] : [])); // only what nothing else could estimate
        let aiUsed = false;
        let aiFailed = false;
        if (client && open.length) {
            if (!(await takeAiSlot(req, res))) {
                aiFailed = true;
            } else {
                const days = Math.max(0, Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${clock.today}T00:00:00Z`)) / 86400000));
                const answers = await askAi({
                    client, model: aiModel(), subjectName, kind: body.kind, daysUntilDue: days, parts: open.map((i) => parts[i]),
                });
                const ai = parts.map(() => null);
                open.forEach((i, k) => { ai[i] = answers[k]; });
                aiFailed = answers.every((a) => a == null);
                estimates = estimateParts({ parts: named, kind: body.kind, history, ai });
                aiUsed = estimates.some((e) => e.source === 'ai');
            }
        }
        res.json({ estimates, aiUsed, aiFailed });
    });

    return router;
};
