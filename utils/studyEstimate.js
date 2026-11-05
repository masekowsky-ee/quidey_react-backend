// Study goals: minute estimates per part (history -> pages -> AI -> defaults) and the Claude call.
// Pure except makeAiClient (reads env). askAi takes the client by injection.

const MIN = 15;
const MAX = 1200;
const DEFAULTS = { exam: 120, assignment: 180, presentation: 90, other: 120 };
const MIN_SAMPLES = 3;
const MAX_PARTS = 40;

const clamp = (n) => Math.min(MAX, Math.max(MIN, Math.round(n)));

function median(values) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

const RANGE = /(?:\bpp?\.|\bS\.|\bSeiten\b|\bpages?\b)\s*(\d+)\s*(?:[-–—]|\bbis\b|\bto\b)\s*(\d+)/i;

// "S. 120-160" -> 40 (end - start). No range, or an empty/backwards one -> null.
function pageCount(name) {
    if (typeof name !== 'string') return null;
    const m = RANGE.exec(name);
    if (!m) return null;
    const n = Number(m[2]) - Number(m[1]);
    return n > 0 ? n : null;
}

function estimateParts({ parts, kind, history, ai }) {
    const h = history || {};
    const sameSubjectKind = h.sameSubjectKind || [];
    const sameKind = h.sameKind || [];
    const perPage = h.minutesPerPage || [];
    const histMedian = sameSubjectKind.length >= MIN_SAMPLES ? median(sameSubjectKind)
        : sameKind.length >= MIN_SAMPLES ? median(sameKind) : null;
    const pageMedian = perPage.length >= MIN_SAMPLES ? median(perPage) : null;
    const dflt = DEFAULTS[kind] ?? DEFAULTS.other;

    return parts.map((part, i) => {
        if (histMedian != null) return { minutes: clamp(histMedian), source: 'history' };
        const pages = pageMedian != null ? pageCount(part.name) : null;
        if (pages != null) return { minutes: clamp(pages * pageMedian), source: 'pages' };
        const a = ai ? ai[i] : null;
        if (typeof a === 'number' && Number.isFinite(a)) return { minutes: clamp(a), source: 'ai' };
        return { minutes: clamp(dflt), source: 'default' };
    });
}

// 15 % of the other estimates, 60-240.
function reviewMinutes(otherEstimates) {
    const sum = otherEstimates.reduce((s, x) => s + x, 0);
    return Math.min(240, Math.max(60, Math.round(sum * 0.15)));
}

const TOOL = {
    name: 'give_estimates',
    description: 'Return the estimated study minutes for each part, one entry per index.',
    input_schema: {
        type: 'object',
        properties: {
            estimates: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { index: { type: 'integer' }, minutes: { type: 'integer' } },
                    required: ['index', 'minutes'],
                },
            },
        },
        required: ['estimates'],
    },
};

function parseEstimates(response, count) {
    const out = new Array(count).fill(null);
    const block = (response?.content || []).find((b) => b?.type === 'tool_use' && b.name === TOOL.name);
    const list = block?.input?.estimates;
    if (!Array.isArray(list)) return out;
    for (const e of list) {
        if (!e || !Number.isInteger(e.index) || e.index < 0 || e.index >= count) continue;
        if (typeof e.minutes !== 'number' || !Number.isFinite(e.minutes)) continue;
        out[e.index] = Math.round(e.minutes);
    }
    return out;
}

// One entry per part; any error or timeout -> all null. Sends only part names, subject name, kind, days.
async function askAi({ client, model, subjectName, kind, daysUntilDue, parts, timeoutMs = 8000 }) {
    const empty = parts.map(() => null);
    if (!client || !parts.length || parts.length > MAX_PARTS) return empty;
    const ctrl = new AbortController();
    let timer;
    try {
        const prompt = [
            'Estimate how many minutes a typical university or school student needs to study or complete each part below.',
            `Subject: ${subjectName}`,
            `Kind: ${kind}`,
            `Days until due: ${daysUntilDue}`,
            'Parts (index: name):',
            ...parts.map((p, i) => `${i}: ${p}`),
            'Call give_estimates with exactly one entry per index.',
        ].join('\n');
        const call = client.messages.create({
            model,
            max_tokens: 1024,
            tools: [TOOL],
            tool_choice: { type: 'tool', name: TOOL.name },
            messages: [{ role: 'user', content: prompt }],
        }, { signal: ctrl.signal, timeout: timeoutMs });
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => { ctrl.abort(); reject(new Error('timeout')); }, timeoutMs);
        });
        call.catch(() => {}); // a late rejection after the race must not be unhandled
        return parseEstimates(await Promise.race([call, timeout]), parts.length);
    } catch {
        return empty;
    } finally {
        clearTimeout(timer);
    }
}

function aiModel() {
    return process.env.STUDY_AI_MODEL || 'claude-haiku-5-5';
}

function makeAiClient() {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const Anthropic = require('@anthropic-ai/sdk');
    const Ctor = Anthropic.default || Anthropic;
    return new Ctor({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
}

module.exports = { pageCount, estimateParts, reviewMinutes, askAi, makeAiClient, aiModel, MAX_PARTS };
