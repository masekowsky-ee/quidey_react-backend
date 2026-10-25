// Levels, XP, challenges and the feed entries they make ("Gemeinschaft").
//
// XP is never stored as a running total: it follows from what is there (focus minutes, tasks
// done) plus the challenges completed, which are stored once per period with their XP. So
// deleting a session takes its XP away again, and nothing can drift out of step.
// users.level keeps the highest level reached: rising past it is announced in the feed once, and
// what a level unlocked stays unlocked.
//
// The same lists live in the frontend (src/features/progress/progress.js): keep them in step.

// 1 XP per minute of focus (solo sessions and the team stopwatch), at most this much per day
const DAY_FOCUS_XP_MAX = 600;
// 5 XP per task ticked off (events don't count, they end by themselves), at most 30 a day
const TASK_XP = 5;
const DAY_TASKS_MAX = 30;

// XP from level n to n + 1: 150, 225, 300, ... (level 10 at 4,050 XP, level 20 at 15,675)
const levelStepXp = (level) => 150 + 75 * (level - 1);
// total XP at which a level starts
const levelStartXp = (level) => 150 * (level - 1) + 37.5 * (level - 1) * (level - 2);

// The highest level (at 95,550 XP). The owner's account (users.is_owner, admin for good) is
// always on it, with everything unlocked.
const MAX_LEVEL = 50;

function levelForXp(xp) {
    let level = 1;
    while (level < MAX_LEVEL && xp >= levelStartXp(level + 1)) level++;
    return level;
}

// ---------- unlocks ----------
// What a profile can be set up with, and from which level. A value chosen before it was locked
// (or at a level reached once) stays allowed.

const PROFILE_COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "violet", "pink"];
const PROFILE_BANNERS = ["gradient", "aurora", "dots", "stripes", "grid", "glow", "rings", "topo", "sky"];
const PROFILE_EMOJIS = [
    "📚", "✏️", "🎧", "☕", "🌱", "🔥", "⭐", "🚀", "🧠", "🎯",
    "🌙", "☀️", "🐱", "🐶", "🦊", "🐼", "🐸", "🦉", "🌸", "🍀",
    "🎨", "🎸", "⚽", "💻", "🧪", "📐", "🌍", "🎮", "🍕", "🦄",
    "🪐", "🐉", "🦋", "🌊", "🏔️", "🎻", "🧩", "🪴", "🦕", "👾",
];
const AVATAR_FRAMES = ["ring", "double", "dotted", "orbit"];
const PROFILE_TITLES = ["seed", "sprout", "planner", "sapling", "nightOwl", "earlyBird", "teamPlayer",
    "shrub", "deepFocus", "tree", "marathon", "grove", "mentor", "forest", "ancient"];
const SHOWCASE_MAX = 3;

const BANNER_LEVELS = { gradient: 1, dots: 1, stripes: 5, grid: 5, aurora: 8, glow: 8, rings: 14, topo: 18, sky: 24 };
const FRAME_LEVELS = { ring: 10, double: 16, dotted: 22, orbit: 30 };
// the level names (the tiers) become titles once reached; titles themselves come at level 5
const TIERS = [
    { id: "seed", level: 1 }, { id: "sprout", level: 3 }, { id: "sapling", level: 6 }, { id: "shrub", level: 10 },
    { id: "tree", level: 15 }, { id: "grove", level: 20 }, { id: "forest", level: 30 }, { id: "ancient", level: 40 },
];
const TITLES_FROM = 5;
const TITLE_LEVELS = {
    ...Object.fromEntries(TIERS.map(tier => [tier.id, Math.max(TITLES_FROM, tier.level)])),
    planner: 5, nightOwl: 7, earlyBird: 7, teamPlayer: 9, deepFocus: 12, marathon: 16, mentor: 25,
};
const SHOWCASE_LEVEL = 18;

