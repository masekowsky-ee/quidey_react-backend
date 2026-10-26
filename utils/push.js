// Push notifications (Web Push): the phone or computer shows them even while the app is closed.
// A device that turned them on in the app's settings has a row in push_subscriptions: the push
// service's address (Google, Apple, Mozilla, … — chosen by the browser) and the keys the message
// is encrypted with, so the push service only passes on ciphertext.
//
// The server signs every message with its VAPID key pair (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY,
// made once with `npx web-push generate-vapid-keys`; VAPID_SUBJECT is a mailto: or https: address
// the push services can reach the operator at). Without the keys nothing is sent: each message is
// only logged ("[DEV] Push …"), like the mails without SMTP_HOST.
//
// Kinds, each switched on or off per device (columns of push_subscriptions):
//   plan      my tasks and events at each of their reminders (tasks.reminders; one without a time
//             of day counts from my all-day time, users.allday_reminder_time)
//   digest    the morning overview of the day (DIGEST_FROM in my time zone)
//   messages  direct messages
//   social    friend requests, invites, tasks shared with / given to me, news from the team
// Only accounts with app access get anything (closed beta). A device the push service no longer
// knows (404 / 410) is forgotten.

const webpush = require("web-push");
const { APP_ACCESS_SQL } = require("./access");
const { DEFAULT_TIMEZONE } = require("./reminderMails");

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:contact@quidey.com";
const ENABLED = Boolean(PUBLIC_KEY && PRIVATE_KEY);
if (ENABLED) webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);

const KINDS = ["plan", "digest", "messages", "social"];
const MAX_DEVICES = 10;
// a reminder more than this late (server was down, phone offline) isn't worth it any more
const LATE_LIMIT = "1 hour";
const DIGEST_FROM = "07:30";
const DIGEST_UNTIL = "11:00";
// how long the push service keeps a message for a phone that is offline (seconds)
const TTL = { plan: 60 * 60, digest: 3 * 60 * 60, messages: 24 * 60 * 60, social: 24 * 60 * 60 };

const lang = (language) => (language === "en" ? "en" : "de");
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// "15 Min." / "2 Std." / "1 Tag": how long before the start a reminder comes
function ahead(minutes, language) {
    const en = language === "en";
    if (minutes % 1440 === 0) {
        const days = minutes / 1440;
        return en ? `${days} ${days === 1 ? "day" : "days"}` : `${days} ${days === 1 ? "Tag" : "Tagen"}`;
    }
    if (minutes % 60 === 0) return en ? `${minutes / 60} h` : `${minutes / 60} Std.`;
    return en ? `${minutes} min` : `${minutes} Min.`;
}

