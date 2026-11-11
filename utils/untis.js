// The timetable from WebUntis (branch pro-features, later Quidey Pro). Two ways in:
// - login: school + WebUntis user + password. WebUntis' JSON-RPC web API (the one its web app
//   uses; not officially documented, so it may change): authenticate → getTimetable → logout.
//   The password is kept encrypted (AES-256-GCM, key from UNTIS_SECRET), only to fetch again.
// - ical: the timetable's subscription link from WebUntis (no password reaches Quidey).
// Only *.webuntis.com is ever asked (no other hosts: the server must not fetch arbitrary URLs).
// Lessons: { externalId, day 'YYYY-MM-DD', startMin, endMin, subject, subjectLong, room, className,
// status 'normal' | 'cancelled' | 'irregular', info } in the school's local time.

const crypto = require("crypto");

const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.webuntis\.com$/i;
const TIMEOUT_MS = 15000;

class UntisError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

const validServer = (server) => typeof server === "string" && HOST.test(server.trim()) ? server.trim().toLowerCase() : null;

// tests: everything goes to a local fake WebUntis (never in production)
const testBase = () => (process.env.NODE_ENV !== "production" && process.env.UNTIS_TEST_BASE) || null;
const baseOf = (server) => testBase() || `https://${server}`;

async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal, redirect: "error" });
    } catch (err) {
        throw new UntisError(err.name === "AbortError" ? "UNTIS_TIMEOUT" : "UNTIS_UNREACHABLE", err.message);
    } finally {
        clearTimeout(timer);
    }
}

