const nodemailer = require("nodemailer");

const transporter = process.env.SMTP_HOST
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false, // STARTTLS on port 587
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
    : null;

// Where the links in mails point to; default: the vite dev server
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");

async function sendVerificationMail(to, rawToken) {
    const link = `${FRONTEND_URL}/verify-email?token=${rawToken}`;

    // Dev fallback: no SMTP configured, just print the link
    if (!transporter) {
        console.log(`[DEV] Verification link for ${to}: ${link}`);
        return;
    }

    await transporter.sendMail({
        from: `"Quidey" <${process.env.MAIL_FROM}>`,
        to,
        subject: "Bitte bestätige deine E-Mail-Adresse",
        text: `Willkommen bei Quidey!\n\nBestätige deine Adresse hier:\n${link}\n\nDer Link ist 24 Stunden gültig.`,
        html: `<p>Willkommen bei Quidey!</p>
           <p><a href="${link}">E-Mail-Adresse bestätigen</a></p>
           <p>Der Link ist 24 Stunden gültig.</p>`,
    });
}

// A message from the contact form (the second way to reach the operator the Impressum needs)
// to CONTACT_TO. Plain text only, so nothing the sender typed can turn into HTML; "Antworten"
// goes straight to the sender's address.
async function sendContactMail({ name, email, message }) {
    const to = process.env.CONTACT_TO;
    const text = `Nachricht über das Kontaktformular von Quidey\n\nName: ${name}\nE-Mail: ${email}\n\n${message}\n`;

    // Dev fallback: no SMTP or no recipient configured, just print the message
    if (!transporter || !to) {
        console.log(`[DEV] Contact message${to ? "" : " (CONTACT_TO is not set)"}:\n${text}`);
        return;
    }

    await transporter.sendMail({
        from: `"Quidey Kontaktformular" <${process.env.MAIL_FROM}>`,
        to,
        replyTo: { name, address: email },
        subject: `Kontaktformular: ${name}`,
        text,
    });
}

const FEEDBACK_LABELS = { idea: "Idee", bug: "Fehler", praise: "Lob", other: "Sonstiges" };

// Feedback from a signed-in user to CONTACT_TO; plain text, "Antworten" goes to the user
async function sendFeedbackMail({ category, message, page, user }) {
    const to = process.env.CONTACT_TO;
    const label = FEEDBACK_LABELS[category] ?? category;
    const who = `${user.display_name || user.username} (@${user.username})`;
    const text = `Feedback aus Quidey: ${label}\n\nVon: ${who}\nE-Mail: ${user.email}\n${page ? `Seite: ${page}\n` : ""}\n${message}\n`;

    if (!transporter || !to) {
        console.log(`[DEV] Feedback${to ? "" : " (CONTACT_TO is not set)"}:\n${text}`);
        return;
    }

    await transporter.sendMail({
        from: `"Quidey Feedback" <${process.env.MAIL_FROM}>`,
        to,
        replyTo: { name: user.display_name || user.username, address: user.email },
        subject: `Feedback (${label}): ${message.replace(/\s+/g, " ").slice(0, 60)}`,
        text,
    });
}

module.exports = { sendVerificationMail, sendContactMail, sendFeedbackMail };