// The texts, in the reader's language. Each returns { title, body, url, tag }; the tag makes a
// newer notification about the same thing replace the older one on the device.
const TEXTS = {
    entry(task, language) {
        const en = language === "en";
        const event = task.kind === "event";
        const where = task.location ? ` · ${task.location}` : "";
        let body;
        if (!task.due_time) {
            // the whole day: how many days ahead it is, seen from where I am
            const days = task.days_ahead;
            body = event
                ? (days <= 0 ? (en ? "Today" : "Heute") : days === 1 ? (en ? "Tomorrow" : "Morgen") : (en ? `In ${days} days` : `In ${days} Tagen`))
                : (days <= 0 ? (en ? "Due today" : "Heute fällig") : days === 1 ? (en ? "Due tomorrow" : "Morgen fällig") : (en ? `Due in ${days} days` : `In ${days} Tagen fällig`));
        } else if (task.reminder_minutes > 0) {
            const word = event ? (en ? "Event" : "Termin") : (en ? "Task" : "Aufgabe");
            body = en ? `${word} at ${task.due_time}, in ${ahead(task.reminder_minutes, language)}` : `${word} um ${task.due_time}, in ${ahead(task.reminder_minutes, language)}`;
        } else {
            body = event ? (en ? `Starts now (${task.due_time})` : `Beginnt jetzt (${task.due_time})`) : (en ? `Now: ${task.due_time}` : `Jetzt dran: ${task.due_time}`);
        }
        return { title: clip(task.name, 120), body: body + where, url: event ? "/calendar" : "/", tag: `task-${task.id}` };
    },
    digest({ tasks, events, overdue, firstEvent }, language) {
        const en = language === "en";
        const parts = [];
        if (tasks) parts.push(en ? `${tasks} ${tasks === 1 ? "task" : "tasks"}` : `${tasks} ${tasks === 1 ? "Aufgabe" : "Aufgaben"}`);
        if (events) parts.push(en ? `${events} ${events === 1 ? "event" : "events"} (first at ${firstEvent})` : `${events} ${events === 1 ? "Termin" : "Termine"} (ab ${firstEvent})`);
        if (overdue) parts.push(en ? `${overdue} overdue` : `${overdue} überfällig`);
        return { title: en ? "Your day" : "Dein Tag", body: (en ? "Today: " : "Heute: ") + parts.join(", "), url: "/", tag: "digest" };
    },
    message({ from, body }) {
        return { title: from.displayName || from.username, body: clip(body, 180), url: `/inbox?with=${from.id}`, tag: `dm-${from.id}`, renotify: true };
    },
    friendRequest({ from }, language) {
        const name = from.displayName || from.username;
        return language === "en"
            ? { title: "Friend request", body: `${name} wants to study with you.`, url: "/community/friends?tab=requests", tag: `friend-${from.id}` }
            : { title: "Freundschaftsanfrage", body: `${name} möchte mit dir lernen.`, url: "/community/friends?tab=requests", tag: `friend-${from.id}` };
    },
    sessionInvite({ from, name }, language) {
        const who = from.displayName || from.username;
        return language === "en"
            ? { title: "Invite to a session", body: `${who} invites you to “${name}”.`, url: "/community/sessions", tag: "session-invite" }
            : { title: "Einladung zur Sitzung", body: `${who} lädt dich zu „${name}“ ein.`, url: "/community/sessions", tag: "session-invite" };
    },
    familyInvite({ from, name }, language) {
        const who = from.displayName || from.username;
        return language === "en"
            ? { title: "Invite to a family", body: `${who} invites you to “${name}”.`, url: "/community/family", tag: "family-invite" }
            : { title: "Einladung in eine Family", body: `${who} lädt dich in „${name}“ ein.`, url: "/community/family", tag: "family-invite" };
    },
    taskShared({ from, name }, language) {
        const who = from.displayName || from.username;
        return language === "en"
            ? { title: "A task for you", body: `${who} sent you “${clip(name, 80)}”.`, url: "/inbox?tab=requests", tag: "task-share" }
            : { title: "Eine Aufgabe für dich", body: `${who} hat dir „${clip(name, 80)}“ geschickt.`, url: "/inbox?tab=requests", tag: "task-share" };
    },
    taskAssigned({ from, name, session, sessionId }, language) {
        const who = from.displayName || from.username;
        return language === "en"
            ? { title: "A task for you", body: `${who} gave you “${clip(name, 80)}” in “${session}”.`, url: `/together/${sessionId}`, tag: `assigned-${sessionId}` }
            : { title: "Eine Aufgabe für dich", body: `${who} hat dir „${clip(name, 80)}“ in „${session}“ gegeben.`, url: `/together/${sessionId}`, tag: `assigned-${sessionId}` };
    },
    broadcast({ title, body }) {
        return { title: clip(title, 120), body: clip(body, 180), url: "/inbox?tab=notices", tag: "broadcast" };
    },
};

