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
//   social    friend requests, invites, tasks shared with / given to me (in a session or a
//             family), news from the team; for admins also new beta requests
//   groups    somebody else added entries to a family / session I'm in; messages in their chats
//   study     a study goal (exam, assignment, …) is behind its plan: at most one a day,
//             08:00-19:00 in my time zone, see pushStudyBehind
// "plan" also brings the reminders of my families' entries (to every joined member).
// Only accounts with app access get anything (closed beta). A device the push service no longer
// knows (404 / 410) is forgotten.
//
// Devices of the Android app don't use Web Push: their endpoint is 'fcm:<token>' and they get
// their messages through Firebase Cloud Messaging (utils/fcm.js, FIREBASE_SERVICE_ACCOUNT_FILE).

const webpush = require("web-push");
const { APP_ACCESS_SQL } = require("./access");
const { DEFAULT_TIMEZONE } = require("./reminderMails");
const { FCM_ENABLED, isFcmEndpoint, sendFcm } = require("./fcm");
const { loadPlanInput, statusOf } = require("./studyLoad");
const { shouldNotify, pushText } = require("./studyStatus");

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:contact@quidey.com";
const ENABLED = Boolean(PUBLIC_KEY && PRIVATE_KEY);
if (ENABLED) webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
// on the real server that means nobody can turn notifications on (the app says "the server
// isn't sending any"): say so where the operator looks
else if (process.env.NODE_ENV === "production") {
    console.warn("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set: no push notifications are sent. Make a pair with `npx web-push generate-vapid-keys`.");
}

const KINDS = ["plan", "digest", "messages", "social", "groups", "study"];
const MAX_DEVICES = 10;
// a reminder more than this late (server was down, phone offline) isn't worth it any more
const LATE_LIMIT = "1 hour";
const DIGEST_FROM = "07:30";
const DIGEST_UNTIL = "11:00";
// how long the push service keeps a message for a phone that is offline (seconds)
const TTL = { plan: 60 * 60, digest: 3 * 60 * 60, messages: 24 * 60 * 60, social: 24 * 60 * 60, groups: 24 * 60 * 60, study: 3 * 60 * 60 };

// Where a group notice leads: a family's page or a session's
const placeUrl = (place) => (place.kind === "family" ? `/family/${place.id}` : `/together/${place.id}`);

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
    familyAssigned({ from, name, family, familyId }, language) {
        const who = from.displayName || from.username;
        return language === "en"
            ? { title: "A task for you", body: `${who} gave you “${clip(name, 80)}” in “${family}”.`, url: `/family/${familyId}`, tag: `assigned-family-${familyId}` }
            : { title: "Eine Aufgabe für dich", body: `${who} hat dir „${clip(name, 80)}“ in „${family}“ gegeben.`, url: `/family/${familyId}`, tag: `assigned-family-${familyId}` };
    },
    // somebody else put entries into a family / session of mine: place { kind, id, name };
    // count: how many in a row (the device shows only the newest of a place)
    entriesAdded({ from, place, count, name }, language) {
        const who = from.displayName || from.username;
        const en = language === "en";
        const body = count > 1
            ? (en ? `${who} added ${count} entries.` : `${who} hat ${count} Einträge eingetragen.`)
            : (en ? `${who} added “${clip(name, 80)}”.` : `${who} hat „${clip(name, 80)}“ eingetragen.`);
        return { title: clip(en ? `“${place.name}”` : `„${place.name}“`, 120), body, url: placeUrl(place), tag: `entries-${place.kind}-${place.id}`, renotify: true };
    },
    // a message in a family's / session's chat
    chat({ from, place, body }) {
        const who = from.displayName || from.username;
        return { title: clip(`${who} · ${place.name}`, 120), body: clip(body, 180), url: placeUrl(place), tag: `chat-${place.kind}-${place.id}`, renotify: true };
    },
    // a reminder of a family's entry (to every member): like entry, with the family's name
    familyEntry(task, language) {
        const message = TEXTS.entry(task, language);
        return { ...message, body: `${language === "en" ? `“${task.family_name}”` : `„${task.family_name}“`} · ${message.body}`, url: `/family/${task.family_id}`, tag: `family-task-${task.id}` };
    },
    // for the admins: somebody asks to get into the closed beta
    betaRequest({ from, reason }, language) {
        const who = from.displayName || from.username;
        return language === "en"
            ? { title: "New beta request", body: `${who}: ${clip(reason, 160)}`, url: "/admin", tag: "beta-request", renotify: true }
            : { title: "Neue Beta-Anfrage", body: `${who}: ${clip(reason, 160)}`, url: "/admin", tag: "beta-request", renotify: true };
    },
    broadcast({ title, body }) {
        return { title: clip(title, 120), body: clip(body, 180), url: "/inbox?tab=notices", tag: "broadcast" };
    },
};

