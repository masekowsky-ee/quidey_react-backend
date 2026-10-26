const nodemailer = require("nodemailer");
const { renderMail, escapeHtml, textToHtml } = require("./mailTemplate");

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

// The two languages of the app; anything else gets German
const langOf = (language) => (language === "en" ? "en" : "de");

// Every mail goes out with a text and an HTML part (some people read mails as plain text)
async function send({ from = "Quidey", ...mail }) {
    await transporter.sendMail({ from: `"${from}" <${process.env.MAIL_FROM}>`, ...mail });
}

const linkHtml = (url) =>
    `<a href="${escapeHtml(url)}" style="color:#c2410c;word-break:break-all;" class="q-link">${escapeHtml(url)}</a>`;

const VERIFICATION = {
    de: {
        subject: "Bitte bestätige deine E-Mail-Adresse",
        preheader: "Ein Klick, und dein Konto ist bereit.",
        heading: "Willkommen bei Quidey",
        intro: "Schön, dass du da bist! Bestätige kurz deine E-Mail-Adresse, dann kann es losgehen.",
        button: "E-Mail-Adresse bestätigen",
        valid: "Der Link ist 24 Stunden gültig.",
        fallback: "Funktioniert der Button nicht? Kopiere diesen Link in deinen Browser:",
        notYou: "Du hast dich nicht bei Quidey registriert? Dann kannst du diese Mail einfach ignorieren.",
    },
    en: {
        subject: "Please confirm your email address",
        preheader: "One click and your account is ready.",
        heading: "Welcome to Quidey",
        intro: "Great to have you! Quickly confirm your email address and you're ready to go.",
        button: "Confirm email address",
        valid: "The link is valid for 24 hours.",
        fallback: "Button not working? Copy this link into your browser:",
        notYou: "Didn't sign up for Quidey? Then you can simply ignore this mail.",
    },
};

async function sendVerificationMail(to, rawToken, language) {
    const link = `${FRONTEND_URL}/verify-email?token=${rawToken}`;

    // Dev fallback: no SMTP configured, just print the link
    if (!transporter) {
        console.log(`[DEV] Verification link for ${to}: ${link}`);
        return;
    }

    const lang = langOf(language);
    const copy = VERIFICATION[lang];
    await send({
        to,
        subject: copy.subject,
        text: `${copy.heading}!\n\n${copy.intro}\n\n${link}\n\n${copy.valid}\n\n${copy.notYou}`,
        html: renderMail({
            lang,
            preheader: copy.preheader,
            heading: copy.heading,
            paragraphs: [escapeHtml(copy.intro)],
            button: { label: copy.button, url: link },
            after: [escapeHtml(copy.valid), `${escapeHtml(copy.fallback)}<br>${linkHtml(link)}`],
            footer: escapeHtml(copy.notYou),
            homeUrl: FRONTEND_URL,
        }),
    });
}

const REMINDER = {
    de: {
        subject: (name, time) => (time ? `Erinnerung: ${name} um ${time}` : `Erinnerung: ${name}`),
        allDay: "ganztägig",
        preheader: (when) => `${when} – deine Erinnerung von Quidey`,
        intro: "Kleine Erinnerung – das steht gleich an:",
        when: "Wann",
        where: "Ort",
        link: "Link",
        note: "Notiz",
        today: "Heute",
        tomorrow: "Morgen",
        button: "In Quidey öffnen",
        why: "Du bekommst diese Mail, weil bei dieser Aufgabe „Auch per E-Mail erinnern“ eingeschaltet ist. Ausschalten kannst du das in der Aufgabe unter „Weitere Optionen“.",
    },
    en: {
        subject: (name, time) => (time ? `Reminder: ${name} at ${time}` : `Reminder: ${name}`),
        allDay: "all day",
        preheader: (when) => `${when} – your reminder from Quidey`,
        intro: "A quick reminder – this is coming up:",
        when: "When",
        where: "Where",
        link: "Link",
        note: "Note",
        today: "Today",
        tomorrow: "Tomorrow",
        button: "Open in Quidey",
        why: "You get this mail because “Also remind me by email” is on for this task. You can turn it off in the task under “More options”.",
    },
};

// "YYYY-MM-DD" of today in a time zone
const todayIn = (timezone) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());