// Sends one message to one device; forgets the device when the push service says it's gone.
// Returns true when it was handed over.
async function deliver(pool, device, kind, message) {
    const payload = { ...message, kind };
    if (!ENABLED) {
        console.log(`[DEV] Push to user ${device.user_id} (${kind}): ${payload.title} — ${payload.body}`);
        return true;
    }
    try {
        await webpush.sendNotification(
            { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
            JSON.stringify(payload),
            { TTL: TTL[kind] ?? 3600, urgency: kind === "digest" ? "normal" : "high" }
        );
        return true;
    } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
            await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [device.id]).catch(() => {});
        } else {
            console.error(`Push to device ${device.id} failed:`, err.statusCode ?? "", err.body ?? err.message);
        }
        return false;
    }
}

// Sends a message of `kind` to every device of these accounts that wants that kind.
// build(language, userId) makes the message. Never throws (a push is never worth an error).
async function pushToUsers(pool, userIds, kind, build) {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (ids.length === 0 || !KINDS.includes(kind)) return 0;
    try {
        const devices = await pool.query(
            `SELECT push_subscriptions.id, push_subscriptions.user_id, push_subscriptions.endpoint,
                push_subscriptions.p256dh, push_subscriptions.auth, users.language
            FROM push_subscriptions JOIN users ON users.id = push_subscriptions.user_id
            WHERE push_subscriptions.user_id = ANY($1::int[]) AND push_subscriptions.${kind} AND ${APP_ACCESS_SQL}`,
            [ids]
        );
        const sent = await Promise.all(devices.rows.map((device) => deliver(pool, device, kind, build(lang(device.language), device.user_id))));
        return sent.filter(Boolean).length;
    } catch (err) {
        console.error("Push failed:", err);
        return 0;
    }
}

// The same, fire and forget, for the routes (the answer never waits for the push services)
const pushLater = (pool, userIds, kind, build) => {
    pushToUsers(pool, userIds, kind, build);
};

// Tasks and events whose push is due: at each of their reminders (tasks.reminders, minutes
// before the start), in the owner's time zone. A task without a time of day starts at the
// owner's all-day time (users.allday_reminder_time). Of several reminders due at once (the
// server was down) only the latest goes out. Each task is marked with the time it was pushed
// for in the same statement that picks it (SKIP LOCKED): a reminder goes out once, only
// later ones follow, and after the task moved (it was pushed for a time after its new start)
// its reminders come again. Only owners with a device that wants "plan".
const PICK_DUE_ENTRIES = `
    UPDATE tasks SET push_sent_for = ready.push_at
    FROM (
        SELECT tasks.id, times.push_at, times.minutes,
            tasks.due - (times.push_at AT TIME ZONE starts.timezone)::date AS days_ahead
        FROM tasks
        JOIN users ON users.id = tasks.user_id
        CROSS JOIN LATERAL (
            SELECT (tasks.due + COALESCE(tasks.due_time, users.allday_reminder_time)) AT TIME ZONE COALESCE(users.timezone, '${DEFAULT_TIMEZONE}') AS starts_at,
                COALESCE(users.timezone, '${DEFAULT_TIMEZONE}') AS timezone
        ) AS starts
        CROSS JOIN LATERAL (
            SELECT starts.starts_at - make_interval(mins => reminder.minutes) AS push_at, reminder.minutes
            FROM unnest(tasks.reminders) AS reminder(minutes)
            WHERE starts.starts_at - make_interval(mins => reminder.minutes) <= now()
                AND now() < starts.starts_at - make_interval(mins => reminder.minutes) + interval '${LATE_LIMIT}'
            ORDER BY push_at DESC
            LIMIT 1
        ) AS times
        -- an event is ticked off by the server once it's over, which for one without a length
        -- is its start: it is pushed all the same
        WHERE (NOT tasks.done OR tasks.kind = 'event') AND tasks.due IS NOT NULL
            -- reminders reach at most a week ahead; a day of slack either way for the time zones
            AND tasks.due BETWEEN current_date - 2 AND current_date + 9
            AND ${APP_ACCESS_SQL}
            AND EXISTS (SELECT 1 FROM push_subscriptions WHERE push_subscriptions.user_id = tasks.user_id AND push_subscriptions.plan)
            AND now() < starts.starts_at + interval '15 minutes'
            AND (tasks.push_sent_for IS NULL OR tasks.push_sent_for < times.push_at OR tasks.push_sent_for > starts.starts_at)
        FOR UPDATE OF tasks SKIP LOCKED
    ) AS ready
    WHERE tasks.id = ready.id
    RETURNING tasks.id, tasks.user_id, tasks.name, tasks.kind, tasks.location, ready.minutes AS reminder_minutes,
        ready.days_ahead, to_char(tasks.due_time, 'HH24:MI') AS due_time`;

