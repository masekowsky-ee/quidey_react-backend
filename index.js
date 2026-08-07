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
        
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
})

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
})



//listen for requests on this url
app.listen(PORT, () => {
    console.log(`Server runnin on http://localhost:${PORT}`);
});
