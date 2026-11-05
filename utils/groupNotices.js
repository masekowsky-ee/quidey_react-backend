// What the other people in my families and shared sessions hear about what I do there:
//   - an entry I add (or move / copy in): a notice in their inbox (kind entries_added) and a
//     push of the kind "groups"; several of mine in a row at the same place, within
//     BUNDLE_WINDOW and while unread, are one notice ("Ann added 4 entries")
//   - a family entry I give to somebody: a notice (kind task_assigned, data.familyId) and a push
//     of the kind "social", like in a session
//   - a chat message: a push of the kind "groups" (the chat itself is where it is read)
// Only joined members with app access, never the one who did it. Never throws: a notice is
// never worth an error, and the routes call these after answering.

const realtime = require("../realtime");
const { APP_ACCESS_SQL } = require("./access");
const { pushToUsers, PUSH_TEXTS } = require("./push");

const BUNDLE_WINDOW = "30 minutes";

// A notification as the app gets it (list and live); data only for kinds that have some
// (task_assigned: { sessionId | familyId, taskId, by }; entries_added: { place, placeId, entryId, count, by })
const toNotice = (row) => ({
    id: row.id, kind: row.kind, title: row.title, body: row.body, createdAt: row.created_at, readAt: row.read_at,
    ...(row.data && { data: row.data }),
});

const PLACES = {
    family: { table: "families", members: "family_members", key: "family_id" },
    session: { table: "shared_sessions", members: "shared_session_members", key: "session_id" },
};

// { kind, id, name } of a family / session, its joined members (with app access) and who did it
async function load(pool, place, placeId, byId) {
    const { table, members, key } = PLACES[place];
    const [found, joined, by] = await Promise.all([
        pool.query(`SELECT name FROM ${table} WHERE id = $1`, [placeId]),
        pool.query(
            `SELECT ${members}.user_id FROM ${members} JOIN users ON users.id = ${members}.user_id
            WHERE ${members}.${key} = $1 AND ${members}.status = 'joined' AND ${APP_ACCESS_SQL}`,
            [placeId]
        ),
        pool.query("SELECT id, username, display_name FROM users WHERE id = $1", [byId]),
    ]);
    if (!found.rows[0] || !by.rows[0]) return null;
    return {
        place: { kind: place, id: placeId, name: found.rows[0].name },
        readers: joined.rows.map(row => row.user_id).filter(id => id !== byId),
        by: { id: by.rows[0].id, username: by.rows[0].username, displayName: by.rows[0].display_name },
    };
}

// skip: who hears of it another way (the one a new family entry is given to gets task_assigned)
async function noticeEntryAdded(pool, { place, placeId, byId, entryId, name, skip = [] }) {
    try {
        const loaded = await load(pool, place, placeId, byId);
        if (!loaded) return;
        for (const reader of loaded.readers.filter(id => !skip.includes(id))) {
            const row = await bundleNotice(pool, reader, { place, placeId, byId, entryId, name, placeName: loaded.place.name, by: loaded.by });
            realtime.toUser(reader, "notification:new", toNotice(row));
            pushToUsers(pool, [reader], "groups", (language) => PUSH_TEXTS.entriesAdded({ from: loaded.by, place: loaded.place, count: row.data.count, name }, language));
        }
    } catch (err) {
        console.error("Notice about a new entry failed:", err);
    }
}

// One reader's notice: the same person at the same place a moment ago, still unread, counts one
// more; else a new one. Entries added at the same moment wait for each other (a lock per reader),
// so they still make one notice.
async function bundleNotice(pool, reader, { place, placeId, byId, entryId, name, placeName, by }) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('entries_added'), $1)", [reader]);
        let row = (await client.query(
            `UPDATE notifications SET title = left($5, 120), created_at = now(),
                data = jsonb_set(data, '{count}', to_jsonb((data->>'count')::int + 1))
            WHERE id = (
                SELECT id FROM notifications
                WHERE user_id = $1 AND kind = 'entries_added' AND read_at IS NULL
                    AND data->>'place' = $2 AND (data->>'placeId')::int = $3 AND (data#>>'{by,id}')::int = $4
                    AND created_at > now() - interval '${BUNDLE_WINDOW}'
                ORDER BY created_at DESC LIMIT 1
            )
            RETURNING id, kind, title, body, data, created_at, read_at`,
            [reader, place, placeId, byId, name]
        )).rows[0];
        if (!row) {
            row = (await client.query(
                `INSERT INTO notifications (user_id, kind, title, body, data)
                VALUES ($1, 'entries_added', left($2, 120), $3, $4)
                RETURNING id, kind, title, body, data, created_at, read_at`,
                [reader, name, placeName, { place, placeId, entryId, count: 1, by }]
            )).rows[0];
        }
        await client.query("COMMIT");
        return row;
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function noticeFamilyAssigned(pool, { familyId, entryId, name, byId, assigneeId }) {
    if (!assigneeId || assigneeId === byId) return;
    try {
        const loaded = await load(pool, "family", familyId, byId);
        if (!loaded || !loaded.readers.includes(assigneeId)) return;
        const row = (await pool.query(
            `INSERT INTO notifications (user_id, kind, title, body, data)
            VALUES ($1, 'task_assigned', left($2, 120), $3, $4)
            RETURNING id, kind, title, body, data, created_at, read_at`,
            [assigneeId, name, loaded.place.name, { familyId, taskId: entryId, by: loaded.by }]
        )).rows[0];
        realtime.toUser(assigneeId, "notification:new", toNotice(row));
        pushToUsers(pool, [assigneeId], "social", (language) => PUSH_TEXTS.familyAssigned({ from: loaded.by, name, family: loaded.place.name, familyId }, language));
    } catch (err) {
        console.error("Notice about a given entry failed:", err);
    }
}

async function pushChat(pool, { place, placeId, byId, text }) {
    try {
        const loaded = await load(pool, place, placeId, byId);
        if (!loaded) return;
        pushToUsers(pool, loaded.readers, "groups", () => PUSH_TEXTS.chat({ from: loaded.by, place: loaded.place, body: text }));
    } catch (err) {
        console.error("Chat push failed:", err);
    }
}

module.exports = { toNotice, noticeEntryAdded, noticeFamilyAssigned, pushChat };
