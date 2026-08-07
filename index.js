const express = require('express');
const cors = require("cors");
const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

//allows requests from other servers (eg. localhost of quidey)
app.use(cors());
app.use(express.json()); //parse json bodies

//get endpoints
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
})



//listen for requests on this url
app.listen(PORT, () => {
    console.log(`Server runnin on http://localhost:${PORT}`);
});