// The level a profile choice needs (1: always there)
function requiredLevel(field, value) {
    if (value === null || value === undefined) return 1;
    switch (field) {
        case "emoji": {
            const index = PROFILE_EMOJIS.indexOf(value);
            return index < 10 ? 1 : index < 20 ? 3 : index < 30 ? 6 : 12;
        }
        case "color": return PROFILE_COLORS.indexOf(value) < 4 ? 1 : 4;
        case "banner": return BANNER_LEVELS[value] ?? 1;
        case "frame": return FRAME_LEVELS[value] ?? 1;
        case "title": return TITLE_LEVELS[value] ?? 1;
        case "showcase": return Array.isArray(value) && value.length > 0 ? SHOWCASE_LEVEL : 1;
        default: return 1;
    }
}

// ---------- badges (the same rules as src/features/profile/badges.js) ----------
const HOUR = 60 * 60 * 1000;
const BADGES = {
    firstSession: (s) => s.sessions >= 1,
    tenHours: (s) => s.totalMs >= 10 * HOUR,
    hundredHours: (s) => s.totalMs >= 100 * HOUR,
    streak7: (s) => s.longestStreak >= 7,
    streak30: (s) => s.longestStreak >= 30,
    marathon: (s) => s.longestSessionMs >= 2 * HOUR,
    tasks50: (s) => s.tasksDone >= 50,
    teamPlayer: (s) => s.sharedSessions >= 5,
    earlyBird: (s) => s.favoriteTime === "morning" && s.sessions >= 5,
    nightOwl: (s) => s.favoriteTime === "night" && s.sessions >= 5,
};
const earnedBadges = (stats) => Object.keys(BADGES).filter(id => BADGES[id](stats));

// ---------- challenges ----------
// Every day three (one per slot), every week two. The same for everybody on a day, so friends
// can compare; somebody without friends never gets one that needs them.
// metric: what counts, see measure() below. goal in minutes, tasks, days or times.
const DAILY_SLOTS = [
    [
        { id: "focus25", metric: "focusMin", goal: 25, xp: 25 },
        { id: "focus45", metric: "focusMin", goal: 45, xp: 40 },
        { id: "focus90", metric: "focusMin", goal: 90, xp: 70 },
    ],
    [
        { id: "tasks3", metric: "tasksDone", goal: 3, xp: 30 },
        { id: "tasks5", metric: "tasksDone", goal: 5, xp: 45 },
        { id: "sessions2", metric: "sessions15", goal: 2, xp: 35 },
    ],
    [
        { id: "deepWork", metric: "longestMin", goal: 40, xp: 50 },
        { id: "earlyBird", metric: "earlyMin", goal: 20, xp: 40 },
        { id: "planTomorrow", metric: "plannedTomorrow", goal: 2, xp: 25 },
        { id: "together20", metric: "togetherMin", goal: 20, xp: 45, social: true },
        { id: "cheer2", metric: "cheers", goal: 2, xp: 20, social: true },
    ],
];
const WEEKLY_SLOTS = [
    [
        { id: "week5h", metric: "focusMin", goal: 300, xp: 200 },
        { id: "week8h", metric: "focusMin", goal: 480, xp: 320 },
        { id: "week20tasks", metric: "tasksDone", goal: 20, xp: 200 },
    ],
    [
        { id: "days5", metric: "activeDays", goal: 5, xp: 250 },
        { id: "sweep3", metric: "sweeps", goal: 3, xp: 300 },
        { id: "togetherWeek", metric: "togetherMin", goal: 120, xp: 250, social: true },
        { id: "cheer10", metric: "cheers", goal: 10, xp: 120, social: true },
    ],
];
const CHALLENGE_IDS = new Set([...DAILY_SLOTS, ...WEEKLY_SLOTS].flat().map(c => c.id));
const DAILY_IDS = new Set(DAILY_SLOTS.flat().map(c => c.id));
// a day counts for "days5" with this much focus
const ACTIVE_DAY_MIN = 15;
// sessions that count for "sessions2"
const SESSION_MIN = 15;
// streaks worth a feed entry
const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];
// a day's focus shows up in the feed from this many minutes (or one task done)
const FEED_DAY_MIN = 10;

// FNV-1a: a stable number from a text, so a day always deals the same challenges
function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function pick(slots, period, social) {
    return slots.map((slot, i) => {
        const options = social ? slot : slot.filter(c => !c.social);
        return options[hash(`${period}:${i}`) % options.length];
    });
}

// ---------- reading the numbers ----------

