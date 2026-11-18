// Idempotency for the requests the apps queue while offline (POST /api/tasks, POST /api/sessions).
//
// A request with an `Idempotency-Key` header runs once per account and key: the first successful
// answer is stored (table idempotency_keys, migration 056) and sent again, with the header
// `Idempotent-Replay: true`, for the same key. A failed attempt leaves nothing behind, so the app
// may try again. If the first request is still running, the second gets 409 IDEMPOTENCY_IN_PROGRESS
// and the app tries again a little later. Requests without the header are untouched.
const KEY = /^[A-Za-z0-9._:-]{8,100}$/;
const KEEP_DAYS = 7;

function idempotency(pool) {
    return async function idempotent(req, res, next) {
        const key = req.headers["idempotency-key"];
        if (req.method !== "POST" || key === undefined) return next();
        if (typeof key !== "string" || !KEY.test(key)) {
            return res.status(400).json({ error: "Invalid Idempotency-Key", code: "INVALID_IDEMPOTENCY_KEY" });
        }
        const userId = req.user.userId;
        try {
            // a claim whose request died with the server never gets an answer: after two minutes it is free
            await pool.query(
                "DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND status IS NULL AND created_at < now() - interval '2 minutes'",
                [userId, key]
            );
            const claimed = await pool.query(
                "INSERT INTO idempotency_keys (user_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1",
                [userId, key]
            );
            if (claimed.rowCount === 0) {
                const { rows } = await pool.query("SELECT status, response FROM idempotency_keys WHERE user_id = $1 AND key = $2", [userId, key]);
                const earlier = rows[0];
                if (earlier?.status) {
                    res.set("Idempotent-Replay", "true");
                    return res.status(earlier.status).json(earlier.response);
                }
                return res.status(409).json({ error: "The same request is still running", code: "IDEMPOTENCY_IN_PROGRESS" });
            }
            // now and then, old keys go
            if (Math.random() < 0.02) {
                pool.query("DELETE FROM idempotency_keys WHERE created_at < now() - ($1 || ' days')::interval", [String(KEEP_DAYS)]).catch(() => {});
            }

            // remember the answer when it is a success; anything else frees the key again
            let body;
            const json = res.json.bind(res);
            res.json = (payload) => { body = payload; return json(payload); };
            res.on("finish", () => {
                const done = res.statusCode >= 200 && res.statusCode < 300 && body !== undefined;
                const query = done
                    ? pool.query("UPDATE idempotency_keys SET status = $3, response = $4 WHERE user_id = $1 AND key = $2", [userId, key, res.statusCode, JSON.stringify(body)])
                    : pool.query("DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2", [userId, key]);
                query.catch((err) => console.error("idempotency:", err.message));
            });
            res.on("close", () => {
                // the connection broke before an answer: free the key
                if (!res.writableEnded) pool.query("DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2", [userId, key]).catch(() => {});
            });
            next();
        } catch (err) {
            next(err);
        }
    };
}

module.exports = { idempotency };