// "Heute" / "Morgen" / "Freitag, 24. Oktober" for a "YYYY-MM-DD" day, seen from the user's time zone
function dayText(day, timezone, lang) {
    const copy = REMINDER[lang];
    const today = todayIn(timezone);
    const tomorrow = new Date(`${today}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    if (day === today) return copy.today;
    if (day === tomorrow.toISOString().slice(0, 10)) return copy.tomorrow;
    return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
        .format(new Date(`${day}T12:00:00Z`));
}

// "HH:MM" plus minutes, as "HH:MM" (wraps past midnight)
function addMinutes(time, minutes) {
    const [h, m] = time.split(":").map(Number);
    const total = (h * 60 + m + minutes) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// A task's reminder, to its owner.
// task: { name, due ("YYYY-MM-DD"), due_time ("HH:MM", null: the whole day), duration_minutes, location, link, description }
// user: { email, language, timezone }
async function sendReminderMail(task, user) {
    const lang = langOf(user.language);
    const copy = REMINDER[lang];
    const time = task.due_time;
    const range = !time ? copy.allDay : task.duration_minutes ? `${time} – ${addMinutes(time, task.duration_minutes)}` : time;
    const when = `${dayText(task.due, user.timezone, lang)}, ${range}`;
    const open = `${FRONTEND_URL}/calendar`;

    if (!transporter) {
        console.log(`[DEV] Reminder for ${user.email}: ${task.name} (${when})`);
        return;
    }

    const details = [{ label: copy.when, value: escapeHtml(when) }];
    if (task.location) details.push({ label: copy.where, value: escapeHtml(task.location) });
    if (task.link) details.push({ label: copy.link, value: linkHtml(task.link) });
    if (task.description) details.push({ label: copy.note, value: textToHtml(task.description) });

    const textDetails = [
        `${copy.when}: ${when}`,
        task.location && `${copy.where}: ${task.location}`,
        task.link && `${copy.link}: ${task.link}`,
        task.description && `${copy.note}: ${task.description}`,
    ].filter(Boolean).join("\n");

    await send({
        to: user.email,
        subject: copy.subject(task.name, time),
        text: `${copy.intro}\n\n${task.name}\n${textDetails}\n\n${copy.button}: ${open}\n\n${copy.why}`,
        html: renderMail({
            lang,
            preheader: copy.preheader(when),
            heading: task.name,
            paragraphs: [escapeHtml(copy.intro)],
            details,
            button: { label: copy.button, url: open },
            footer: escapeHtml(copy.why),
            homeUrl: FRONTEND_URL,
        }),
    });
}

// A message from the contact form (the second way to reach the operator the Impressum needs)
// to CONTACT_TO. What the sender typed is escaped, so it never turns into HTML; "Antworten"
// goes straight to the sender's address.
async function sendContactMail({ name, email, message }) {
    const to = process.env.CONTACT_TO;
    const text = `Nachricht über das Kontaktformular von Quidey\n\nName: ${name}\nE-Mail: ${email}\n\n${message}\n`;

    // Dev fallback: no SMTP or no recipient configured, just print the message
    if (!transporter || !to) {
        console.log(`[DEV] Contact message${to ? "" : " (CONTACT_TO is not set)"}:\n${text}`);
        return;
    }

    await send({
        from: "Quidey Kontaktformular",
        to,
        replyTo: { name, address: email },
        subject: `Kontaktformular: ${name}`,
        text,
        html: renderMail({
            preheader: message.slice(0, 120),
            heading: "Neue Nachricht übers Kontaktformular",
            details: [
                { label: "Name", value: escapeHtml(name) },
                { label: "E-Mail", value: escapeHtml(email) },
                { label: "Nachricht", value: textToHtml(message) },
            ],
            after: ["Mit „Antworten“ schreibst du direkt an den Absender."],
            homeUrl: FRONTEND_URL,
        }),
    });
}

const FEEDBACK_LABELS = { idea: "Idee", bug: "Fehler", praise: "Lob", other: "Sonstiges", rating: "Bewertung" };

// "Gefällt dir Quidey?" from the app: "Ja, ★★★★☆ (4/5)" or "Nicht wirklich"
const ratingText = (rating) => (rating.liked ? `Ja, ${"★".repeat(rating.stars)}${"☆".repeat(5 - rating.stars)} (${rating.stars}/5)` : "Nicht wirklich");

// Feedback from a signed-in user to CONTACT_TO; "Antworten" goes to the user.
// rating: { liked, stars } for the category "rating", else null
async function sendFeedbackMail({ category, message, page, rating = null, user }) {
    const to = process.env.CONTACT_TO;
    const label = FEEDBACK_LABELS[category] ?? category;
    const who = `${user.display_name || user.username} (@${user.username})`;
    const verdict = rating ? ratingText(rating) : "";
    const text = `Feedback aus Quidey: ${label}\n\nVon: ${who}\nE-Mail: ${user.email}\n${page ? `Seite: ${page}\n` : ""}${verdict ? `Gefällt Quidey: ${verdict}\n` : ""}\n${message}\n`;

    if (!transporter || !to) {
        console.log(`[DEV] Feedback${to ? "" : " (CONTACT_TO is not set)"}:\n${text}`);
        return;
    }

    const details = [
        { label: "Von", value: escapeHtml(who) },
        { label: "E-Mail", value: escapeHtml(user.email) },
    ];
    if (page) details.push({ label: "Seite", value: escapeHtml(page) });
    if (verdict) details.push({ label: "Gefällt Quidey", value: escapeHtml(verdict) });
    if (message) details.push({ label: "Nachricht", value: textToHtml(message) });
    const summary = message || verdict;

    await send({
        from: "Quidey Feedback",
        to,
        replyTo: { name: user.display_name || user.username, address: user.email },
        subject: `Feedback (${label}): ${summary.replace(/\s+/g, " ").slice(0, 60)}`,
        text,
        html: renderMail({
            preheader: summary.slice(0, 120),
            heading: `Feedback: ${label}`,
            details,
            after: ["Mit „Antworten“ schreibst du direkt an die Person."],
            homeUrl: FRONTEND_URL,
        }),
    });
}

module.exports = { sendVerificationMail, sendReminderMail, sendContactMail, sendFeedbackMail };