// XP of several people: { [id]: { focusXp, taskXp, challengeXp, xp } }. since: only from that
// day on (a "YYYY-MM-DD" in each person's own time zone), or null for all of it.
// The solo timer on a shared task books its time twice (the solo session and the team
// stopwatch), so a day's team time only counts beyond what the solo sessions already hold.
async function loadXp(pool, userIds, since = null) {
    const result = await pool.query(
        `WITH people AS (SELECT id, COALESCE(timezone, 'Europe/Berlin') AS tz FROM users WHERE id = ANY($1::int[])),
        solo AS (
            SELECT s.user_id, ((s.date AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE p.tz)::date AS day,
                sum(COALESCE(s.time_ms, 0))::bigint AS ms, COALESCE(sum(linked.ms), 0)::bigint AS shared_ms
            FROM sessions AS s
            JOIN people AS p ON p.id = s.user_id
            LEFT JOIN LATERAL (SELECT sum(time_ms) AS ms FROM session_shared_tasks WHERE session_id = s.id) AS linked ON true
            WHERE s.date IS NOT NULL AND ($2::date IS NULL OR s.date >= $2::date - 1)
            GROUP BY 1, 2
        ),
        team AS (
            SELECT user_id, day, time_ms AS ms FROM shared_time_days
            WHERE user_id = ANY($1::int[]) AND ($2::date IS NULL OR day >= $2::date)
        ),
        focus AS (
            SELECT COALESCE(solo.user_id, team.user_id) AS user_id, COALESCE(solo.day, team.day) AS day,
                COALESCE(solo.ms, 0) + GREATEST(COALESCE(team.ms, 0) - COALESCE(solo.shared_ms, 0), 0) AS ms
            FROM solo FULL JOIN team ON team.user_id = solo.user_id AND team.day = solo.day
        ),
        done AS (
            SELECT t.user_id, (t.completed_at AT TIME ZONE p.tz)::date AS day, count(*) AS n
            FROM tasks AS t JOIN people AS p ON p.id = t.user_id
            WHERE t.kind = 'task' AND t.done
                AND ($2::date IS NULL OR (t.completed_at AT TIME ZONE p.tz)::date >= $2::date)
            GROUP BY 1, 2
        )
        SELECT people.id,
            COALESCE((SELECT sum(LEAST(focus.ms / 60000, ${DAY_FOCUS_XP_MAX})) FROM focus
                WHERE focus.user_id = people.id AND ($2::date IS NULL OR focus.day >= $2::date)), 0)::int AS focus_xp,
            COALESCE((SELECT sum(CASE WHEN done.day IS NULL THEN done.n ELSE LEAST(done.n, ${DAY_TASKS_MAX}) END)
                FROM done WHERE done.user_id = people.id), 0)::int * ${TASK_XP} AS task_xp,
            COALESCE((SELECT sum(xp) FROM challenge_completions AS c
                WHERE c.user_id = people.id AND ($2::date IS NULL OR c.period >= $2::date)), 0)::int AS challenge_xp
        FROM people`,
        [userIds, since]
    );
    return Object.fromEntries(result.rows.map(row => [row.id, {
        focusXp: row.focus_xp, taskXp: row.task_xp, challengeXp: row.challenge_xp,
        xp: row.focus_xp + row.task_xp + row.challenge_xp,
    }]));
}

// The level a profile choice is checked against: the highest one reached, or the one the
// numbers give now if that is higher (it is announced on the next look at the progress)
async function unlockLevel(pool, userId) {
    const [xp, stored] = await Promise.all([
        loadXp(pool, [userId]),
        pool.query("SELECT level, is_owner FROM users WHERE id = $1", [userId]),
    ]);
    if (stored.rows[0]?.is_owner) return MAX_LEVEL;
    return Math.max(stored.rows[0]?.level ?? 1, levelForXp(xp[userId]?.xp ?? 0));
}

