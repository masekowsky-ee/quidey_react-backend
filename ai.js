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
const { hasAiAccess } = require("./utils/access");

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


// ---------- scanning a document, photos, a note or pasted text ----------
const SCAN_WANTS = ["plan", "notes", "entries"];
const SCAN_PDF_MAX_BYTES = 10 * 1024 * 1024;
const SCAN_PDF_MAX_PAGES = 20;
const SCAN_IMAGES_MAX = 5;
const SCAN_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const SCAN_TEXT_MAX = 60000;
const SCAN_PARTS_MAX = 30;
const SCAN_ENTRIES_MAX = 30;
const GOAL_KINDS = ["exam", "assignment", "presentation", "other"];

const SCAN_SCHEMA = {
    type: "object",
    properties: {
        plan: nullable({
            type: "object",
            properties: {
                name: { type: "string" },
                kind: { type: "string", enum: GOAL_KINDS },
                due: nullable({ type: "string" }),
                subject: nullable({ type: "string" }),
                parts: { type: "array", items: { type: "object", properties: { name: { type: "string" }, minutes: { type: "integer" } }, required: ["name", "minutes"], additionalProperties: false } },
            },
            required: ["name", "kind", "due", "subject", "parts"],
            additionalProperties: false,
        }),
        notes: nullable({
            type: "object",
            properties: { title: { type: "string" }, body: { type: "string" } },
            required: ["title", "body"],
            additionalProperties: false,
        }),
        entries: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    kind: { type: "string", enum: ["task", "event"] },
                    name: { type: "string" },
                    date: nullable({ type: "string" }),
                    time: nullable({ type: "string" }),
                    endTime: nullable({ type: "string" }),
                    durationMinutes: nullable({ type: "integer" }),
                },
                required: ["kind", "name", "date", "time", "endTime", "durationMinutes"],
                additionalProperties: false,
            },
        },
    },
    required: ["plan", "notes", "entries"],
    additionalProperties: false,
};

const SCAN_SYSTEM = `You read a student's study material (lecture notes, a script, a syllabus, an exam plan, a worksheet, a timetable, a photo of a board or a page) and turn it into what they ask for. Write in the language of the material.
- plan: a study goal: its name, kind (exam, assignment, presentation, other), the due date when the material states one (YYYY-MM-DD, resolved against today), the subject, and the topics to learn as parts in a sensible learning order, each with realistic minutes for a student to learn it (15 to 600). Only when asked for, else null.
- notes: study notes with a short title and a body in this line format, one item per line: "# " heading, "## " subheading, "- " bullet, "- [ ] " a checklist item of what to learn or do, "1. " numbered, "> " quote; **bold** for key terms. Summarise and structure, don't copy whole paragraphs. Only when asked for, else null.
- entries: dated things in the material (exams, deadlines, appointments, lessons) as tasks or events: an event has a time or a time span, a task is something to hand in or do by a day. Dates YYYY-MM-DD resolved against today, times HH:MM. Only when asked for, else [].
Never invent dates, times or topics the material doesn't contain.`;

const base64Bytes = (data) => Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
const cleanBase64 = (value) => (typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null);

// the picture's real type from its first bytes (what the client says isn't trusted)
function imageType(data) {
    const head = Buffer.from(data.slice(0, 24), "base64");
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
    if (head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (head.slice(0, 4).toString("latin1") === "RIFF" && head.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
    return null;
}

// a rough page count (page objects); 0 when the file doesn't say
const pdfPages = (bytes) => (bytes.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) || []).length;

// the part of the request to read: content blocks for Claude, or { error: [status, code, field] }
async function scanContent(pool, userId, source) {
    if (!source || typeof source !== "object") return { error: [400, "INVALID_INPUT", "source"] };
    if (source.kind === "text") {
        const text = typeof source.text === "string" ? source.text.trim() : "";
        if (!text || text.length > SCAN_TEXT_MAX) return { error: [400, "INVALID_INPUT", "text"] };
        return { blocks: [{ type: "text", text: `The material:\n${text}` }] };
    }
    if (source.kind === "note") {
        const id = Number(source.noteId);
        if (!Number.isInteger(id) || id < 1) return { error: [400, "INVALID_INPUT", "noteId"] };
        const { rows } = await pool.query("SELECT title, body FROM notebook_notes WHERE id = $1 AND user_id = $2 AND trashed_at IS NULL", [id, userId]);
        if (!rows[0]) return { error: [404, "NOT_FOUND", "noteId"] };
        const text = `${rows[0].title ?? ""}\n${rows[0].body ?? ""}`.trim();
        if (!text) return { error: [400, "INVALID_INPUT", "noteId"] };
        return { blocks: [{ type: "text", text: `The material (a note):\n${text.slice(0, SCAN_TEXT_MAX)}` }] };
    }
    if (source.kind === "pdf") {
        const data = cleanBase64(source.data);
        if (!data || base64Bytes(data) > SCAN_PDF_MAX_BYTES) return { error: [400, "INVALID_INPUT", "data"] };
        const bytes = Buffer.from(data, "base64");
        if (bytes.slice(0, 5).toString("latin1") !== "%PDF-") return { error: [400, "INVALID_INPUT", "data"] };
        if (pdfPages(bytes) > SCAN_PDF_MAX_PAGES) return { error: [400, "SCAN_TOO_LONG", "data"] };
        return { blocks: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }] };
    }
    if (source.kind === "images") {
        const images = Array.isArray(source.images) ? source.images : [];
        if (images.length === 0 || images.length > SCAN_IMAGES_MAX) return { error: [400, "INVALID_INPUT", "images"] };
        const blocks = [];
        for (const image of images) {
            const data = cleanBase64(image?.data);
            const media = data && base64Bytes(data) <= SCAN_IMAGE_MAX_BYTES ? imageType(data) : null;
            if (!media) return { error: [400, "INVALID_INPUT", "images"] };
            blocks.push({ type: "image", source: { type: "base64", media_type: media, data } });
        }
        return { blocks };
    }
    return { error: [400, "INVALID_INPUT", "source"] };
}