async function pushDueEntries(pool) {
    const due = await pool.query(PICK_DUE_ENTRIES);
    for (const task of due.rows) {
        await pushToUsers(pool, [task.user_id], "plan", (language) => TEXTS.entry(task, language));
    }
    return due.rows.length;
}

// The morning overview: once a day between DIGEST_FROM and DIGEST_UNTIL in my time zone, what
// is open today (tasks, events, overdue). The day is marked first, so it comes once even with
// nothing to say (then nothing is sent).
const PICK_DIGESTS = `
    UPDATE users SET push_digest_on = ready.today
    FROM (
        SELECT users.id, (now() AT TIME ZONE COALESCE(users.timezone, '${DEFAULT_TIMEZONE}'))::date AS today
        FROM users
        WHERE ${APP_ACCESS_SQL}
            AND EXISTS (SELECT 1 FROM push_subscriptions WHERE push_subscriptions.user_id = users.id AND push_subscriptions.digest)
            AND (now() AT TIME ZONE COALESCE(users.timezone, '${DEFAULT_TIMEZONE}'))::time >= '${DIGEST_FROM}'
            AND (now() AT TIME ZONE COALESCE(users.timezone, '${DEFAULT_TIMEZONE}'))::time < '${DIGEST_UNTIL}'
            AND users.push_digest_on IS DISTINCT FROM (now() AT TIME ZONE COALESCE(users.timezone, '${DEFAULT_TIMEZONE}'))::date
        FOR UPDATE OF users SKIP LOCKED
    ) AS ready
    WHERE users.id = ready.id
    RETURNING users.id, to_char(ready.today, 'YYYY-MM-DD') AS today`;

async function pushDigests(pool) {
    const picked = await pool.query(PICK_DIGESTS);
    for (const user of picked.rows) {
        const counts = (await pool.query(
            `SELECT count(*) FILTER (WHERE kind = 'task' AND due = $2::date)::int AS tasks,
                count(*) FILTER (WHERE kind = 'event' AND due = $2::date)::int AS events,
                count(*) FILTER (WHERE kind = 'task' AND due < $2::date)::int AS overdue,
                to_char(min(due_time) FILTER (WHERE kind = 'event' AND due = $2::date), 'HH24:MI') AS "firstEvent"
            FROM tasks WHERE user_id = $1 AND NOT done AND due <= $2::date`,
            [user.id, user.today]
        )).rows[0];
        if (counts.tasks + counts.events + counts.overdue === 0) continue;
        await pushToUsers(pool, [user.id], "digest", (language) => TEXTS.digest(counts, language));
    }
    return picked.rows.length;
}

// Checks every `everyMs` (first check right away); returns a function that stops it
function startPushSchedule(pool, everyMs = 60 * 1000) {
    let running = false;
    const check = async () => {
        if (running) return;
        running = true;
        try {
            await pushDueEntries(pool);
            await pushDigests(pool);
        } catch (err) {
            console.error("Push check failed:", err);
        } finally {
            running = false;
        }
    };
    check();
    const timer = setInterval(check, everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
}

module.exports = {
    PUSH_ENABLED: ENABLED, PUSH_PUBLIC_KEY: PUBLIC_KEY, PUSH_KINDS: KINDS, PUSH_MAX_DEVICES: MAX_DEVICES, PUSH_TEXTS: TEXTS,
    pushToUsers, pushLater, deliver, startPushSchedule, pushDueEntries, pushDigests,
};
