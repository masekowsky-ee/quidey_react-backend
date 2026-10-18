require("dotenv").config();

const express = require('express');
const cors = require("cors");
const { rateLimit } = require("express-rate-limit");
const pool = require("./db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;

// Behind a reverse proxy (nginx/Caddy on the server), the client IP is in X-Forwarded-For.
// TRUST_PROXY=1 makes Express use it, so rate limiting counts real clients, not the proxy.
if (process.env.TRUST_PROXY) {
    app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}

// Only the frontend's own origins may call the API from a browser.
// CORS_ORIGINS is a comma separated list, e.g. "https://quidey.example.com".
// Requests without an Origin header (curl, server-to-server) are not affected by CORS.
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:4173")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        callback(null, false); // no CORS headers: the browser blocks the response
    },
}));
app.use(express.json()); //parse json bodies

// Slows down password guessing: 10 failed attempts per IP per 15 minutes on login and register.
// Successful requests and CORS preflights (OPTIONS) don't count.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    skip: (req) => req.method === "OPTIONS",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many attempts, please try again later" },
});
app.use("/api/login", authLimiter);
app.use("/api/register", authLimiter);

function authenticateToken(req, res, next) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "No existing token" });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: "Token invalid or expired" });
        }
        req.user = user;
        next();
    })
}

app.use("/api/tasks", authenticateToken);
app.use("/api/groups", authenticateToken);
app.use("/api/sessions", authenticateToken);
app.use("/api/notes", authenticateToken);
app.use("/api/task-groups", authenticateToken);
app.use("/api/users", authenticateToken);
app.use("/api/friends", authenticateToken);
app.use("/api/shared-sessions", authenticateToken);