const cleanText = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

// Claude's answer as something the app can show and create: only what was asked for, checked
function cleanScan(raw, wants) {
    let plan = null;
    if (wants.includes("plan") && raw?.plan && typeof raw.plan === "object") {
        const parts = (Array.isArray(raw.plan.parts) ? raw.plan.parts : [])
            .map(part => ({ name: cleanText(part?.name, 200), minutes: Number.isInteger(part?.minutes) ? Math.min(600, Math.max(15, part.minutes)) : 60 }))
            .filter(part => part.name)
            .slice(0, SCAN_PARTS_MAX);
        const name = cleanText(raw.plan.name, 200);
        if (name && parts.length) {
            plan = {
                name,
                kind: GOAL_KINDS.includes(raw.plan.kind) ? raw.plan.kind : "other",
                due: validDate(raw.plan.due),
                subject: cleanText(raw.plan.subject, 60) || null,
                parts,
            };
        }
    }
    let notes = null;
    if (wants.includes("notes") && raw?.notes && typeof raw.notes === "object") {
        const body = (typeof raw.notes.body === "string" ? raw.notes.body : "").replace(/\r\n?/g, "\n").trim().slice(0, 20000);
        if (body) notes = { title: cleanText(raw.notes.title, 120) || body.split("\n")[0].replace(/^#+\s*/, "").slice(0, 120), body };
    }
    const entries = wants.includes("entries") && Array.isArray(raw?.entries)
        ? raw.entries.slice(0, SCAN_ENTRIES_MAX)
            .map(entry => cleanEntry({ ...entry, kind: entry?.kind === "event" ? "event" : "task", remindersMinutesBefore: [], color: null, eventType: null, priority: null }, { types: [], text: "" }))
            .filter(entry => entry.name)
            // an event needs a day
            .map(entry => (entry.kind === "event" && !entry.due ? { ...entry, kind: "task" } : entry))
        : [];
    return { plan, notes, entries };
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
    // (and not for accounts without AI access: Pro and admins only, see utils/access.js)
    router.get("/quota", async (req, res) => {
        res.json({ available: available() && hasAiAccess(req.account), ...await quota.status(pool, req.user.userId) });
    });

    // every other route is Pro only
    router.use((req, res, next) => {
        if (hasAiAccess(req.account)) return next();
        res.status(403).json({ error: "The AI features are part of Quidey Pro", code: "PRO_REQUIRED" });
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


    //   POST /api/ai/scan { wants: ['plan'|'notes'|'entries'], source } → { result: { plan, notes, entries }, quota }
    //   source: { kind: 'pdf', data (base64), name } | { kind: 'images', images: [{ data }] } (≤ 5)
    //         | { kind: 'note', noteId } (one of mine) | { kind: 'text', text }
    // Uses the day's scan (given back when it fails). Nothing of it is stored here: the app shows the
    // result and creates what the person keeps through the usual routes.
    router.post("/scan", async (req, res) => {
        const wants = Array.isArray(req.body?.wants) ? [...new Set(req.body.wants)] : [];
        if (wants.length === 0 || wants.some(want => !SCAN_WANTS.includes(want))) {
            return res.status(400).json({ error: "Say what to make", code: "INVALID_INPUT", field: "wants" });
        }
        const content = await scanContent(pool, req.user.userId, req.body?.source);
        if (content.error) {
            const [status, code, field] = content.error;
            return res.status(status).json({ error: "This can't be scanned", code, field });
        }
        const { rows: [me] } = await pool.query(
            `SELECT to_char(now() AT TIME ZONE COALESCE(timezone, 'Europe/Berlin'), 'YYYY-MM-DD') AS today FROM users WHERE id = $1`, [req.user.userId]);
        await withQuota(req, res, "scan", async () => {
            const raw = await ask("scan", {
                system: SCAN_SYSTEM,
                content: [
                    ...content.blocks,
                    { type: "text", text: `Today: ${me.today}.\nMake: ${wants.join(", ")}.` },
                ],
                schema: SCAN_SCHEMA,
                maxTokens: 8000,
                timeoutMs: 90000,
            });
            return { result: cleanScan(raw, wants) };
        });
    });

    return router;
};

module.exports.cleanEntry = cleanEntry;
module.exports.cleanScan = cleanScan;
