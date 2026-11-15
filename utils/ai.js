// Asking Claude (Haiku) for a structured answer: the AI features of the app (quick-entry lines, scans).
// ask(job, { system, content, schema, maxTokens, timeoutMs }) → the parsed object, which the caller
// checks again (the model's output is never trusted as it comes). Throws AiError with code
// AI_UNAVAILABLE (no ANTHROPIC_API_KEY), AI_REFUSED, AI_TIMEOUT or AI_FAILED (the assistant's loop
// also AI_TOO_LONG).
//
// converse({ system, messages, tools, ... }) is one turn of a tool loop (the Max assistant).
//
// Tests: AI_FAKE (JSON { [job]: answer }, never in production) answers without the API; an input
// containing "AI_FAIL" fails, as the real call can. useTestClient(fake) (never in production) puts
// a fake client in place of the API's, for tests that play the model's turns in a tool loop.

const MODEL = () => process.env.AI_MODEL || "claude-haiku-5-5";

class AiError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

let client;
// tests only (never in production): a fake client whose messages.create plays the model's turns
let testClient = null;
const useTestClient = (fake) => { testClient = fake; };

function realClient() {
    if (testClient && process.env.NODE_ENV !== "production") return testClient;
    if (!process.env.ANTHROPIC_API_KEY) return null;
    if (!client) {
        const Anthropic = require("@anthropic-ai/sdk");
        const Ctor = Anthropic.default || Anthropic;
        // one try: the user is waiting, a failure gives the allowance back and they can try again
        client = new Ctor({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });
    }
    return client;
}

function fakeAnswers() {
    if (!process.env.AI_FAKE || process.env.NODE_ENV === "production") return null;
    try { return JSON.parse(process.env.AI_FAKE); } catch { return null; }
}

const available = () => Boolean(fakeAnswers() || process.env.ANTHROPIC_API_KEY);

const mentionsFailure = (content) => JSON.stringify(content).includes("AI_FAIL");

async function ask(job, { system, content, schema, maxTokens = 2000, timeoutMs = 20000 }) {
    const fake = fakeAnswers();
    if (fake) {
        if (mentionsFailure(content) || !(job in fake)) throw new AiError("AI_FAILED");
        return structuredClone(fake[job]);
    }
    const api = realClient();
    if (!api) throw new AiError("AI_UNAVAILABLE");
    const { jsonSchemaOutputFormat } = require("@anthropic-ai/sdk/helpers/json-schema");
    let message;
    try {
        message = await api.messages.parse({
            model: MODEL(),
            max_tokens: maxTokens,
            system,
            messages: [{ role: "user", content }],
            // reading and sorting, not reasoning at length
            output_config: { effort: "low", format: jsonSchemaOutputFormat(schema) },
        }, { timeout: timeoutMs });
    } catch (err) {
        const Anthropic = require("@anthropic-ai/sdk");
        const ns = Anthropic.default || Anthropic;
        if (err instanceof ns.APIConnectionTimeoutError) throw new AiError("AI_TIMEOUT");
        throw new AiError("AI_FAILED", err.message);
    }
    if (message.stop_reason === "refusal") throw new AiError("AI_REFUSED");
    if (message.stop_reason === "max_tokens" || !message.parsed_output) throw new AiError("AI_FAILED", `stop: ${message.stop_reason}`);
    return message.parsed_output;
}

// One model turn with tools, for a tool loop (utils/assistant.js): the caller sends the whole
// conversation and gets { content, stopReason, usage: { inputTokens, outputTokens } } back.
// The caller checks stopReason (refusal, max_tokens, tool_use, end_turn) and passes content back
// unchanged when it continues. Tool choice stays "auto" (forced tool use is refused by the model).
// timeoutMs bounds one attempt; signal (an AbortSignal) bounds the whole call, retries included, and
// an aborted call is an AI_TIMEOUT too.
// Throws AiError AI_UNAVAILABLE, AI_TIMEOUT or AI_FAILED.
async function converse({ system, messages, tools, maxTokens = 2000, timeoutMs = 20000, signal, effort = "low" }) {
    const api = realClient();
    if (!api) throw new AiError("AI_UNAVAILABLE");
    let message;
    try {
        message = await api.messages.create({
            model: MODEL(),
            max_tokens: maxTokens,
            system,
            messages,
            tools,
            output_config: { effort },
        }, { timeout: timeoutMs, ...(signal ? { signal } : {}) });
    } catch (err) {
        if (signal?.aborted) throw new AiError("AI_TIMEOUT");
        const Anthropic = require("@anthropic-ai/sdk");
        const ns = Anthropic.default || Anthropic;
        if (err instanceof ns.APIConnectionTimeoutError) throw new AiError("AI_TIMEOUT");
        throw new AiError("AI_FAILED", err.message);
    }
    return {
        content: Array.isArray(message?.content) ? message.content : [],
        stopReason: message?.stop_reason ?? null,
        usage: { inputTokens: Number(message?.usage?.input_tokens) || 0, outputTokens: Number(message?.usage?.output_tokens) || 0 },
    };
}

// the HTTP answer for an AiError
function aiErrorResponse(res, err) {
    if (err.code === "AI_UNAVAILABLE") return res.status(503).json({ error: "AI is not set up", code: "AI_UNAVAILABLE" });
    if (err.code === "AI_REFUSED") return res.status(422).json({ error: "The AI declined this", code: "AI_REFUSED" });
    // the assistant's request needed more steps or input than one message may use (utils/assistant.js)
    if (err.code === "AI_TOO_LONG") return res.status(502).json({ error: "The request was too broad, try a narrower one", code: "AI_TOO_LONG" });
    return res.status(502).json({ error: "The AI didn't answer usefully, try again", code: err.code === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_FAILED" });
}

// How long a piece of homework takes (minutes, 5-240), from its text, the subject and the days until it is due;
// null without an AI or when it fails. Nothing else of the account goes along (no grades, no name).
async function estimateHomeworkMinutes({ text, subject, daysUntilDue }) {
    if (!available()) return null;
    try {
        const raw = await ask("homework-minutes", {
            system: "You estimate how many minutes a school student needs for one piece of homework. Answer with a whole number of minutes between 5 and 240, for an average student, only the work itself.",
            content: [`Subject: ${String(subject || "").slice(0, 60)}`, `Due in ${Number.isInteger(daysUntilDue) ? daysUntilDue : "?"} days`, `Homework: ${String(text || "").slice(0, 1500)}`].join("\n"),
            schema: { type: "object", properties: { minutes: { type: "integer" } }, required: ["minutes"], additionalProperties: false },
            maxTokens: 200,
            timeoutMs: 8000,
        });
        return Number.isFinite(raw?.minutes) ? Math.min(240, Math.max(5, Math.round(raw.minutes))) : null;
    } catch {
        return null;
    }
}

module.exports = { ask, converse, available, AiError, aiErrorResponse, estimateHomeworkMinutes, MODEL, useTestClient };
