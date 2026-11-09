// Asking Claude (Haiku) for a structured answer: the AI features of the app (quick-entry lines, scans).
// ask(job, { system, content, schema, maxTokens, timeoutMs }) → the parsed object, which the caller
// checks again (the model's output is never trusted as it comes). Throws AiError with code
// AI_UNAVAILABLE (no ANTHROPIC_API_KEY), AI_REFUSED, AI_TIMEOUT or AI_FAILED.
//
// Tests: AI_FAKE (JSON { [job]: answer }, never in production) answers without the API; an input
// containing "AI_FAIL" fails, as the real call can.

const MODEL = () => process.env.AI_MODEL || "claude-haiku-5-5";

class AiError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

let client;
function realClient() {
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

// the HTTP answer for an AiError
function aiErrorResponse(res, err) {
    if (err.code === "AI_UNAVAILABLE") return res.status(503).json({ error: "AI is not set up", code: "AI_UNAVAILABLE" });
    if (err.code === "AI_REFUSED") return res.status(422).json({ error: "The AI declined this", code: "AI_REFUSED" });
    return res.status(502).json({ error: "The AI didn't answer usefully, try again", code: err.code === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_FAILED" });
}

module.exports = { ask, available, AiError, aiErrorResponse, MODEL };