// This week's raw numbers of one person, in their time zone
async function loadWeek(pool, userId) {
    const result = await pool.query(
        `WITH me AS (SELECT COALESCE(timezone, 'Europe/Berlin') AS tz, share_activity, level, is_owner FROM users WHERE id = $1),
        b AS (SELECT tz, share_activity, level, is_owner, (now() AT TIME ZONE tz)::date AS today,
            date_trunc('week', now() AT TIME ZONE tz)::date AS monday FROM me)
        SELECT to_char(b.today, 'YYYY-MM-DD') AS today, to_char(b.monday, 'YYYY-MM-DD') AS monday, b.share_activity, b.level, b.is_owner,
            (SELECT COALESCE(json_agg(json_build_object('day', to_char(x.at, 'YYYY-MM-DD'), 'hour', extract(hour FROM x.at)::int,
                    'ms', x.ms, 'sharedMs', x.shared_ms)), '[]')
                FROM (SELECT (s.date AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE b.tz AS at,
                        COALESCE(s.time_ms, 0)::bigint AS ms,
                        (SELECT COALESCE(sum(time_ms), 0) FROM session_shared_tasks WHERE session_id = s.id)::bigint AS shared_ms
                    FROM sessions AS s WHERE s.user_id = $1 AND s.date >= b.monday - 1) AS x
                WHERE x.at::date >= b.monday) AS solo,
            (SELECT COALESCE(json_agg(json_build_object('day', to_char(day, 'YYYY-MM-DD'), 'ms', time_ms)), '[]')
                FROM shared_time_days WHERE user_id = $1 AND day >= b.monday) AS team,
            (SELECT COALESCE(json_agg(to_char((completed_at AT TIME ZONE b.tz)::date, 'YYYY-MM-DD')), '[]')
                FROM tasks WHERE user_id = $1 AND kind = 'task' AND done AND completed_at IS NOT NULL
                    AND (completed_at AT TIME ZONE b.tz)::date >= b.monday) AS done_days,
            (SELECT COALESCE(json_agg(to_char((c.created_at AT TIME ZONE b.tz)::date, 'YYYY-MM-DD')), '[]')
                FROM feed_cheers AS c JOIN feed_events AS e ON e.id = c.event_id
                WHERE c.user_id = $1 AND e.user_id <> $1 AND (c.created_at AT TIME ZONE b.tz)::date >= b.monday) AS cheer_days,
            (SELECT count(*)::int FROM tasks WHERE user_id = $1 AND NOT done AND due = b.today + 1
                AND ((created_at AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE b.tz)::date = b.today) AS planned_tomorrow,
            (SELECT count(*)::int FROM friendships WHERE status = 'accepted' AND $1 IN (requester_id, addressee_id)) AS friends,
            (SELECT COALESCE(json_agg(json_build_object('challenge', challenge, 'period', to_char(period, 'YYYY-MM-DD'),
                    'xp', xp, 'at', completed_at)), '[]')
                FROM challenge_completions WHERE user_id = $1 AND period >= b.monday) AS completions,
            (SELECT COALESCE(json_agg(to_char(d, 'YYYY-MM-DD') ORDER BY d DESC), '[]')
                FROM (SELECT ((s.date AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE b.tz)::date AS d
                        FROM sessions AS s WHERE s.user_id = $1 AND s.time_ms > 0 AND s.date >= b.today - 400
                    UNION SELECT day FROM shared_time_days WHERE user_id = $1 AND time_ms > 0 AND day >= b.today - 400) AS days) AS focus_days
        FROM b`,
        [userId]
    );
    return result.rows[0];
}

