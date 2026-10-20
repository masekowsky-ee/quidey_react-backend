const crypto = require("node:crypto");

// Hash a raw token so only the hash is stored in the database
function hashToken(rawToken) {
    return crypto.createHash("sha256").update(rawToken).digest("hex");
}

// Create a new token for a user, store its hash, return the raw token
async function createVerificationToken(db, userId) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // Remove older tokens so only the latest link is valid
    await db.query("DELETE FROM email_verification_tokens WHERE user_id = $1", [userId]);

    await db.query(
        "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
        [userId, hashToken(rawToken), expiresAt]
    );

    return rawToken;
}

module.exports = { hashToken, createVerificationToken };