// ---------- school search (the one the Untis mobile app uses) ----------
async function searchSchools(query) {
    const base = testBase() || "https://mobile.webuntis.com";
    const res = await request(`${base}/ms/schoolquery2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "quidey", method: "searchSchool", params: [{ search: query }], jsonrpc: "2.0" }),
    });
    const data = await res.json().catch(() => null);
    const schools = data?.result?.schools;
    if (!Array.isArray(schools)) return [];
    return schools.slice(0, 20).map(school => ({
        server: validServer(school.server),
        school: typeof school.loginName === "string" ? school.loginName : null,
        label: typeof school.displayName === "string" ? school.displayName : school.loginName,
        address: typeof school.address === "string" ? school.address : "",
    })).filter(school => school.server && school.school);
}

// ---------- the JSON-RPC timetable ----------
const untisDate = (iso) => Number(iso.replaceAll("-", ""));
const isoDate = (n) => { const s = String(n); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };
const minutesOf = (hmm) => Math.floor(hmm / 100) * 60 + (hmm % 100);

async function rpc(server, school, method, params, sessionId) {
    const url = `${baseOf(server)}/WebUntis/jsonrpc.do?school=${encodeURIComponent(school)}`;
    const headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
    if (sessionId) headers.Cookie = `JSESSIONID=${sessionId}; schoolname="_${Buffer.from(school).toString("base64")}"`;
    const res = await request(url, { method: "POST", headers, body: JSON.stringify({ id: "quidey", method, params, jsonrpc: "2.0" }) });
    const data = await res.json().catch(() => null);
    if (!data) throw new UntisError("UNTIS_FAILED", `no JSON (${res.status})`);
    if (data.error) {
        // -8504: bad credentials, -8509/-8520: not allowed / not signed in
        const code = data.error.code === -8504 ? "UNTIS_LOGIN_FAILED" : data.error.code === -8509 ? "UNTIS_NOT_ALLOWED" : "UNTIS_FAILED";
        throw new UntisError(code, data.error.message);
    }
    return data.result;
}

async function login({ server, school, username, password }) {
    const result = await rpc(server, school, "authenticate", { user: username, password, client: "Quidey" });
    if (!result?.sessionId) throw new UntisError("UNTIS_LOGIN_FAILED");
    return { sessionId: result.sessionId, personId: result.personId ?? null, personType: result.personType ?? null, klasseId: result.klasseId ?? null };
}

// a student's own timetable (personType 5), else the class's
async function fetchLessons({ server, school, username, password }, fromIso, toIso) {
    const session = await login({ server, school, username, password });
    try {
        const element = session.personId && session.personType
            ? { id: session.personId, type: session.personType }
            : { id: session.klasseId, type: 1 };
        const periods = await rpc(server, school, "getTimetable", {
            options: {
                element, startDate: untisDate(fromIso), endDate: untisDate(toIso),
                showInfo: true, showSubstText: true, showLsText: true,
                klasseFields: ["name"], roomFields: ["name"], subjectFields: ["name", "longname"],
            },
        }, session.sessionId);
        return mergePeriods((Array.isArray(periods) ? periods : []).map(periodToLesson).filter(Boolean));
    } finally {
        await rpc(server, school, "logout", {}, session.sessionId).catch(() => {});
    }
}

const first = (list, field = "name") => (Array.isArray(list) && list[0] && typeof list[0][field] === "string" ? list[0][field] : "");
const clip = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

function periodToLesson(period) {
    if (!period || !Number.isInteger(period.date) || !Number.isInteger(period.startTime) || !Number.isInteger(period.endTime)) return null;
    const startMin = minutesOf(period.startTime);
    const endMin = minutesOf(period.endTime);
    if (endMin <= startMin) return null;
    return {
        externalId: `p${period.id}`,
        day: isoDate(period.date),
        startMin, endMin,
        subject: clip(first(period.su), 40) || clip(period.lstext, 40) || clip(period.activityType, 40) || "Unterricht",
        subjectLong: clip(first(period.su, "longname"), 100),
        room: clip(first(period.ro), 40),
        className: clip(first(period.kl), 40),
        status: period.code === "cancelled" ? "cancelled" : period.code === "irregular" ? "irregular" : "normal",
        info: clip([period.substText, period.info].filter(Boolean).join(" · "), 200),
    };
}

// a double lesson comes as two periods: one block when the same subject, room and status follow
// within ten minutes
function mergePeriods(lessons) {
    const sorted = [...lessons].sort((a, b) => a.day.localeCompare(b.day) || a.startMin - b.startMin);
    const out = [];
    for (const lesson of sorted) {
        const last = out[out.length - 1];
        if (last && last.day === lesson.day && last.subject === lesson.subject && last.room === lesson.room
            && last.status === lesson.status && lesson.startMin - last.endMin <= 10 && lesson.startMin >= last.endMin) {
            last.endMin = lesson.endMin;
            if (lesson.info && !last.info.includes(lesson.info)) last.info = clip(`${last.info} · ${lesson.info}`, 200);
        } else {
            out.push({ ...lesson });
        }
    }
    return out;
}

// ---------- homework ----------
// The homework of the last two weeks and the next four (WebUntis' web API, with the login's session):
// [{ id, subject, dueDay 'YYYY-MM-DD', text, remark, completed }]
async function fetchHomework({ server, school, username, password }, fromIso, toIso) {
    const session = await login({ server, school, username, password });
    try {
        const url = `${baseOf(server)}/WebUntis/api/homeworks/lessons?startDate=${untisDate(fromIso)}&endDate=${untisDate(toIso)}`;
        const res = await request(url, { headers: { Cookie: `JSESSIONID=${session.sessionId}; schoolname="_${Buffer.from(school).toString("base64")}"`, "X-Requested-With": "XMLHttpRequest" } });
        if (!res.ok) throw new UntisError(res.status === 401 || res.status === 403 ? "UNTIS_NOT_ALLOWED" : "UNTIS_FAILED", `homework ${res.status}`);
        const data = (await res.json().catch(() => null))?.data;
        const subjects = new Map((Array.isArray(data?.lessons) ? data.lessons : []).map(lesson => [lesson.id, clip(lesson.subject, 40)]));
        return (Array.isArray(data?.homeworks) ? data.homeworks : []).filter(h => Number.isInteger(h?.id) && Number.isInteger(h?.dueDate)).map(h => ({
            id: h.id, subject: subjects.get(h.lessonId) || "", dueDay: isoDate(h.dueDate),
            text: clip(h.text, 1500), remark: clip(h.remark, 500), completed: Boolean(h.completed),
        }));
    } finally {
        await rpc(server, school, "logout", {}, session.sessionId).catch(() => {});
    }
}

// ---------- iCal ----------
function validIcalUrl(value) {
    let url;
    try { url = new URL(String(value).trim()); } catch { return null; }
    if (url.protocol !== "https:" || !HOST.test(url.hostname) || url.username || url.password) return null;
    return url.toString();
}

async function fetchIcal(urlText, timeZone = "Europe/Berlin") {
    const url = new URL(urlText);
    const target = testBase() ? `${testBase()}${url.pathname}${url.search}` : url.toString();
    const res = await request(target);
    if (!res.ok) throw new UntisError(res.status === 401 || res.status === 403 ? "UNTIS_NOT_ALLOWED" : "UNTIS_FAILED", `iCal ${res.status}`);
    const text = await res.text();
    if (text.length > 5_000_000 || !text.includes("BEGIN:VCALENDAR")) throw new UntisError("UNTIS_FAILED", "not an iCal file");
    return parseIcal(text, timeZone);
}

const unescapeIcal = (value) => value.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");

// the VEVENTs of an iCal file as lessons; times as written (the school's local time), UTC ones
// ("Z") turned into the given time zone
function parseIcal(text, timeZone = "Europe/Berlin") {
    const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
    const lessons = [];
    let event = null;
    for (const line of lines) {
        if (line === "BEGIN:VEVENT") { event = {}; continue; }
        if (line === "END:VEVENT") {
            const lesson = event && eventToLesson(event, timeZone);
            if (lesson) lessons.push(lesson);
            event = null;
            continue;
        }
        if (!event) continue;
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const [name] = line.slice(0, colon).split(";");
        event[name.toUpperCase()] = { params: line.slice(0, colon), value: line.slice(colon + 1) };
    }
    return mergePeriods(lessons);
}

function localParts(value, timeZone) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
    if (!m) return null;
    if (!m[4]) return { day: `${m[1]}-${m[2]}-${m[3]}`, minutes: null };
    if (!m[7]) return { day: `${m[1]}-${m[2]}-${m[3]}`, minutes: Number(m[4]) * 60 + Number(m[5]) };
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(date).map(part => [part.type, part.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function eventToLesson(event, timeZone) {
    const start = event.DTSTART && localParts(event.DTSTART.value, timeZone);
    const end = event.DTEND && localParts(event.DTEND.value, timeZone);
    if (!start || !end || start.minutes == null || end.minutes == null || start.day !== end.day || end.minutes <= start.minutes) return null;
    const summary = clip(unescapeIcal(event.SUMMARY?.value ?? ""), 100);
    const cancelled = /CANCELLED/i.test(event.STATUS?.value ?? "") || /^(entfall|entfällt|cancelled|fällt aus)/i.test(summary);
    return {
        externalId: `i${clip(event.UID?.value ?? `${start.day}-${start.minutes}-${summary}`, 180)}`,
        day: start.day, startMin: start.minutes, endMin: end.minutes,
        subject: clip(summary.replace(/^(entfall|entfällt|cancelled|fällt aus)[:\s-]*/i, ""), 40) || "Unterricht",
        subjectLong: summary,
        room: clip(unescapeIcal(event.LOCATION?.value ?? ""), 40),
        className: "",
        status: cancelled ? "cancelled" : "normal",
        info: clip(unescapeIcal(event.DESCRIPTION?.value ?? ""), 200),
    };
}

// ---------- the password, encrypted ----------
function secretKey() {
    const secret = process.env.UNTIS_SECRET;
    if (!secret || secret.length < 32) return null;
    return crypto.createHash("sha256").update(secret).digest();
}

const canStorePasswords = () => Boolean(secretKey());

function seal(text) {
    const key = secretKey();
    if (!key) throw new UntisError("UNTIS_UNAVAILABLE");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(part => part.toString("base64")).join(":");
}

function open(sealed) {
    const key = secretKey();
    if (!key) throw new UntisError("UNTIS_UNAVAILABLE");
    const [iv, tag, data] = String(sealed).split(":").map(part => Buffer.from(part, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

module.exports = {
    UntisError, validServer, validIcalUrl, searchSchools, login, fetchLessons, fetchHomework, fetchIcal,
    parseIcal, periodToLesson, mergePeriods, canStorePasswords, seal, open,
};