// The metrics the challenges count, for one day or for the whole week (day = null)
function measure(week, day) {
    const inPeriod = (d) => day === null || d === day;
    const solo = week.solo.filter(s => inPeriod(s.day)).map(s => ({ ...s, ms: Number(s.ms), sharedMs: Number(s.sharedMs) }));
    const team = week.team.filter(t => inPeriod(t.day)).map(t => ({ ...t, ms: Number(t.ms) }));

    // focus per day: solo sessions, plus the team time beyond what they already hold
    const days = new Map();
    const at = (d) => days.get(d) ?? days.set(d, { solo: 0, shared: 0, team: 0 }).get(d);
    for (const s of solo) { at(s.day).solo += s.ms; at(s.day).shared += s.sharedMs; }
    for (const t of team) at(t.day).team += t.ms;
    const focusOf = (d) => d.solo + Math.max(0, d.team - d.shared);
    const minutes = (ms) => Math.floor(ms / 60000);

    const dailyDone = week.completions.filter(c => DAILY_IDS.has(c.challenge));
    const perDay = new Map();
    for (const c of dailyDone) perDay.set(c.period, (perDay.get(c.period) ?? 0) + 1);

    return {
        focusMin: minutes([...days.values()].reduce((sum, d) => sum + focusOf(d), 0)),
        tasksDone: week.done_days.filter(inPeriod).length,
        sessions15: solo.filter(s => s.ms >= SESSION_MIN * 60000).length,
        longestMin: minutes(solo.reduce((max, s) => Math.max(max, s.ms), 0)),
        earlyMin: minutes(solo.filter(s => s.hour < 10).reduce((max, s) => Math.max(max, s.ms), 0)),
        plannedTomorrow: week.planned_tomorrow,
        togetherMin: minutes(team.reduce((sum, t) => sum + t.ms, 0)),
        cheers: week.cheer_days.filter(inPeriod).length,
        activeDays: [...days.values()].filter(d => focusOf(d) >= ACTIVE_DAY_MIN * 60000).length,
        sweeps: [...perDay.values()].filter(n => n >= DAILY_SLOTS.length).length,
        // the day's own numbers, for its feed entry
        focusMs: [...days.values()].reduce((sum, d) => sum + focusOf(d), 0),
        sessions: solo.length,
    };
}

// The streak up to today (0 when today has no focus yet), from the days with focus, newest first
function streakToday(focusDays, today) {
    const DAY = 24 * 60 * 60 * 1000;
    let streak = 0;
    let expected = Date.parse(`${today}T00:00:00Z`);
    for (const day of focusDays) {
        const time = Date.parse(`${day}T00:00:00Z`);
        if (time > expected) continue;
        if (time !== expected) break;
        streak++;
        expected -= DAY;
    }
    return streak;
}

