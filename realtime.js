// Real-time delivery over Socket.IO: direct messages, the shared sessions' chat and the
// team's notices arrive right away instead of on the next poll.
//
// A socket signs in with the same login token as the API (handshake `auth.token`) and needs the
// same access (token_version, pro or admin). Every socket is in the room `user:<id>`, so
// everything for one person reaches all their open tabs; a shared session page also joins
// `session:<id>` (members only, checked in the database). Nothing is stored here: the sockets
// only carry what the API already saved.
//
// Events to the browser:
//   message:new       { user, message }      a direct message (to both people, fromMe set per side)
//   inbox:read        { userId? }             messages or notices were read/deleted (badge counts changed)
//   notification:new  { id, kind, title, body, createdAt, readAt, data? }  (an admin's broadcast,
//                     or kind task_assigned: somebody gave me a task in a shared session)
//   session:event     { sessionId, event }    a new chat message in a shared session
//   session:changed   { sessionId }           tasks, members, name or who works on what changed
//                                             (not sent for the regular time reports)
//   invites:changed   {}                      my session invites changed
//   friends:changed   {}                      a friend request or friendship involving me changed
//   tasks:changed     { taskId }              a task shared with me (or by me) changed
//   family:changed    { familyId }            a family I'm in or invited to changed (members,
//                                             name, calendar entries), or it was deleted
//   family:message    { familyId, message }   a new message in a family's chat (testers only)
//   feed:changed      {}                      an entry in my feed came, changed or went (mine
//                                             or a friend's), or somebody cheered mine on
//   feed:cheered      { user, entryId }       a friend cheered one of my feed entries on
// The *:changed events carry no data on purpose: the app loads what it shows again, so nothing
// can get out of step, and the server only does that work when something actually changed.
// From the browser:
//   session:join (sessionId, ack?)  /  session:leave (sessionId)

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const pool = require("./db");
const { hasAppAccess } = require("./utils/access");

// how many session rooms one socket can be in (a page shows one session at a time)
const MAX_SESSION_ROOMS = 5;

let io = null;

const userRoom = (userId) => `user:${userId}`;
const sessionRoom = (sessionId) => `session:${sessionId}`;

// The account behind a login token, or null when it isn't valid (any more) or has no access
async function accountFor(token, algorithm) {
    if (typeof token !== "string" || !token) return null;
    let payload;
    try {
        payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: [algorithm] });
    } catch {
        return null;
    }
    const result = await pool.query(
        "SELECT id, is_pro, is_tester, is_admin, token_version FROM users WHERE id = $1",
        [payload.userId]
    );
    const account = result.rows[0];
    if (!account || account.token_version !== (payload.tv ?? 0)) return null;
    if (!hasAppAccess(account)) return null;
    return account;
}

function initRealtime(server, { allowedOrigins, tokenAlgorithm }) {
    io = new Server(server, {
        cors: { origin: allowedOrigins },
        // nothing the app sends is anywhere near this
        maxHttpBufferSize: 10 * 1024,
        serveClient: false,
    });

    io.use(async (socket, next) => {
        try {
            const account = await accountFor(socket.handshake.auth?.token, tokenAlgorithm);
            if (!account) return next(new Error("UNAUTHORIZED"));
            socket.data.userId = account.id;
            next();
        } catch (err) {
            console.error(err);
            next(new Error("SERVER_ERROR"));
        }
    });

    io.on("connection", (socket) => {
        const userId = socket.data.userId;
        socket.join(userRoom(userId));

        // Follow a shared session's chat. Only joined members get in; ack({ ok }) says whether.
        socket.on("session:join", async (rawId, ack) => {
            const reply = typeof ack === "function" ? ack : () => {};
            const sessionId = Number(rawId);
            if (!Number.isInteger(sessionId) || sessionId <= 0 || sessionId > 2147483647) return reply({ ok: false });
            const rooms = [...socket.rooms].filter(room => room.startsWith("session:"));
            if (rooms.length >= MAX_SESSION_ROOMS && !socket.rooms.has(sessionRoom(sessionId))) return reply({ ok: false });
            try {
                const result = await pool.query(
                    "SELECT 1 FROM shared_session_members WHERE session_id = $1 AND user_id = $2 AND status = 'joined'",
                    [sessionId, userId]
                );
                if (result.rows.length === 0) return reply({ ok: false });
                socket.join(sessionRoom(sessionId));
                reply({ ok: true });
            } catch (err) {
                console.error(err);
                reply({ ok: false });
            }
        });

        socket.on("session:leave", (rawId) => {
            socket.leave(sessionRoom(Number(rawId)));
        });
    });

    return io;
}

// ---------- sending (no-ops before initRealtime, e.g. while a module is tested on its own) ----------

function toUser(userId, event, payload) {
    io?.to(userRoom(userId)).emit(event, payload);
}

function toSession(sessionId, event, payload) {
    io?.to(sessionRoom(sessionId)).emit(event, payload);
}

// Somebody is no longer a member: their sockets stop getting the session's chat
function leaveSession(sessionId, userId) {
    io?.in(userRoom(userId)).socketsLeave(sessionRoom(sessionId));
}

// The session was deleted: everybody leaves its room
function closeSession(sessionId) {
    io?.in(sessionRoom(sessionId)).socketsLeave(sessionRoom(sessionId));
}

// Signed out everywhere, password changed, pro taken away, account deleted: the open sockets
// are closed. The app connects again with a valid token, if it still has one.
function disconnectUser(userId) {
    io?.in(userRoom(userId)).disconnectSockets(true);
}

module.exports = { initRealtime, toUser, toSession, leaveSession, closeSession, disconnectUser };
