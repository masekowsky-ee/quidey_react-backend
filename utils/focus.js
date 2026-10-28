// The Fokusraum's push notifications: the end of a countdown or Pomodoro phase, and routines at
// the time they are planned for. Both go out as kind "plan" (like the reminders of tasks), so a
// device that switched those off gets none of these either.
//
// Focus alarm: the app sets focus_alarms when a countdown starts (PUT /api/focus/alarm) and takes
// it away on pause or stop. A phone whose screen is off runs no JavaScript, so without this
// nobody would hear that the 25 minutes are over. Checked every FOCUS_CHECK_MS (a few seconds:
// it should come on time); one that is more than LATE_LIMIT late is dropped without a push.
//
// Routines: on each planned weekday (days, 1 = Monday) at at_time in my time zone, once a day
// (reminded_on), within an hour after the time.

const { pushToUsers } = require("./push");
const { APP_ACCESS_SQL } = require("./access");
const { DEFAULT_TIMEZONE } = require("./reminderMails");

const LATE_LIMIT = "10 minutes";

const TEXTS = {
    focus(phase, language) {
        const en = language === "en";
        const texts = {
            timer: en ? ["Time's up", "Your focus time is over. Well done!"] : ["Zeit ist um", "Deine Fokuszeit ist vorbei. Gut gemacht!"],
            focus: en ? ["Break time", "One Pomodoro done. Stand up, drink something."] : ["Pause!", "Ein Pomodoro geschafft. Steh kurz auf, trink was."],
            short: en ? ["Break's over", "Ready for the next round?"] : ["Pause vorbei", "Bereit für die nächste Runde?"],
            long: en ? ["Break's over", "Rested? On to the next cycle."] : ["Pause vorbei", "Erholt? Auf in die nächste Runde."],
        };
        const [title, body] = texts[phase] ?? texts.timer;
        return { title, body, url: "/focus", tag: "focus", renotify: true };
    },
    routine(routine, language) {
        const en = language === "en";
        const name = `${routine.emoji ? `${routine.emoji} ` : ""}${routine.name}`;
        const steps = routine.steps_count;
        return {
            title: en ? `Time for: ${name}` : `Zeit für: ${name}`,
            body: en ? `${steps} ${steps === 1 ? "step" : "steps"}. Tap to start, Quidey guides you through.`
                : `${steps} ${steps === 1 ? "Schritt" : "Schritte"}. Tippen zum Starten, Quidey führt dich durch.`,
            url: `/routines/${routine.id}/run`,
            tag: `routine-${routine.id}`,
        };
    },
};

const PICK_ALARMS = `
    DELETE FROM focus_alarms
    WHERE fire_at <= now()
    RETURNING user_id, phase, fire_at > now() - interval '${LATE_LIMIT}' AS in_time`;

async function pushFocusAlarms(pool) {
    const due = await pool.query(PICK_ALARMS);
    for (const alarm of due.rows) {
        if (!alarm.in_time) continue;
        await pushToUsers(pool, [alarm.user_id], "plan", (language) => TEXTS.focus(alarm.phase, language));
    }
    return due.rows.length;
}

const PICK_ROUTINES = `
    UPDATE routines SET reminded_on = ready.today
    FROM (
        SELECT routines.id, local.today
        FROM routines
        JOIN users ON users.id = routines.user_id
        CROSS JOIN LATERAL (
            SELECT (now() AT TIME ZONE COALESCE(users.timezone, '${DEFAULT_TIMEZONE}')) AS at
        ) AS now_local
        CROSS JOIN LATERAL (
            SELECT now_local.at::date AS today, now_local.at::time AS time, extract(isodow FROM now_local.at)::smallint AS weekday
        ) AS local
        WHERE routines.remind AND routines.at_time IS NOT NULL
            AND local.weekday = ANY(routines.days)
            AND local.time - routines.at_time >= interval '0'
            AND local.time - routines.at_time < interval '1 hour'
            AND routines.reminded_on IS DISTINCT FROM local.today
            AND ${APP_ACCESS_SQL}
        FOR UPDATE OF routines SKIP LOCKED
    ) AS ready
    WHERE routines.id = ready.id
    RETURNING routines.id, routines.user_id, routines.name, routines.emoji, jsonb_array_length(routines.steps) AS steps_count`;

async function pushRoutines(pool) {
    const due = await pool.query(PICK_ROUTINES);
    for (const routine of due.rows) {
        await pushToUsers(pool, [routine.user_id], "plan", (language) => TEXTS.routine(routine, language));
    }
    return due.rows.length;
}

// Alarms every `everyMs`, routines with them (cheap: both look at a handful of rows)
function startFocusSchedule(pool, everyMs = 5000) {
    let running = false;
    const check = async () => {
        if (running) return;
        running = true;
        try {
            await pushFocusAlarms(pool);
            await pushRoutines(pool);
        } catch (err) {
            console.error("Focus check failed:", err);
        } finally {
            running = false;
        }
    };
    check();
    const timer = setInterval(check, everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
}

module.exports = { FOCUS_TEXTS: TEXTS, startFocusSchedule, pushFocusAlarms, pushRoutines };