// Sends one message to one device; forgets the device when the push service says it's gone.
// Returns true when it was handed over.
async function deliver(pool, device, kind, message) {
    const payload = { ...message, kind };
    const fcm = isFcmEndpoint(device.endpoint);
    if (!(fcm ? FCM_ENABLED : ENABLED)) {
        console.log(`[DEV] Push to user ${device.user_id} (${kind}${fcm ? ", app" : ""}): ${payload.title} — ${payload.body}`);
        return true;
    }
    if (fcm) {
        const result = await sendFcm(device.endpoint, kind, message, TTL[kind] ?? 3600);
        if (result === "gone") await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [device.id]).catch(() => {});
        return result === "sent";
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
// { skipAlarms }: not to devices that ring reminders themselves (push_subscriptions.alarms, the
// Android app with exact alarms allowed), so a reminder doesn't come twice there.
async function pushToUsers(pool, userIds, kind, build, { skipAlarms = false } = {}) {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (ids.length === 0 || !KINDS.includes(kind)) return 0;
    try {
        const devices = await pool.query(
            `SELECT push_subscriptions.id, push_subscriptions.user_id, push_subscriptions.endpoint,
                push_subscriptions.p256dh, push_subscriptions.auth, users.language
            FROM push_subscriptions JOIN users ON users.id = push_subscriptions.user_id
            WHERE push_subscriptions.user_id = ANY($1::int[]) AND push_subscriptions.${kind} AND ${APP_ACCESS_SQL}
                ${skipAlarms ? "AND NOT push_subscriptions.alarms" : ""}`,
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

// The same for a family's entries (family_tasks.reminders), in the family owner's time zone and
// all-day time, to every joined member with a device that wants "plan". Each reminder time goes
// out once (push_sent_for, SKIP LOCKED), like an own task's.
const PICK_DUE_FAMILY_ENTRIES = `
    UPDATE family_tasks SET push_sent_for = ready.push_at
    FROM (
        SELECT family_tasks.id, times.push_at, times.minutes,
            family_tasks.due - (times.push_at AT TIME ZONE starts.timezone)::date AS days_ahead
        FROM family_tasks
        JOIN families ON families.id = family_tasks.family_id
        JOIN users ON users.id = families.owner_id
        CROSS JOIN LATERAL (
            SELECT (family_tasks.due + COALESCE(family_tasks.due_time, users.allday_reminder_time)) AT TIME ZONE COALESCE(users.timezone, '${DEFAULT_TIMEZONE}') AS starts_at,
                COALESCE(users.timezone, '${DEFAULT_TIMEZONE}') AS timezone
        ) AS starts
        CROSS JOIN LATERAL (
            SELECT starts.starts_at - make_interval(mins => reminder.minutes) AS push_at, reminder.minutes
            FROM unnest(family_tasks.reminders) AS reminder(minutes)
            WHERE starts.starts_at - make_interval(mins => reminder.minutes) <= now()
                AND now() < starts.starts_at - make_interval(mins => reminder.minutes) + interval '${LATE_LIMIT}'
            ORDER BY push_at DESC
            LIMIT 1
        ) AS times
        WHERE (NOT family_tasks.done OR family_tasks.kind = 'event') AND family_tasks.due IS NOT NULL
            AND family_tasks.due BETWEEN current_date - 2 AND current_date + 9
            AND EXISTS (
                SELECT 1 FROM family_members JOIN push_subscriptions ON push_subscriptions.user_id = family_members.user_id
                WHERE family_members.family_id = family_tasks.family_id AND family_members.status = 'joined' AND push_subscriptions.plan
            )
            AND now() < starts.starts_at + interval '15 minutes'
            AND (family_tasks.push_sent_for IS NULL OR family_tasks.push_sent_for < times.push_at OR family_tasks.push_sent_for > starts.starts_at)
        FOR UPDATE OF family_tasks SKIP LOCKED
    ) AS ready
    WHERE family_tasks.id = ready.id
    RETURNING family_tasks.id, family_tasks.family_id, family_tasks.name, family_tasks.kind, family_tasks.location,
        ready.minutes AS reminder_minutes, ready.days_ahead, to_char(family_tasks.due_time, 'HH24:MI') AS due_time,
        (SELECT name FROM families WHERE families.id = family_tasks.family_id) AS family_name`;

async function pushFamilyEntries(pool) {
    const due = await pool.query(PICK_DUE_FAMILY_ENTRIES);
    for (const entry of due.rows) {
        const members = await pool.query(
            "SELECT user_id FROM family_members WHERE family_id = $1 AND status = 'joined'",
            [entry.family_id]
        );
        await pushToUsers(pool, members.rows.map(row => row.user_id), "plan", (language) => TEXTS.familyEntry(entry, language));
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

// Study goals that are behind their plan: at most one push per user and day, 08:00-19:00 in my time
// zone (shouldNotify decides), and only when the deficit is new or grew by a whole session. One push
// for all goals that qualify; their behind_notified_minutes / behind_notified_on are set when it went
// out, a goal that is not behind any more is reset to 0. Everybody with app access, an active goal and a device that
// wants "study". `now` is for the tests. Returns how many users were notified.
async function pushStudyBehind(pool, now = new Date()) {
    const users = await pool.query(
        `SELECT users.id, users.language FROM users
        WHERE ${APP_ACCESS_SQL}
            AND EXISTS (SELECT 1 FROM goals WHERE goals.user_id = users.id AND goals.status = 'active')
            AND EXISTS (SELECT 1 FROM push_subscriptions WHERE push_subscriptions.user_id = users.id AND push_subscriptions.study)`
    );
    let notified = 0;
    for (const user of users.rows) {
        try {
            const loaded = await loadPlanInput(pool, user.id, now);
            const { today, nowMinutes, sessionMinutes } = loaded.clock;
            const marks = new Map((await pool.query(
                "SELECT id, behind_notified_minutes, behind_notified_on = $2::date AS today FROM goals WHERE user_id = $1",
                [user.id, today]
            )).rows.map((row) => [row.id, row]));
            const rows = statusOf(loaded).map(({ g, status }) => ({
                id: g.goal.id, name: g.goal.name, behindMinutes: status.behindMinutes,
                notifiedMinutes: marks.get(g.goal.id)?.behind_notified_minutes ?? 0,
            }));
            const sentToday = rows.some((row) => marks.get(row.id)?.today);
            const recovered = rows.filter((row) => row.behindMinutes === 0 && row.notifiedMinutes !== 0).map((row) => row.id);
            if (recovered.length) {
                await pool.query("UPDATE goals SET behind_notified_minutes = 0 WHERE user_id = $1 AND id = ANY($2::int[])", [user.id, recovered]);
            }
            const due = rows.filter((row) => shouldNotify({ deficit: row.behindMinutes, notifiedMinutes: row.notifiedMinutes, sentToday, nowMinutes, sessionMinutes }));
            if (due.length === 0) continue;
            const sent = await pushToUsers(pool, [user.id], "study", (language) => ({
                ...pushText(due.map((row) => ({ name: row.name, behindMinutes: row.behindMinutes })), language),
                url: "/study?replan=1", tag: "study",
            }));
            if (sent === 0) continue; // nowhere to deliver: try again later
            for (const row of due) {
                await pool.query(
                    "UPDATE goals SET behind_notified_minutes = $3, behind_notified_on = $4::date WHERE id = $1 AND user_id = $2",
                    [row.id, user.id, row.behindMinutes, today]
                );
            }
            notified++;
        } catch (err) {
            console.error(`Study push for user ${user.id} failed:`, err);
        }
    }
    return notified;
}

// Checks every `everyMs` (first check right away); returns a function that stops it
function startPushSchedule(pool, everyMs = 60 * 1000) {
    let running = false;
    const check = async () => {
        if (running) return;
        running = true;
        try {
            await pushDueEntries(pool);
            await pushFamilyEntries(pool);
            await pushDigests(pool);
            await pushStudyBehind(pool);
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
    PUSH_ENABLED: ENABLED, PUSH_PUBLIC_KEY: PUBLIC_KEY, PUSH_FCM_ENABLED: FCM_ENABLED, PUSH_KINDS: KINDS, PUSH_MAX_DEVICES: MAX_DEVICES, PUSH_TEXTS: TEXTS,
    pushToUsers, pushLater, deliver, startPushSchedule, pushDueEntries, pushFamilyEntries, pushDigests, pushStudyBehind,
};
