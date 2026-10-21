// Reminders by mail: once a minute the server looks for open tasks with "also by mail" whose
// reminder time has come, and mails their owner. A task's start is its day and time in the
// owner's time zone (users.timezone, sent by the app; Europe/Berlin until then).
//
// Every reminder is mailed once: reminder_mailed_at stores the reminder time it was mailed for,
// so moving the task or changing its reminder gives a new time and a new mail. The row is
// marked in the same statement that picks it (SKIP LOCKED), so two servers never send twice.
// A reminder that is more than LATE_LIMIT past the task's start (server was down) is dropped.
// Only verified accounts with beta access get mails.

const { sendReminderMail } = require("./mailer");

const DEFAULT_TIMEZONE = "Europe/Berlin";
const LATE_LIMIT = "15 minutes";

const PICK_DUE_REMINDERS = `
    UPDATE tasks SET reminder_mailed_at = ready.remind_at
    FROM (
        SELECT tasks.id, starts.remind_at, users.email, users.language,
            COALESCE(users.timezone, '${DEFAULT_TIMEZONE}') AS timezone
        FROM tasks
        JOIN users ON users.id = tasks.user_id
        CROSS JOIN LATERAL (
            SELECT ((tasks.due + tasks.due_time) AT TIME ZONE COALESCE(users.timezone, '${DEFAULT_TIMEZONE}'))
                - make_interval(mins => tasks.reminder_minutes) AS remind_at,
                (tasks.due + tasks.due_time) AT TIME ZONE COALESCE(users.timezone, '${DEFAULT_TIMEZONE}') AS starts_at
        ) AS starts
        WHERE tasks.reminder_email AND NOT tasks.done
            AND tasks.due_time IS NOT NULL AND tasks.reminder_minutes IS NOT NULL
            -- reminders reach at most a week ahead; a day of slack either way for the time zones
            AND tasks.due BETWEEN current_date - 2 AND current_date + 9
            AND users.email_verified AND (users.is_pro OR users.is_admin)
            AND starts.remind_at <= now() AND now() < starts.starts_at + interval '${LATE_LIMIT}'
            AND tasks.reminder_mailed_at IS DISTINCT FROM starts.remind_at
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
