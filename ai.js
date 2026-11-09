// The AI features (later part of Quidey Pro, for now with daily allowances, utils/quota.js).
// Mounted at /api/ai, behind authenticateToken + requirePro.
//
//   GET  /api/ai/quota       → { available, scan: { used, max }, aiLine: { used, max }, resetsAt }
//   POST /api/ai/parse-entry { text } → { entry, quota }: a quick-entry line the app's own rules
//        didn't understand, read by Claude (utils/ai.js). Uses one "aiLine" of the day (given back
//        when the AI fails). entry = { kind, name, due, time, durationMinutes, color, eventTypeId,
//        reminders, prio }, checked here like any input.
// Only the line, today's date and the names of my event types go to Anthropic; nothing is kept.

const express = require("express");
const quota = require("./utils/quota");
const { ask, available, AiError, aiErrorResponse } = require("./utils/ai");

const TASK_COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "violet", "pink"];
const LINE_MAX = 500;
const REMINDER_MAX_MINUTES = 7 * 24 * 60;
const PRIO = { high: 80, medium: 50, low: 10 };

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });

const ENTRY_SCHEMA = {
    type: "object",
    properties: {
        kind: { type: "string", enum: ["task", "event", "reminder"] },
        name: { type: "string" },
        date: nullable({ type: "string" }),
        time: nullable({ type: "string" }),
        endTime: nullable({ type: "string" }),
        durationMinutes: nullable({ type: "integer" }),
        color: nullable({ type: "string", enum: TASK_COLORS }),
        eventType: nullable({ type: "string" }),
        remindersMinutesBefore: { type: "array", items: { type: "integer" } },
        priority: nullable({ type: "string", enum: ["high", "medium", "low"] }),
    },
    required: ["kind", "name", "date", "time", "endTime", "durationMinutes", "color", "eventType", "remindersMinutesBefore", "priority"],
    additionalProperties: false,
};

const ENTRY_SYSTEM = `You turn one line that a student typed or spoke into their planner into one planner entry.
The line can be German or English and may be informal or come from speech recognition.
- kind: "event" when the line has a time range or names an event type; "reminder" when it only asks to be reminded of something ("Erinnere mich…", "remind me…"); otherwise "task".
- name: what the entry is about, in the line's language, without the words for date, time, colour, type, priority or reminder.
- date: YYYY-MM-DD, resolved against today's date given below; a day without a year is the next such day on or after today; null when there is none.
- time / endTime: HH:MM in 24 hours; null when there is none.
- durationMinutes: only when a length is said without an end time.
- color: one of the listed colour names when the line names a colour (in any language), else null.
- eventType: exactly one of the user's event types listed below when the line names it or clearly means it, else null.
- remindersMinutesBefore: minutes before the start for each reminder asked for (a day = 1440), else [].
- priority: only when the line says so.
Never invent details the line doesn't contain.`;

const validDate = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const d = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value;
};
const validTime = (value) => (typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null);
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

// the AI's answer as an entry the app can save: anything unknown or out of range is left out
function cleanEntry(raw, { types, text }) {
    const kind = ["task", "event", "reminder"].includes(raw?.kind) ? raw.kind : "task";
    const name = (typeof raw?.name === "string" ? raw.name : "").replace(/\s+/g, " ").trim().slice(0, 200) || text.trim().slice(0, 200);
    const due = validDate(raw?.date);
    const time = validTime(raw?.time);
    const end = validTime(raw?.endTime);
    let durationMinutes = Number.isInteger(raw?.durationMinutes) && raw.durationMinutes > 0 && raw.durationMinutes <= 24 * 60 ? raw.durationMinutes : null;
    if (time && end) {
        // an end at or before the start is the next day
        const span = (minutesOf(end) - minutesOf(time) + 24 * 60) % (24 * 60);
        durationMinutes = span || null;
    }
    const wanted = typeof raw?.eventType === "string" ? raw.eventType.trim().toLowerCase() : "";
    const type = wanted ? (types.find(t => t.name.toLowerCase() === wanted) ?? types.find(t => t.name.toLowerCase().startsWith(wanted) || wanted.startsWith(t.name.toLowerCase()))) : null;
    const reminders = [...new Set((Array.isArray(raw?.remindersMinutesBefore) ? raw.remindersMinutesBefore : [])
        .filter(n => Number.isInteger(n) && n >= 0 && n <= REMINDER_MAX_MINUTES))].sort((a, b) => a - b).slice(0, 5);
    return {
        kind, name, due, time, durationMinutes,
        color: TASK_COLORS.includes(raw?.color) ? raw.color : null,
        eventTypeId: type ? type.id : null,
        reminders,
        prio: PRIO[raw?.priority] ?? null,
    };
}

module.exports = function aiRouter({ pool }) {
    const router = express.Router();
    // days older than a week aren't needed any more
    const sweep = setInterval(() => quota.forgetOldDays(pool).catch(() => {}), 6 * 60 * 60 * 1000);
    sweep.unref?.();

    // runs a job on one of today's allowances: refused when none is left, given back when it fails
    async function withQuota(req, res, kind, job) {
        const booked = await quota.take(pool, req.user.userId, kind);
        if (!booked.ok) return quota.refuse(res, kind, booked);
        try {
            const result = await job();
            res.json({ ...result, quota: await quota.status(pool, req.user.userId) });
        } catch (err) {
            await quota.giveBack(pool, req.user.userId, kind, booked.day).catch(() => {});
            if (err instanceof AiError) return aiErrorResponse(res, err);
            throw err;
        }
    }

    // available: false when the AI isn't set up here (no ANTHROPIC_API_KEY): the app hides its buttons
    router.get("/quota", async (req, res) => {
        res.json({ available: available(), ...await quota.status(pool, req.user.userId) });
    });

    router.post("/parse-entry", async (req, res) => {
        const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
        if (!text || text.length > LINE_MAX) return res.status(400).json({ error: "A line of 1 to 500 characters", code: "INVALID_INPUT", field: "text" });
        const [{ rows: [me] }, { rows: types }] = await Promise.all([
            pool.query(`SELECT to_char(now() AT TIME ZONE COALESCE(timezone, 'Europe/Berlin'), 'YYYY-MM-DD') AS today,
                trim(to_char(now() AT TIME ZONE COALESCE(timezone, 'Europe/Berlin'), 'Day')) AS weekday FROM users WHERE id = $1`, [req.user.userId]),
            pool.query("SELECT id, name FROM event_types WHERE user_id = $1 ORDER BY position, id", [req.user.userId]),
        ]);
        await withQuota(req, res, "ai_line", async () => {
            const raw = await ask("parse-entry", {
                system: ENTRY_SYSTEM,
                content: [
                    `Today: ${me.today} (${me.weekday}).`,
                    `Colour names: ${TASK_COLORS.join(", ")}.`,
                    `My event types: ${types.length ? types.map(t => t.name).join(", ") : "(none)"}.`,
                    `Line: ${text}`,
                ].join("\n"),
                schema: ENTRY_SCHEMA,
                maxTokens: 1500,
            });
            return { entry: cleanEntry(raw, { types, text }) };
        });
    });

    return router;
};

module.exports.cleanEntry = cleanEntry;