// ---------- the evaluation ----------
// Looks at my numbers: completes challenges that are reached, raises my level, keeps today's
// feed entry current and posts milestones. Safe to run at the same time twice: everything that
// is announced is written once (unique keys), so only one of them announces it.
// announce(userIds) is told who should load the feed again. Answers with my progress.
async function evaluateProgress(pool, userId, announce = () => {}) {
    const week = await loadWeek(pool, userId);
    const social = week.friends > 0;
    const share = week.share_activity;
    const feedChanged = { value: false };

    const daily = pick(DAILY_SLOTS, week.today, social);
    const weekly = pick(WEEKLY_SLOTS, week.monday, social);

    // posts what a person did, if they share it with their friends
    const post = async (kind, data, day = null) => {
        if (!share) return;
        await pool.query("INSERT INTO feed_events (user_id, kind, day, data) VALUES ($1, $2, $3, $4)", [userId, kind, day, data]);
        feedChanged.value = true;
    };

    const complete = async (challenge, period, value) => {
        const done = week.completions.find(c => c.challenge === challenge.id && c.period === period);
        if (done || value < challenge.goal) return done ?? null;
        const inserted = await pool.query(
            `INSERT INTO challenge_completions (user_id, challenge, period, xp) VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING RETURNING completed_at`,
            [userId, challenge.id, period, challenge.xp]
        );
        const row = { challenge: challenge.id, period, xp: challenge.xp, at: inserted.rows[0]?.completed_at ?? new Date() };
        week.completions.push(row);
        if (inserted.rowCount > 0) {
            await post("challenge", { challenge: challenge.id, goal: challenge.goal, xp: challenge.xp, weekly: !DAILY_IDS.has(challenge.id) });
        }
        return row;
    };

    const today = measure(week, week.today);
    const dailyOut = [];
    for (const challenge of daily) {
        const done = await complete(challenge, week.today, today[challenge.metric]);
        dailyOut.push({ ...challengeOut(challenge, today[challenge.metric], done), period: "day" });
    }
    // after the daily ones: "all three on three days" counts today's too
    const thisWeek = measure(week, null);
    const weeklyOut = [];
    for (const challenge of weekly) {
        const done = await complete(challenge, week.monday, thisWeek[challenge.metric]);
        weeklyOut.push({ ...challengeOut(challenge, thisWeek[challenge.metric], done), period: "week" });
    }

    const xp = (await loadXp(pool, [userId]))[userId] ?? { focusXp: 0, taskXp: 0, challengeXp: 0, xp: 0 };
    const level = week.is_owner ? MAX_LEVEL : levelForXp(xp.xp);
    const raised = await pool.query(
        `UPDATE users AS u SET level = $2 FROM users AS old
        WHERE u.id = $1 AND old.id = u.id AND u.level < $2 RETURNING old.level AS previous`,
        [userId, level]
    );
    if (raised.rowCount > 0) await post("level", { level, from: raised.rows[0].previous });

    if (share) {
        // today's entry: focus and tasks so far, updated (and moved up) whenever they change.
        // An entry I took out of the feed stays out.
        if (today.focusMs >= FEED_DAY_MIN * 60000 || today.tasksDone > 0) {
            const data = { focusMs: today.focusMs, sessions: today.sessions, tasksDone: today.tasksDone };
            const upserted = await pool.query(
                `INSERT INTO feed_events (user_id, kind, day, data) VALUES ($1, 'day', $2, $3)
                ON CONFLICT (user_id, kind, day) WHERE kind IN ('day', 'streak')
                DO UPDATE SET data = CASE WHEN feed_events.data ? 'hidden' THEN EXCLUDED.data || '{"hidden": true}' ELSE EXCLUDED.data END,
                    updated_at = CASE WHEN feed_events.data ? 'hidden' THEN feed_events.updated_at ELSE now() END
                WHERE feed_events.data - 'hidden' IS DISTINCT FROM EXCLUDED.data
                RETURNING id`,
                [userId, week.today, data]
            );
            if (upserted.rowCount > 0) feedChanged.value = true;
        }
        const streak = streakToday(week.focus_days, week.today);
        if (STREAK_MILESTONES.includes(streak)) {
            const inserted = await pool.query(
                `INSERT INTO feed_events (user_id, kind, day, data) VALUES ($1, 'streak', $2, $3)
                ON CONFLICT (user_id, kind, day) WHERE kind IN ('day', 'streak') DO NOTHING`,
                [userId, week.today, { days: streak }]
            );
            if (inserted.rowCount > 0) feedChanged.value = true;
        }
    }
    if (feedChanged.value) announce(userId);

    return {
        today: week.today,
        weekStart: week.monday,
        // the owner is on the top level whatever the numbers say
        xp: week.is_owner ? Math.max(xp.xp, levelStartXp(MAX_LEVEL)) : xp.xp,
        sources: { focus: xp.focusXp, tasks: xp.taskXp, challenges: xp.challengeXp },
        level,
        // the highest level reached: what the unlocks go by
        unlockLevel: Math.max(level, week.level),
        levelStartXp: levelStartXp(level),
        // null on the highest level: there is no next one
        nextLevelXp: level >= MAX_LEVEL ? null : levelStartXp(level + 1),
        maxLevel: MAX_LEVEL,
        daily: dailyOut,
        weekly: weeklyOut,
        streak: streakToday(week.focus_days, week.today) || streakToday(week.focus_days, dayBefore(week.today)),
        shareActivity: share,
    };
}

const dayBefore = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function challengeOut(challenge, value, done) {
    return {
        id: challenge.id,
        goal: challenge.goal,
        value: Math.min(value, challenge.goal),
        xp: challenge.xp,
        done: Boolean(done),
        completedAt: done?.at ?? null,
    };
}

module.exports = {
    DAY_FOCUS_XP_MAX, TASK_XP, DAY_TASKS_MAX,
    MAX_LEVEL, levelForXp, levelStartXp, levelStepXp,
    PROFILE_COLORS, PROFILE_BANNERS, PROFILE_EMOJIS, AVATAR_FRAMES, PROFILE_TITLES, SHOWCASE_MAX, BADGES,
    requiredLevel, earnedBadges,
    CHALLENGE_IDS, DAILY_SLOTS, WEEKLY_SLOTS, pick, measure, streakToday,
    loadXp, unlockLevel, evaluateProgress,
};
