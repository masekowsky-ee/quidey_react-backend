// Reminders by mail: once a minute the server looks for open tasks with "also by mail" whose
// reminder time has come, and mails their owner. A task's start is its day and time in the
// owner's time zone (users.timezone, sent by the app; Europe/Berlin until then); one without a
// time of day starts at the owner's all-day time (users.allday_reminder_time). A task can have
// several reminders (tasks.reminders, minutes before the start).
//
// Every reminder is mailed once: reminder_mailed_at stores the reminder time it was mailed for;
// only a later one follows, and a task that moved (mailed for a time after its new start) is
// reminded again. Of several due at once (server was down) only the latest is mailed. The row is
// marked in the same statement that picks it (SKIP LOCKED), so two servers never send twice.
// A reminder that is more than LATE_LIMIT past the task's start is dropped.
// Only verified accounts with beta access get mails.

const { sendReminderMail } = require("./mailer");
const { APP_ACCESS_SQL } = require("./access");

const DEFAULT_TIMEZONE = "Europe/Berlin";
const LATE_LIMIT = "15 minutes";

const PICK_DUE_REMINDERS = `
    UPDATE tasks SET reminder_mailed_at = ready.remind_at
    FROM (
        SELECT tasks.id, times.remind_at, users.email, users.language,
            COALESCE(users.timezone, '${DEFAULT_TIMEZONE}') AS timezone
        FROM tasks
        JOIN users ON users.id = tasks.user_id
        CROSS JOIN LATERAL (
            SELECT (tasks.due + COALESCE(tasks.due_time, users.allday_reminder_time))
                AT TIME ZONE COALESCE(users.timezone, '${DEFAULT_TIMEZONE}') AS starts_at
        ) AS starts
        CROSS JOIN LATERAL (
            SELECT starts.starts_at - make_interval(mins => minutes) AS remind_at
            FROM unnest(tasks.reminders) AS minutes
            WHERE starts.starts_at - make_interval(mins => minutes) <= now()
            ORDER BY remind_at DESC
            LIMIT 1
        ) AS times
        WHERE tasks.reminder_email AND NOT tasks.done AND tasks.due IS NOT NULL
            -- reminders reach at most a week ahead; a day of slack either way for the time zones
            AND tasks.due BETWEEN current_date - 2 AND current_date + 9
            AND users.email_verified AND ${APP_ACCESS_SQL}
            AND now() < starts.starts_at + interval '${LATE_LIMIT}'
            AND (tasks.reminder_mailed_at IS NULL OR tasks.reminder_mailed_at < times.remind_at
                OR tasks.reminder_mailed_at > starts.starts_at)
        FOR UPDATE OF tasks SKIP LOCKED
    ) AS ready
    WHERE tasks.id = ready.id
    RETURNING tasks.id, tasks.name, to_char(tasks.due, 'YYYY-MM-DD') AS due,
        to_char(tasks.due_time, 'HH24:MI') AS due_time, tasks.duration_minutes,
        tasks.location, tasks.link, tasks.description,
        ready.email, ready.language, ready.timezone`;

// Sends the reminders that are due now; returns how many
async function sendDueReminderMails(pool) {
    const result = await pool.query(PICK_DUE_REMINDERS);
    for (const row of result.rows) {
        try {
            await sendReminderMail(row, { email: row.email, language: row.language, timezone: row.timezone });
        } catch (err) {
            // already marked: a failing mail server must not send the same reminder every minute
            console.error(`Reminder mail for task ${row.id} failed:`, err);
        }
    }
    return result.rows.length;
}

// Checks every `everyMs` (first check right away); returns a function that stops it
function startReminderMails(pool, everyMs = 60 * 1000) {
    let running = false;
    const check = async () => {
        if (running) return;
        running = true;
        try {
            await sendDueReminderMails(pool);
        } catch (err) {
            console.error("Reminder check failed:", err);
        } finally {
            running = false;
        }
    };
    check();
    const timer = setInterval(check, everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
}

module.exports = { startReminderMails, sendDueReminderMails, DEFAULT_TIMEZONE };
