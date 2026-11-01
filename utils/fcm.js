// Push notifications to the Android app: Firebase Cloud Messaging (FCM HTTP v1 API).
// The app signs a device up with its FCM registration token, stored as the endpoint
// 'fcm:<token>' in push_subscriptions (no Web Push keys); utils/push.js hands such devices here.
//
// The server signs in as a service account of the Firebase project: FIREBASE_SERVICE_ACCOUNT_FILE
// is the path to its JSON key (Firebase console → Project settings → Service accounts →
// "Generate new private key"; keep it outside the repo, readable only by the server's user).
// Without it nothing goes to the app: each message is only logged, like Web Push without VAPID keys.
//
// The notification shows with the kind as Android notification channel (plan, digest, messages,
// social: the app creates them, so each can be muted in Android's settings), the monochrome logo
// (ic_stat_quidey) and the accent colour; `data.url` is the page a tap opens.

const { readFileSync } = require("node:fs");
const { JWT } = require("google-auth-library");

const FILE = process.env.FIREBASE_SERVICE_ACCOUNT_FILE || "";
let account = null;
if (FILE) {
    try {
        account = JSON.parse(readFileSync(FILE, "utf8"));
    } catch (err) {
        console.error(`FIREBASE_SERVICE_ACCOUNT_FILE can't be read (${err.message}): no pushes to the Android app.`);
    }
}
const ENABLED = Boolean(account?.client_email && account?.private_key && account?.project_id);
const client = ENABLED
    ? new JWT({ email: account.client_email, key: account.private_key, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] })
    : null;

const PREFIX = "fcm:";
const isFcmEndpoint = (endpoint) => typeof endpoint === "string" && endpoint.startsWith(PREFIX);
// what an FCM registration token looks like (letters, digits, "_", "-", ":"), a little room for growth
const FCM_ENDPOINT = /^fcm:[A-Za-z0-9_:-]{20,4096}$/;

// One message to one device: 'sent', 'gone' (the token isn't valid any more: the app was removed,
// its data cleared, or it belongs to another Firebase project) or 'failed'. Never throws.
async function sendFcm(endpoint, kind, message, ttlSeconds) {
    try {
        const { token } = await client.getAccessToken();
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                message: {
                    token: endpoint.slice(PREFIX.length),
                    notification: { title: message.title, body: message.body },
                    // data values must be strings
                    data: { url: message.url || "/", kind, tag: message.tag || "" },
                    android: {
                        ttl: `${ttlSeconds}s`,
                        priority: kind === "digest" ? "NORMAL" : "HIGH",
                        notification: {
                            channel_id: kind,
                            icon: "ic_stat_quidey",
                            color: "#FB923C",
                            ...(message.tag ? { tag: message.tag } : {}),
                        },
                    },
                },
            }),
        });
        if (res.ok) return "sent";
        const body = await res.json().catch(() => ({}));
        const code = (body?.error?.details ?? []).find((detail) => detail?.errorCode)?.errorCode;
        if (res.status === 404 || code === "UNREGISTERED" || code === "SENDER_ID_MISMATCH") return "gone";
        console.error(`FCM push failed: ${res.status} ${code ?? ""} ${body?.error?.message ?? ""}`);
        return "failed";
    } catch (err) {
        console.error("FCM push failed:", err.message);
        return "failed";
    }
}

module.exports = { FCM_ENABLED: ENABLED, FCM_ENDPOINT, isFcmEndpoint, sendFcm };
