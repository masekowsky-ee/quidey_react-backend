const express = require('express');
const cors = require("cors");
const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

//allows requests from other servers (eg. localhost of quidey)
app.use(cors());
app.use(express.json()); //parse json bodies

//GET endpoints
app.get("/api/hello", (req, res) => {
    res.json({ message: "Hello, this is the backend!" });
});

app.get("/api/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ success: true, time: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/tasks", async (req, res) => {
    try{
        const result = await pool.query("SELECT * FROM tasks ORDER BY id");
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});
//for debugging
app.get("/api/task-groups", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM task_groups");
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message});
    }
});

app.get("/api/tasks/:id/groups", async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `SELECT groups.id, groups.name, groups.description
            FROM groups
            JOIN task_groups ON groups.id = task_groups.group_id
            WHERE task_groups.task_id = $1`,
            [id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/groups/:id/tasks", async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `SELECT tasks.id, tasks.name, tasks.description
            FROM tasks
            JOIN task_groups ON tasks.id = task_groups.task_id
            WHERE task_groups.group_id = $1`,
            [id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/groups", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM groups ORDER BY id");
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/tasks/:taskId/notes", async (req, res) => {
    const { taskId } = req.params;

    try {
       const result = await pool.query(
       "SELECT * FROM notes WHERE task_id = $1 ORDER BY id",
        [taskId]
    );
    res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/sessions", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM sessions ORDER BY id DESC");
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/sessions/:id/tasks", async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `SELECT tasks.id, tasks.name, tasks.due, tasks.description, tasks.prio, tasks.done
            FROM tasks
            JOIN session_tasks ON tasks.id = session_tasks.task_id
            WHERE session_tasks.session_id = $1`,
            [id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

//POST endpoints
app.post("/api/tasks", async (req, res) => {
    const { name, due, description, prio } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO tasks (name, due, description, prio) 
            VALUES ($1, $2, $3, $4) 
            RETURNING *`,
            [name, due, description, prio]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/groups", async (req, res) => {
    const { name, description } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO groups (name, description)
            VALUES ($1, $2)
            RETURNING *`,
            [name, description]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/tasks/:taskId/groups/:groupId", async (req, res) => {
    const { taskId, groupId } = req.params;

    try { 
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

    try {
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
    const { group_id, time_ms } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO sessions (group_id, time_ms)
            VALUES ($1, $2)
            RETURNING *`,
            [group_id, time_ms]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/sessions/:sessionId/tasks/:taskId", async (req, res) => {
    const { sessionId, taskId } = req.params;

    try{
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

//PUT endpoints
app.put("/api/tasks/:id", async (req, res) => {
    const { id } = req.params;
    const { name, due, description, prio, done } = req.body;

    try {
        const result = await pool.query(
            `UPDATE tasks
            SET name = $1, due = $2, description = $3, prio = $4, done = $5
            WHERE id = $6
            RETURNING *`,
            [name, due, description, prio, done, id]
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

    try {
        const result = await pool.query(
            `UPDATE groups
            SET name = $1, description = $2
            WHERE id = $3
            RETURNING *`,
            [name, description, id]
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

    try {
        const result = await pool.query(
            `UPDATE notes
            SET content = $1
            WHERE id = $2
            RETURNING *`,
            [content, id]
        )

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Task not found" });
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

    try {
        const result = await pool.query(
            "DELETE FROM tasks WHERE id = $1 RETURNING *",
            [id]
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

    try {
        const result = await pool.query(
            "DELETE FROM groups WHERE id = $1 RETURNING *",
            [id]
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

app.delete("/api/notes/:id", async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            "DELETE FROM notes WHERE id = $1 RETURNING *",
            [id]
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