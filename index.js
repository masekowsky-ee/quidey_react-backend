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



//listen for requests on this url
app.listen(PORT, () => {
    console.log(`Server runnin on http://localhost:${PORT}`);
});

// net start postgresql-x64-18