//GET endpoints
app.get("/api/tasks", async (req, res) => {
    const userId = req.user.userId;

    try{
        const result = await pool.query(
            "SELECT * FROM tasks WHERE user_id = $1 ORDER BY id",
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/api/users", async (req, res) => {
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            "SELECT users.username, users.display_name, users.birth_date, users.email FROM users WHERE id = $1",
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/api/tasks/:id/groups", async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            `SELECT groups.id, groups.name, groups.description
            FROM groups
            JOIN task_groups ON groups.id = task_groups.group_id
            JOIN tasks ON tasks.id = task_groups.task_id
            WHERE task_groups.task_id = $1 AND tasks.user_id = $2`,
            [id, userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});
//group tasks by id
app.get("/api/groups/:id/tasks", async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            `SELECT tasks.id, tasks.name, tasks.description, tasks.due, tasks.prio, tasks.done
            FROM tasks
            JOIN task_groups ON tasks.id = task_groups.task_id
            JOIN groups ON groups.id = task_groups.group_id
            WHERE task_groups.group_id = $1 AND groups.user_id = $2`,
            [id, userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/groups", async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query("SELECT * FROM groups WHERE user_id = $1 ORDER BY id", [userId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/tasks/:taskId/notes", async (req, res) => {
    const { taskId } = req.params;
    const userId = req.user.userId;

    try {
       const result = await pool.query(
       `SELECT notes.*
       WHERE notes.task_id = $1 AND notes.task_id IN (SELECT id FROM tasks WHERE user_id = $2)`,
        [taskId, userId]
    );
    res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/notes", async (req, res) => {
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            `SELECT notes.*
            FROM notes
            JOIN tasks ON notes.task_id = tasks.id
            WHERE tasks.user_id = $1
            ORDER BY notes.id`,
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// sessions are returned in the shape the frontend stores them in:
// { id, totalTime (seconds), workedTasks: [{ id, name, time (seconds) }], group (name or 'all'), date }
// date is cast to timestamptz so the timestamp column is read in the db's own time zone
const SESSION_SELECT = `
    SELECT sessions.id, sessions.time_ms, sessions.date::timestamptz AS date,
        COALESCE(groups.name, 'all') AS group_name,
        COALESCE(
            json_agg(json_build_object(
                'id', tasks.id,
                'name', tasks.name,
                'time', ROUND(session_tasks.time_ms / 1000.0)::int
            ) ORDER BY tasks.id)
                FILTER (WHERE tasks.id IS NOT NULL),
            '[]'
        ) AS worked_tasks
    FROM sessions
    LEFT JOIN groups ON groups.id = sessions.group_id
    LEFT JOIN session_tasks ON session_tasks.session_id = sessions.id
    LEFT JOIN tasks ON tasks.id = session_tasks.task_id
`;

function toSessionResponse(row) {
    return {
        id: row.id,
        totalTime: Math.round((row.time_ms ?? 0) / 1000),
        workedTasks: row.worked_tasks,
        group: row.group_name,
        date: row.date,
    };
}

app.get("/api/sessions", async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `${SESSION_SELECT}
            WHERE sessions.user_id = $1
            GROUP BY sessions.id, groups.name
            ORDER BY sessions.date DESC, sessions.id DESC`,
            [userId]
        );
        res.json(result.rows.map(toSessionResponse));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/sessions/:id/tasks", async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `SELECT tasks.id, tasks.name, tasks.due, tasks.description, tasks.prio, tasks.done,
                ROUND(session_tasks.time_ms / 1000.0)::int AS time
            FROM tasks
            JOIN session_tasks ON tasks.id = session_tasks.task_id
            JOIN sessions ON sessions.id = session_tasks.session_id
            WHERE session_tasks.session_id = $1 AND sessions.user_id = $2`,
            [id, userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/me" , authenticateToken, (req, res) => {
    res.json({ userId: req.user.userId, username: req.user.username })
});

//POST endpoints
app.post("/api/tasks", async (req, res) => {
    const { name, due, description, prio } = req.body;
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            `INSERT INTO tasks (name, due, description, prio, user_id) 
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING *`,
            [name, due, description, prio, userId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/groups", async (req, res) => {
    const { name, description } = req.body;
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            `INSERT INTO groups (name, description, user_id)
            VALUES ($1, $2, $3)
            RETURNING *`,
            [name, description, userId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/tasks/:taskId/groups/:groupId", async (req, res) => {
    const { taskId, groupId } = req.params;
    const userId = req.user.userId;

    try { 
        const ownerCheck = await pool.query(
            `SELECT 1 FROM tasks WHERE id = $1 AND user_id = $2
            UNION ALL
            SELECT 1 FROM groups WHERE id = $3 AND user_id = $2`,
            [taskId, userId, groupId]
        );

        if (ownerCheck.rows.length < 2) {
            return res.status(404).json({ error: "Task or group not found" });
        }

        const result = await pool.query(
            `INSERT INTO task_groups (task_id, group_id)
            VALUES ($1, $2)
            RETURNING *`,
            [taskId, groupId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/tasks/:taskId/notes", async (req, res) => {
    const { taskId } = req.params;
    const { content } = req.body;
    const userId = req.user.userId;

    try {
        const taskCheck = await pool.query(
            "SELECT 1 FROM tasks WHERE id = $1 AND user_id = $2",
            [taskId, userId]
        );

        if (taskCheck.rows.length === 0) {
            return res.status(404).json({ error: "Task not found" });
        }

        const result = await pool.query(
            `INSERT INTO notes (task_id, content)
            VALUES ($1, $2)
            RETURNING *`,
            [taskId, content]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/sessions", async (req, res) => {
    const { totalTime, workedTasks = [], group, date } = req.body;
    const userId = req.user.userId;

    if (!Number.isFinite(totalTime) || totalTime < 0) {
        return res.status(400).json({ error: "totalTime must be a non-negative number" });
    }
    if (!Array.isArray(workedTasks)) {
        return res.status(400).json({ error: "workedTasks must be an array" });
    }

    // session and its task links are saved together or not at all
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        let groupId = null;
        if (group && group !== "all") {
            const groupResult = await client.query(
                "SELECT id FROM groups WHERE name = $1 AND user_id = $2",
                [group, userId]
            );
            if (groupResult.rows.length === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ error: "Group not found" });
            }
            groupId = groupResult.rows[0].id;
        }

        const sessionResult = await client.query(
            `INSERT INTO sessions (group_id, time_ms, date, user_id)
            VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4)
            RETURNING id`,
            [groupId, Math.round(totalTime * 1000), date ?? null, userId]
        );
        const sessionId = sessionResult.rows[0].id;

        // time per task arrives in seconds (like totalTime); the same task twice is summed up
        const msPerTask = new Map();
        for (const task of workedTasks) {
            const id = Number(task?.id);
            if (!Number.isInteger(id)) continue;
            const seconds = Number.isFinite(task?.time) && task.time > 0 ? task.time : 0;
            msPerTask.set(id, (msPerTask.get(id) ?? 0) + Math.round(seconds * 1000));
        }

        // only link tasks that belong to the user, ignore unknown ids
        if (msPerTask.size > 0) {
            await client.query(
                `INSERT INTO session_tasks (session_id, task_id, time_ms)
                SELECT $1, tasks.id, worked.time_ms
                FROM unnest($2::int[], $3::int[]) AS worked(task_id, time_ms)
                JOIN tasks ON tasks.id = worked.task_id AND tasks.user_id = $4
                ON CONFLICT DO NOTHING`,
                [sessionId, [...msPerTask.keys()], [...msPerTask.values()], userId]
            );
        }

        await client.query("COMMIT");

        const result = await pool.query(
            `${SESSION_SELECT}
            WHERE sessions.id = $1
            GROUP BY sessions.id, groups.name`,
            [sessionId]
        );
        res.status(201).json(toSessionResponse(result.rows[0]));
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.post("/api/sessions/:sessionId/tasks/:taskId", async (req, res) => {
    const { sessionId, taskId } = req.params;
    const userId = req.user.userId;

    try{
        const ownerCheck = await pool.query(
            `SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2
            UNION ALL
            SELECT 1 FROM tasks WHERE id = $3 AND user_id = $2`,
            [sessionId, userId, taskId]
        );

        if (ownerCheck.rows.length < 2) {
            return res.status(404).json({ error: "Session or task not found" });
        }

        const result = await pool.query(
            `INSERT INTO session_tasks (session_id, task_id)
            VALUES ($1, $2)
            RETURNING *`,
            [sessionId, taskId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/register", async (req,res) => {
    const { username, password, display_name, birth_date, email } = req.body;

    try { 
        const passwordHash = await bcrypt.hash(password, 10);

        const result = await pool.query(
            `INSERT INTO users (username, password_hash, display_name, birth_date, email)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, username, created_at`, 
            [username, passwordHash, display_name, birth_date, email]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message }); 
    }
});

// Compared against when the username doesn't exist, so an unknown user takes as long
// as a wrong password and the response time doesn't reveal which usernames exist
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("no-such-user-placeholder", 10);

app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;

    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
        return res.status(400).json({ error: "Username and password are required" });
    }

    try {
        const result = await pool.query(
            "SELECT * FROM users WHERE username = $1",
            [username]
        );

        const user = result.rows[0];
        const passwordMatch = await bcrypt.compare(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);

        // same status and message for "unknown user" and "wrong password"
        if (!user || !passwordMatch) {
            return res.status(401).json({ error: "Invalid sign in" });
        }

        const token = jwt.sign(
            { userId: user.id, username: user.username },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.json({ token });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

//PUT endpoints
app.put("/api/tasks/:id", async (req, res) => {
    const { id } = req.params;
    const { name, due, description, prio, done } = req.body;
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            `UPDATE tasks
            SET name = $1, due = $2, description = $3, prio = $4, done = $5
            WHERE id = $6 AND user_id = $7
            RETURNING *`,
            [name, due, description, prio, done, id, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Task not found" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.put("/api/groups/:id", async (req, res) => {
    const { id } = req.params;
    const { name, description } = req.body;
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            `UPDATE groups
            SET name = $1, description = $2
            WHERE id = $3 AND user_id = $4
            RETURNING *`,
            [name, description, id, userId]
        );

        if(result.rows.length === 0) {
            return res.status(404).json({ error: "Group not found" });
        }

        res.json(result.rows[0]);
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.put("/api/notes/:id", async (req, res) => {
    const { id } = req.params;
    const { content } = req.body;
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            `UPDATE notes
            SET content = $1
            WHERE id = $2
            AND task_id IN (SELECT id FROM tasks WHERE user_id = $3)
            RETURNING *`,
            [content, id, userId]
        )

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Note not found" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
})

//DELETE endpoints
app.delete("/api/tasks/:id", async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            "DELETE FROM tasks WHERE id = $1 AND user_id = $2 RETURNING *",
            [id, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Task not found" });
        }

        res.json({ message: "Task deleted", task: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/groups/:id", async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            "DELETE FROM groups WHERE id = $1 AND user_id = $2 RETURNING *",
            [id, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Group not found" });
        }

        res.json({ message: "Group deleted", group: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/task-groups/:taskId/:groupId", async (req, res) => {
    const { taskId, groupId } = req.params;
    const userId = req.user.userId; 

    try {
        const result = await pool.query(
            `DELETE FROM task_groups
             WHERE task_id = $1 
             AND group_id = $2 
             AND task_id IN (SELECT id FROM tasks WHERE user_id = $3)
             AND group_id IN (SELECT id FROM groups WHERE user_id = $3)
             RETURNING *`,
             [taskId, groupId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Connection not found" })
        }

        res.json({ message: "Connection deleted", connection: result.rows[0] })
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/notes/:id", async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            `DELETE FROM notes
             WHERE id = $1
            AND task_id IN (SELECT id FROM tasks WHERE user_id = $2) 
            RETURNING *`,
            [id, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Note not found" });
        }

        res.json({ message: "Note deleted", note: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
})

// ---------- Friends ----------
// Only public profile fields ever leave the server: never email or birth date.
// Errors carry a `code` so the frontend can show a translated message.

// Ids from the URL: a positive integer, or null (answered with 404 instead of a database error)
const idParam = (value) => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
};

const publicUser = (row, prefix = "") => ({
    id: row[`${prefix}id`],
    username: row[`${prefix}username`],
    displayName: row[`${prefix}display_name`],
});

// Sending requests answers "does this username exist?", so it's limited per IP
const friendRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    skip: (req) => req.method === "OPTIONS",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later", code: "RATE_LIMITED" },
});

// Accepted friends, sorted by name
app.get("/api/friends", async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `SELECT users.id, users.username, users.display_name, friendships.responded_at AS since
            FROM friendships
            JOIN users ON users.id = CASE WHEN friendships.requester_id = $1
                THEN friendships.addressee_id ELSE friendships.requester_id END
            WHERE friendships.status = 'accepted'
                AND $1 IN (friendships.requester_id, friendships.addressee_id)
            ORDER BY lower(COALESCE(users.display_name, users.username))`,
            [userId]
        );
        res.json(result.rows.map(row => ({ ...publicUser(row), since: row.since })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Open requests: incoming (waiting for me) and outgoing (waiting for them), newest first
app.get("/api/friends/requests", async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `SELECT friendships.id AS request_id, friendships.created_at,
                friendships.addressee_id = $1 AS incoming,
                users.id, users.username, users.display_name
            FROM friendships
            JOIN users ON users.id = CASE WHEN friendships.requester_id = $1
                THEN friendships.addressee_id ELSE friendships.requester_id END
            WHERE friendships.status = 'pending'
                AND $1 IN (friendships.requester_id, friendships.addressee_id)
            ORDER BY friendships.created_at DESC`,
            [userId]
        );
        const toRequest = row => ({ id: row.request_id, user: publicUser(row), createdAt: row.created_at });
        res.json({
            incoming: result.rows.filter(row => row.incoming).map(toRequest),
            outgoing: result.rows.filter(row => !row.incoming).map(toRequest),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Send a request by exact username. If that person already asked me, this accepts it.
app.post("/api/friends/requests", friendRequestLimiter, async (req, res) => {
    const userId = req.user.userId;
    const username = typeof req.body?.username === "string" ? req.body.username.trim().replace(/^@/, "") : "";

    if (!username) {
        return res.status(400).json({ error: "Username is required", code: "USERNAME_REQUIRED" });
    }

    try {
        const target = await pool.query("SELECT id, username, display_name FROM users WHERE username = $1", [username]);
        if (target.rows.length === 0) {
            return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
        }
        const other = target.rows[0];
        if (other.id === userId) {
            return res.status(400).json({ error: "You can't add yourself", code: "SELF" });
        }

        const existing = await pool.query(
            `SELECT id, requester_id, status FROM friendships
            WHERE LEAST(requester_id, addressee_id) = LEAST($1::int, $2::int)
                AND GREATEST(requester_id, addressee_id) = GREATEST($1::int, $2::int)`,
            [userId, other.id]
        );
        const pair = existing.rows[0];

        if (pair?.status === "accepted") {
            return res.status(409).json({ error: "You are already friends", code: "ALREADY_FRIENDS" });
        }
        if (pair && pair.requester_id === userId) {
            return res.status(409).json({ error: "Request already sent", code: "ALREADY_REQUESTED" });
        }
        if (pair) {
            // they asked me first: sending back counts as accepting
            const accepted = await pool.query(
                `UPDATE friendships SET status = 'accepted', responded_at = now()
                WHERE id = $1 RETURNING responded_at`,
                [pair.id]
            );
            return res.json({ status: "accepted", friend: { ...publicUser(other), since: accepted.rows[0].responded_at } });
        }

        const created = await pool.query(
            `INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2) RETURNING id, created_at`,
            [userId, other.id]
        );
        res.status(201).json({
            status: "pending",
            request: { id: created.rows[0].id, user: publicUser(other), createdAt: created.rows[0].created_at },
        });
    } catch (err) {
        if (err.code === "23505") {
            // both sent at the same moment: the unique pair index caught it
            return res.status(409).json({ error: "Request already exists", code: "ALREADY_REQUESTED" });
        }
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Accept a request sent to me
app.post("/api/friends/requests/:id/accept", async (req, res) => {
    const userId = req.user.userId;
    const requestId = idParam(req.params.id);
    if (!requestId) return res.status(404).json({ error: "Request not found", code: "REQUEST_NOT_FOUND" });
    try {
        const result = await pool.query(
            `UPDATE friendships SET status = 'accepted', responded_at = now()
            WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
            RETURNING requester_id, responded_at`,
            [requestId, userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Request not found", code: "REQUEST_NOT_FOUND" });
        }
        const friend = await pool.query("SELECT id, username, display_name FROM users WHERE id = $1", [result.rows[0].requester_id]);
        res.json({ friend: { ...publicUser(friend.rows[0]), since: result.rows[0].responded_at } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Decline a request sent to me, or cancel one I sent
app.delete("/api/friends/requests/:id", async (req, res) => {
    const userId = req.user.userId;
    const requestId = idParam(req.params.id);
    if (!requestId) return res.status(404).json({ error: "Request not found", code: "REQUEST_NOT_FOUND" });
    try {
        const result = await pool.query(
            `DELETE FROM friendships
            WHERE id = $1 AND status = 'pending' AND $2 IN (requester_id, addressee_id)
            RETURNING id`,
            [requestId, userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Request not found", code: "REQUEST_NOT_FOUND" });
        }
        res.json({ id: result.rows[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Remove a friend (by their user id)
app.delete("/api/friends/:userId", async (req, res) => {
    const userId = req.user.userId;
    const friendId = idParam(req.params.userId);
    if (!friendId) return res.status(404).json({ error: "Friend not found", code: "FRIEND_NOT_FOUND" });
    try {
        const result = await pool.query(
            `DELETE FROM friendships
            WHERE status = 'accepted'
                AND LEAST(requester_id, addressee_id) = LEAST($1::int, $2::int)
                AND GREATEST(requester_id, addressee_id) = GREATEST($1::int, $2::int)
            RETURNING id`,
            [userId, friendId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Friend not found", code: "FRIEND_NOT_FOUND" });
        }
        res.json({ userId: friendId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- Shared sessions ("Together") ----------
// A session has members (invited friends join it), tasks every member can see and work on,
// and time booked per task and person. Members report their time every few seconds
// (POST .../activity), which also tells the others what they are working on right now.
// Only joined members can see a session; for anybody else it doesn't exist (404).

const fail = (res, status, code, error) => res.status(status).json({ error, code });

// A member counts as working right now if they reported within this time
const ONLINE_SECONDS = 30;
// Upper bound for one time report. The client reports every 10 s, but a browser
// throttles timers in background tabs, so a report can cover a few minutes.
const MAX_REPORT_MS = 5 * 60 * 1000;

const sessionName = (value) => typeof value === "string" ? value.trim().slice(0, 100) : "";

const idList = (value) => Array.isArray(value)
    ? [...new Set(value.map(idParam).filter(Boolean))]
    : [];

// My membership row joined with the session, or undefined
async function getMembership(sessionId, userId) {
    const result = await pool.query(
        `SELECT shared_sessions.owner_id, shared_sessions.ended_at, shared_session_members.status
        FROM shared_session_members
        JOIN shared_sessions ON shared_sessions.id = shared_session_members.session_id
        WHERE shared_session_members.session_id = $1 AND shared_session_members.user_id = $2`,
        [sessionId, userId]
    );
    return result.rows[0];
}

// Answers the request itself when I'm not allowed to change the session (not joined, or it ended)
async function requireOpenSession(req, res) {
    const sessionId = idParam(req.params.id);
    const membership = sessionId && await getMembership(sessionId, req.user.userId);
    if (!membership || membership.status !== "joined") {
        fail(res, 404, "SESSION_NOT_FOUND", "Session not found");
        return null;
    }
    if (membership.ended_at) {
        fail(res, 409, "SESSION_ENDED", "This session has ended");
        return null;
    }
    return { sessionId, ...membership, isOwner: membership.owner_id === req.user.userId };
}

// Invites the given users to a session, skipping anybody who isn't my friend or is already in it
async function inviteFriends(db, sessionId, userId, friendIds) {
    if (friendIds.length === 0) return 0;
    const result = await db.query(
        `INSERT INTO shared_session_members (session_id, user_id, status, invited_by)
        SELECT $1, invitee.id, 'invited', $2
        FROM unnest($3::int[]) AS invitee(id)
        WHERE EXISTS (
            SELECT 1 FROM friendships
            WHERE status = 'accepted'
                AND LEAST(requester_id, addressee_id) = LEAST($2::int, invitee.id)
                AND GREATEST(requester_id, addressee_id) = GREATEST($2::int, invitee.id)
        )
        ON CONFLICT DO NOTHING`,
        [sessionId, userId, friendIds]
    );
    return result.rowCount;
}

// Everything the session page shows:
// { id, name, createdAt, endedAt, owner, isOwner, me (my user id),
//   people: [{ user, status: 'joined' | 'invited' | 'left', isOwner, joinedAt, workingOn, totalMs }],
//   tasks:  [{ id, name, description, done, addedBy, sourceTaskId, createdAt, totalMs, time: [{ userId, ms }] }] }
// 'left' people are no longer members but booked time, so they still show up in the totals.
async function loadSharedSession(sessionId, userId) {
    const [session, members, tasks, times] = await Promise.all([
        pool.query(
            `SELECT shared_sessions.id, shared_sessions.name, shared_sessions.created_at, shared_sessions.ended_at,
                users.id AS owner_id, users.username AS owner_username, users.display_name AS owner_display_name
            FROM shared_sessions
            JOIN users ON users.id = shared_sessions.owner_id
            WHERE shared_sessions.id = $1`,
            [sessionId]
        ),
        pool.query(
            `SELECT shared_session_members.status, shared_session_members.joined_at,
                CASE WHEN shared_session_members.last_seen_at > now() - make_interval(secs => $2)
                    THEN shared_session_members.current_task_id END AS working_on,
                users.id, users.username, users.display_name
            FROM shared_session_members
            JOIN users ON users.id = shared_session_members.user_id
            WHERE shared_session_members.session_id = $1
            ORDER BY shared_session_members.status DESC, shared_session_members.joined_at, shared_session_members.invited_at`,
            [sessionId, ONLINE_SECONDS]
        ),
        pool.query(
            `SELECT shared_session_tasks.id, shared_session_tasks.name, shared_session_tasks.description,
                shared_session_tasks.done, shared_session_tasks.source_task_id, shared_session_tasks.created_at,
                users.id AS adder_id, users.username AS adder_username, users.display_name AS adder_display_name
            FROM shared_session_tasks
            LEFT JOIN users ON users.id = shared_session_tasks.added_by
            WHERE shared_session_tasks.session_id = $1
            ORDER BY shared_session_tasks.id`,
            [sessionId]
        ),
        pool.query(
            `SELECT shared_session_time.task_id, shared_session_time.time_ms,
                users.id, users.username, users.display_name
            FROM shared_session_time
            JOIN shared_session_tasks ON shared_session_tasks.id = shared_session_time.task_id
            JOIN users ON users.id = shared_session_time.user_id
            WHERE shared_session_tasks.session_id = $1 AND shared_session_time.time_ms > 0
            ORDER BY shared_session_time.time_ms DESC`,
            [sessionId]
        ),
    ]);

    const row = session.rows[0];
    if (!row) return null;

    const people = new Map();
    for (const member of members.rows) {
        people.set(member.id, {
            user: publicUser(member),
            status: member.status,
            isOwner: member.id === row.owner_id,
            joinedAt: member.joined_at,
            workingOn: member.working_on,
            totalMs: 0,
        });
    }

    const timeByTask = new Map();
    for (const time of times.rows) {
        const ms = Number(time.time_ms);
        if (!people.has(time.id)) {
            people.set(time.id, { user: publicUser(time), status: "left", isOwner: false, joinedAt: null, workingOn: null, totalMs: 0 });
        }
        people.get(time.id).totalMs += ms;
        if (!timeByTask.has(time.task_id)) timeByTask.set(time.task_id, []);
        timeByTask.get(time.task_id).push({ userId: time.id, ms });
    }

    return {
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        endedAt: row.ended_at,
        owner: publicUser(row, "owner_"),
        isOwner: row.owner_id === userId,
        me: userId,
        people: [...people.values()],
        tasks: tasks.rows.map(task => {
            const time = timeByTask.get(task.id) ?? [];
            return {
                id: task.id,
                name: task.name,
                description: task.description,
                done: task.done,
                addedBy: task.adder_id ? publicUser(task, "adder_") : null,
                // only the person who shared it can do anything with their own task's id
                sourceTaskId: task.adder_id === userId ? task.source_task_id : null,
                createdAt: task.created_at,
                totalMs: time.reduce((sum, t) => sum + t.ms, 0),
                time,
            };
        }),
    };
}

async function sendSharedSession(res, sessionId, userId, status = 200) {
    const session = await loadSharedSession(sessionId, userId);
    if (!session) return fail(res, 404, "SESSION_NOT_FOUND", "Session not found");
    res.status(status).json(session);
}

// My sessions (open first, newest first) and the invites waiting for me
app.get("/api/shared-sessions", async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `SELECT shared_sessions.id, shared_sessions.name, shared_sessions.created_at, shared_sessions.ended_at,
                shared_session_members.status, shared_session_members.invited_at,
                owner.id AS owner_id, owner.username AS owner_username, owner.display_name AS owner_display_name,
                inviter.id AS inviter_id, inviter.username AS inviter_username, inviter.display_name AS inviter_display_name,
                (SELECT count(*) FROM shared_session_members AS m
                    WHERE m.session_id = shared_sessions.id AND m.status = 'joined')::int AS member_count,
                (SELECT count(*) FROM shared_session_members AS m
                    WHERE m.session_id = shared_sessions.id AND m.current_task_id IS NOT NULL
                        AND m.last_seen_at > now() - make_interval(secs => $2))::int AS working_count,
                (SELECT COALESCE(sum(t.time_ms), 0) FROM shared_session_time AS t
                    JOIN shared_session_tasks AS st ON st.id = t.task_id
                    WHERE st.session_id = shared_sessions.id) AS total_ms,
                (SELECT COALESCE(sum(t.time_ms), 0) FROM shared_session_time AS t
                    JOIN shared_session_tasks AS st ON st.id = t.task_id
                    WHERE st.session_id = shared_sessions.id AND t.user_id = $1) AS my_ms
            FROM shared_session_members
            JOIN shared_sessions ON shared_sessions.id = shared_session_members.session_id
            JOIN users AS owner ON owner.id = shared_sessions.owner_id
            LEFT JOIN users AS inviter ON inviter.id = shared_session_members.invited_by
            WHERE shared_session_members.user_id = $1
            ORDER BY shared_sessions.ended_at IS NOT NULL, COALESCE(shared_sessions.ended_at, shared_sessions.created_at) DESC`,
            [userId, ONLINE_SECONDS]
        );
        const summary = row => ({
            id: row.id,
            name: row.name,
            createdAt: row.created_at,
            endedAt: row.ended_at,
            owner: publicUser(row, "owner_"),
            memberCount: row.member_count,
            workingCount: row.working_count,
            totalMs: Number(row.total_ms),
            myMs: Number(row.my_ms),
        });
        res.json({
            sessions: result.rows.filter(row => row.status === "joined").map(summary),
            invites: result.rows.filter(row => row.status === "invited").map(row => ({
                ...summary(row),
                invitedBy: row.inviter_id ? publicUser(row, "inviter_") : null,
                invitedAt: row.invited_at,
            })),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/shared-sessions/:id", async (req, res) => {
    const userId = req.user.userId;
    const sessionId = idParam(req.params.id);
    try {
        const membership = sessionId && await getMembership(sessionId, userId);
        if (!membership || membership.status !== "joined") {
            return fail(res, 404, "SESSION_NOT_FOUND", "Session not found");
        }
        await sendSharedSession(res, sessionId, userId);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Start a session: { name, friendIds? }. Only friends can be invited.
app.post("/api/shared-sessions", async (req, res) => {
    const userId = req.user.userId;
    const name = sessionName(req.body?.name);
    if (!name) return fail(res, 400, "NAME_REQUIRED", "Name is required");

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const created = await client.query(
            "INSERT INTO shared_sessions (name, owner_id) VALUES ($1, $2) RETURNING id",
            [name, userId]
        );
        const sessionId = created.rows[0].id;
        await client.query(
            `INSERT INTO shared_session_members (session_id, user_id, status, invited_by, joined_at)
            VALUES ($1, $2, 'joined', $2, now())`,
            [sessionId, userId]
        );
        await inviteFriends(client, sessionId, userId, idList(req.body?.friendIds));
        await client.query("COMMIT");
        await sendSharedSession(res, sessionId, userId, 201);
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Any member can invite their own friends: { userIds }
app.post("/api/shared-sessions/:id/invites", async (req, res) => {
    const userId = req.user.userId;
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;
        const invited = await inviteFriends(pool, session.sessionId, userId, idList(req.body?.userIds));
        if (invited === 0) return fail(res, 400, "NOTHING_TO_INVITE", "Nobody new to invite");
        await sendSharedSession(res, session.sessionId, userId);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Accept an invite
app.post("/api/shared-sessions/:id/join", async (req, res) => {
    const userId = req.user.userId;
    const sessionId = idParam(req.params.id);
    if (!sessionId) return fail(res, 404, "INVITE_NOT_FOUND", "Invite not found");
    try {
        const result = await pool.query(
            `UPDATE shared_session_members SET status = 'joined', joined_at = now()
            WHERE session_id = $1 AND user_id = $2 AND status = 'invited'
                AND session_id IN (SELECT id FROM shared_sessions WHERE ended_at IS NULL)
            RETURNING session_id`,
            [sessionId, userId]
        );
        if (result.rows.length === 0) return fail(res, 404, "INVITE_NOT_FOUND", "Invite not found");
        await sendSharedSession(res, sessionId, userId);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Leave or decline (my own id, or "me"), or, as the owner, remove a member or take back an invite.
// The owner can't leave their own session; they end or delete it instead.
app.delete("/api/shared-sessions/:id/members/:userId", async (req, res) => {
    const userId = req.user.userId;
    const sessionId = idParam(req.params.id);
    const targetId = req.params.userId === "me" ? userId : idParam(req.params.userId);
    if (!sessionId || !targetId) return fail(res, 404, "MEMBER_NOT_FOUND", "Member not found");
    try {
        const membership = await getMembership(sessionId, userId);
        if (!membership) return fail(res, 404, "SESSION_NOT_FOUND", "Session not found");
        const isOwner = membership.owner_id === userId;
        if (targetId !== userId && !isOwner) return fail(res, 403, "NOT_OWNER", "Only the owner can remove members");
        if (targetId === membership.owner_id) return fail(res, 400, "OWNER_CANNOT_LEAVE", "The owner can't leave the session");

        const result = await pool.query(
            "DELETE FROM shared_session_members WHERE session_id = $1 AND user_id = $2 RETURNING user_id",
            [sessionId, targetId]
        );
        if (result.rows.length === 0) return fail(res, 404, "MEMBER_NOT_FOUND", "Member not found");
        res.json({ sessionId, userId: targetId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Add a task: { taskId } shares one of my own tasks, { name, description } creates a new one
app.post("/api/shared-sessions/:id/tasks", async (req, res) => {
    const userId = req.user.userId;
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;

        let task;
        if (req.body?.taskId !== undefined) {
            const own = await pool.query(
                "SELECT id, name, description FROM tasks WHERE id = $1 AND user_id = $2",
                [idParam(req.body.taskId), userId]
            );
            if (own.rows.length === 0) return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
            task = { name: own.rows[0].name, description: own.rows[0].description, sourceTaskId: own.rows[0].id };
        } else {
            const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 200) : "";
            if (!name) return fail(res, 400, "NAME_REQUIRED", "Name is required");
            const description = typeof req.body?.description === "string" ? req.body.description.trim() || null : null;
            task = { name, description, sourceTaskId: null };
        }

        await pool.query(
            `INSERT INTO shared_session_tasks (session_id, name, description, added_by, source_task_id)
            VALUES ($1, $2, $3, $4, $5)`,
            [session.sessionId, task.name, task.description, userId, task.sourceTaskId]
        );
        await sendSharedSession(res, session.sessionId, userId, 201);
    } catch (err) {
        if (err.code === "23505") {
            return fail(res, 409, "TASK_ALREADY_SHARED", "This task is already in the session");
        }
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Mark a task done or not done: { done }. A task shared from someone's list is updated there too.
app.patch("/api/shared-sessions/:id/tasks/:taskId", async (req, res) => {
    const userId = req.user.userId;
    const taskId = idParam(req.params.taskId);
    if (typeof req.body?.done !== "boolean") return fail(res, 400, "DONE_REQUIRED", "done must be true or false");
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;
        const result = await pool.query(
            `UPDATE shared_session_tasks SET done = $1
            WHERE id = $2 AND session_id = $3
            RETURNING source_task_id`,
            [req.body.done, taskId, session.sessionId]
        );
        if (result.rows.length === 0) return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
        if (result.rows[0].source_task_id) {
            await pool.query("UPDATE tasks SET done = $1 WHERE id = $2", [req.body.done, result.rows[0].source_task_id]);
        }
        await sendSharedSession(res, session.sessionId, userId);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Remove a task (whoever added it, or the owner). Tasks with booked time stay,
// otherwise the record of who worked on it would be lost; mark them done instead.
app.delete("/api/shared-sessions/:id/tasks/:taskId", async (req, res) => {
    const userId = req.user.userId;
    const taskId = idParam(req.params.taskId);
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;
        const task = await pool.query(
            `SELECT added_by,
                EXISTS (SELECT 1 FROM shared_session_time WHERE task_id = $1 AND time_ms > 0) AS has_time
            FROM shared_session_tasks WHERE id = $1 AND session_id = $2`,
            [taskId, session.sessionId]
        );
        if (task.rows.length === 0) return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
        if (task.rows[0].added_by !== userId && !session.isOwner) {
            return fail(res, 403, "NOT_ALLOWED", "Only who added the task or the owner can remove it");
        }
        if (task.rows[0].has_time) return fail(res, 409, "TASK_HAS_TIME", "Somebody already worked on this task");
        await pool.query("DELETE FROM shared_session_tasks WHERE id = $1", [taskId]);
        await sendSharedSession(res, session.sessionId, userId);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// What I'm doing: { currentTaskId (null = not working), time?: { taskId, ms } }.
// `time` books the milliseconds worked since the last report on that task.
app.post("/api/shared-sessions/:id/activity", async (req, res) => {
    const userId = req.user.userId;
    const currentTaskId = req.body?.currentTaskId == null ? null : idParam(req.body.currentTaskId);
    const time = req.body?.time;
    const bookTaskId = time ? idParam(time.taskId) : null;
    const ms = time ? Math.round(Number(time.ms)) : 0;

    if (req.body?.currentTaskId != null && !currentTaskId) return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
    if (time && (!bookTaskId || !Number.isFinite(ms) || ms < 0 || ms > MAX_REPORT_MS)) {
        return fail(res, 400, "INVALID_TIME", `time.ms must be between 0 and ${MAX_REPORT_MS}`);
    }

    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;

        const wanted = [currentTaskId, bookTaskId].filter(Boolean);
        if (wanted.length > 0) {
            const found = await pool.query(
                "SELECT id FROM shared_session_tasks WHERE session_id = $1 AND id = ANY($2::int[])",
                [session.sessionId, wanted]
            );
            if (found.rows.length < new Set(wanted).size) return fail(res, 404, "TASK_NOT_FOUND", "Task not found");
        }

        if (bookTaskId && ms > 0) {
            await pool.query(
                `INSERT INTO shared_session_time (task_id, user_id, time_ms) VALUES ($1, $2, $3)
                ON CONFLICT (task_id, user_id)
                DO UPDATE SET time_ms = shared_session_time.time_ms + EXCLUDED.time_ms, updated_at = now()`,
                [bookTaskId, userId, ms]
            );
        }
        await pool.query(
            `UPDATE shared_session_members SET current_task_id = $1, last_seen_at = now()
            WHERE session_id = $2 AND user_id = $3`,
            [currentTaskId, session.sessionId, userId]
        );
        await sendSharedSession(res, session.sessionId, userId);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// End the session (owner). It stays visible with its totals, but nobody can change it any more.
app.post("/api/shared-sessions/:id/end", async (req, res) => {
    const userId = req.user.userId;
    const client = await pool.connect();
    try {
        const session = await requireOpenSession(req, res);
        if (!session) return;
        if (!session.isOwner) return fail(res, 403, "NOT_OWNER", "Only the owner can end the session");

        await client.query("BEGIN");
        await client.query("UPDATE shared_sessions SET ended_at = now() WHERE id = $1", [session.sessionId]);
        // open invites expire, nobody is working any more
        await client.query("DELETE FROM shared_session_members WHERE session_id = $1 AND status = 'invited'", [session.sessionId]);
        await client.query("UPDATE shared_session_members SET current_task_id = NULL WHERE session_id = $1", [session.sessionId]);
        await client.query("COMMIT");
        await sendSharedSession(res, session.sessionId, userId);
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Delete the session with all its tasks and times (owner)
app.delete("/api/shared-sessions/:id", async (req, res) => {
    const userId = req.user.userId;
    const sessionId = idParam(req.params.id);
    if (!sessionId) return fail(res, 404, "SESSION_NOT_FOUND", "Session not found");
    try {
        const result = await pool.query(
            "DELETE FROM shared_sessions WHERE id = $1 AND owner_id = $2 RETURNING id",
            [sessionId, userId]
        );
        if (result.rows.length === 0) return fail(res, 404, "SESSION_NOT_FOUND", "Session not found");
        res.json({ id: sessionId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

//listen for requests on this url
app.listen(PORT, () => {
    console.log(`Server runnin on http://localhost:${PORT}`);
});

// net start postgresql-x64-18