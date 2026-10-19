// Manage beta access from the command line (uses the same .env as the server):
//
//   npm run pro -- list                 users with pro
//   npm run pro -- requests [all]       open beta requests (all: also decided ones)
//   npm run pro -- grant <username>     give pro (also approves their request, if any)
//   npm run pro -- revoke <username>    take pro away
//   npm run pro -- decline <username>   decline their request (they can't ask again)
//   npm run pro -- admin <username>     make admin (sees the admin panel in the app)
//   npm run pro -- unadmin <username>   take admin away
//
// Changes apply right away: the server checks pro on every request.
process.env.DOTENV_CONFIG_QUIET = "true"; // no dotenv banner in the output
const pool = require("../db");

async function findUser(username) {
    if (!username) throw new Error("Which user? e.g. npm run pro -- grant testUser1");
    const result = await pool.query("SELECT id, username, is_pro FROM users WHERE lower(username) = lower($1)", [username]);
    if (result.rows.length === 0) throw new Error(`No user named "${username}"`);
    return result.rows[0];
}

const commands = {
    async list() {
        const result = await pool.query("SELECT username, display_name, is_pro, is_admin FROM users WHERE is_pro OR is_admin ORDER BY lower(username)");
        if (result.rows.length === 0) return console.log("Nobody has pro or admin yet.");
        console.table(result.rows);
    },

    async requests(scope) {
        const result = await pool.query(
            `SELECT users.username, beta_access_requests.status, to_char(beta_access_requests.created_at, 'YYYY-MM-DD HH24:MI') AS asked_on,
                beta_access_requests.reason
            FROM beta_access_requests JOIN users ON users.id = beta_access_requests.user_id
            WHERE $1 OR beta_access_requests.status = 'pending'
            ORDER BY beta_access_requests.created_at`,
            [scope === "all"]
        );
        if (result.rows.length === 0) return console.log(scope === "all" ? "No requests yet." : "No open requests.");
        console.table(result.rows);
    },

    async grant(username) {
        const user = await findUser(username);
        await pool.query("UPDATE users SET is_pro = true WHERE id = $1", [user.id]);
        await pool.query(
            "UPDATE beta_access_requests SET status = 'approved', decided_at = now() WHERE user_id = $1 AND status <> 'approved'",
            [user.id]
        );
        console.log(user.is_pro ? `${user.username} already had pro.` : `${user.username} has pro now.`);
    },

    async revoke(username) {
        const user = await findUser(username);
        await pool.query("UPDATE users SET is_pro = false WHERE id = $1", [user.id]);
        console.log(user.is_pro ? `${user.username} no longer has pro.` : `${user.username} didn't have pro.`);
    },

    async decline(username) {
        const user = await findUser(username);
        const result = await pool.query(
            "UPDATE beta_access_requests SET status = 'declined', decided_at = now() WHERE user_id = $1 RETURNING user_id",
            [user.id]
        );
        console.log(result.rows.length ? `Declined the request of ${user.username}.` : `${user.username} hasn't asked for access.`);
    },

    async admin(username) {
        const user = await findUser(username);
        await pool.query("UPDATE users SET is_admin = true WHERE id = $1", [user.id]);
        console.log(`${user.username} is admin now.`);
    },

    async unadmin(username) {
        const user = await findUser(username);
        await pool.query("UPDATE users SET is_admin = false WHERE id = $1", [user.id]);
        console.log(`${user.username} is no longer admin.`);
    },
};

async function main() {
    const [command, arg] = process.argv.slice(2);
    if (!commands[command]) {
        console.log("Usage: npm run pro -- list | requests [all] | grant <username> | revoke <username> | decline <username> | admin <username> | unadmin <username>");
        process.exitCode = 1;
        return;
    }
    await commands[command](arg);
}

main()
    .catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
