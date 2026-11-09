// Study goals: credit, missed / behind / conflict / ahead status and the "you're behind" push rule.
// Pure: no DB, no clock. Callers pass dates as 'YYYY-MM-DD', times as 'HH:MM', focusMs as a number (ms).
// Session shape: { taskId, partId, date, time|null, minutes, done, focusMs, pinned }.

const MISSED_GRACE = 60; // slots mode: minutes after the planned end

const toMin = (hhmm) => {
    const [h, m] = String(hhmm).split(':');
    return Number(h) * 60 + Number(m);
};

// Minutes studied on one session: the larger of tracked focus time and the ticked planned length.
function sessionCredit({ focusMs, done, minutes }) {
    return Math.max((focusMs || 0) / 60000, done ? minutes : 0);
}

// A part's credit is the sum over its sessions; a finished part has nothing remaining.
function partProgress(part, sessions) {
    const credit = sessions.reduce((sum, s) => sum + sessionCredit(s), 0);
    return { credit, remaining: part.doneAt ? 0 : Math.max(0, part.estimate - credit) };
}

// Past its time, not done, no focus time. slots: 60 min after the planned end; days (and untimed): the day is over.
function isMissed(session, { today, nowMinutes, planMode }) {
    if (session.done || session.focusMs > 0) return false;
    if (session.date < today) return true;
    if (session.date > today) return false;
    if (planMode !== 'slots' || session.time == null) return false;
    return nowMinutes >= toMin(session.time) + session.minutes + MISSED_GRACE;
}

// Future, not done, no focus time (pinned or not). slots: starts after now; days / untimed: today or later.
function isPending(session, { today, nowMinutes }) {
    if (session.done || session.focusMs > 0) return false;
    if (session.date < today) return false;
    if (session.date > today || session.time == null) return true;
    return toMin(session.time) > nowMinutes;
}

// What a re-plan may replace: pending and not pinned.
function isReplaceable(session, ctx) {
    return !session.pinned && isPending(session, ctx);
}

function goalStatus({ goal, parts, sessions, busy }, { today, nowMinutes, sessionMinutes }) {
    const planMode = goal.planMode;
    let deficit = 0;
    const aheadPartIds = [];
    for (const part of parts) {
        const own = sessions.filter((s) => s.partId === part.id);
        const { credit } = partProgress(part, own);
        if (part.doneAt || credit >= part.estimate) aheadPartIds.push(part.id);
        if (part.doneAt) continue;
        const missed = own
            .filter((s) => isMissed(s, { today, nowMinutes, planMode }))
            .reduce((sum, s) => sum + s.minutes, 0);
        deficit += Math.max(0, missed - credit);
    }

    const conflictTaskIds = [];
    if (planMode === 'slots') {
        for (const s of sessions) {
            if (s.time == null || !isReplaceable(s, { today, nowMinutes })) continue;
            const start = toMin(s.time);
            const end = start + s.minutes;
            const hit = (busy || []).some((b) => {
                if (b.date !== s.date) return false;
                const bs = toMin(b.start);
                return bs < end && bs + b.minutes > start;
            });
            if (hit) conflictTaskIds.push(s.taskId ?? s.id);
        }
    }

    return { behindMinutes: deficit >= sessionMinutes ? deficit : 0, conflictTaskIds, aheadPartIds };
}

// Push at most once a day, 08:00-19:00, only when the deficit is new or grew by a whole session.
function shouldNotify({ deficit, notifiedMinutes, sentToday, nowMinutes, sessionMinutes }) {
    return !sentToday
        && nowMinutes >= 8 * 60 && nowMinutes < 19 * 60
        && deficit >= sessionMinutes
        && deficit >= notifiedMinutes + sessionMinutes;
}

const hours = (minutes, language) => {
    const h = Math.round((minutes / 60) * 10) / 10;
    const text = Number.isInteger(h) ? String(h) : h.toFixed(1);
    return `${language === 'en' ? text : text.replace('.', ',')} h`;
};

// One goal: "<name> is 1.5 h behind"; several: a count. The sentence is the title; body lists the goals.
function pushText(goalsBehind, language) {
    const en = language === 'en';
    if (goalsBehind.length === 1) {
        const { name, behindMinutes } = goalsBehind[0];
        const h = hours(behindMinutes, language);
        return {
            title: en ? `${name} is ${h} behind – adjust the plan?` : `${name} liegt ${h} zurück – Plan anpassen?`,
            body: '',
        };
    }
    return {
        title: en ? `${goalsBehind.length} goals are behind – adjust the plan?` : `${goalsBehind.length} Ziele liegen zurück – Plan anpassen?`,
        body: goalsBehind.map((g) => `${g.name} ${hours(g.behindMinutes, language)}`).join(', '),
    };
}

module.exports = { sessionCredit, partProgress, isMissed, isPending, isReplaceable, goalStatus, shouldNotify, pushText };
