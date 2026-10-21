// The look of every mail Quidey sends: one calm card on a warm background, the wordmark on
// top, a heading, text, an optional box of details and one button. Mail clients only
// understand old HTML, so it's tables and inline styles; the <style> block only adds dark
// mode and small screens for the clients that read it (Apple Mail, iOS, some Outlooks).
// Everything that comes from users (names, task titles, messages) must go through escapeHtml.

const COLORS = {
    page: "#f4f1ec",
    card: "#ffffff",
    border: "#e8e2da",
    text: "#3a3633",
    heading: "#1c1917",
    muted: "#7a736c",
    accent: "#f97316",      // "Abendrot", the app's default accent (light theme)
    accentText: "#1c0a00",
    soft: "#fbf6f1",        // the details box
};

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, Helvetica, Arial, sans-serif";

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// Plain text with its line breaks kept, safe inside HTML
const textToHtml = (value) => escapeHtml(value).replace(/\r?\n/g, "<br>");

const paragraph = (html) =>
    `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${COLORS.text};" class="q-text">${html}</p>`;

// [{ label, value (HTML) }] as a soft box of label/value rows
function detailsBox(rows) {
    const items = rows.map((row, i) => `
        <tr>
            <td style="padding:${i === 0 ? "0" : "10px"} 0 0;font-family:${FONT};font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.muted};" class="q-muted">${escapeHtml(row.label)}</td>
        </tr>
        <tr>
            <td style="padding:2px 0 0;font-family:${FONT};font-size:16px;line-height:1.5;color:${COLORS.heading};" class="q-heading">${row.value}</td>
        </tr>`).join("");
    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px;">
            <tr>
                <td style="padding:18px 20px;background:${COLORS.soft};border:1px solid ${COLORS.border};border-left:4px solid ${COLORS.accent};border-radius:12px;" class="q-soft">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}</table>
                </td>
            </tr>
        </table>`;
}

// A big rounded button (bulletproof: a padded link inside a table cell)
function button({ label, url }) {
    const href = escapeHtml(url);
    return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
            <tr>
                <td style="border-radius:999px;background:${COLORS.accent};">
                    <a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:600;line-height:1;color:${COLORS.accentText};text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>
                </td>
            </tr>
        </table>`;
}

// The whole mail. All parts but heading are optional:
// { lang, preheader (shown in the inbox list), heading, paragraphs: [html], details: [{ label, value }],
//   button: { label, url }, after: [html] (below the button, smaller), footer: html, homeUrl }
function renderMail({ lang = "de", preheader = "", heading, paragraphs = [], details, button: cta, after = [], footer = "", homeUrl = "https://quidey.com" }) {
    const home = escapeHtml(homeUrl);
    const homeLabel = escapeHtml(homeUrl.replace(/^https?:\/\//, ""));
    const small = (html) =>
        `<p style="margin:0 0 12px;font-family:${FONT};font-size:14px;line-height:1.6;color:${COLORS.muted};" class="q-muted">${html}</p>`;

    return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(heading)}</title>
<style>
    @media (max-width: 600px) {
        .q-card { padding: 28px 22px !important; border-radius: 16px !important; }
        .q-h1 { font-size: 24px !important; }
    }
    @media (prefers-color-scheme: dark) {
        .q-page { background: #0e0d0c !important; }
        .q-card { background: #181716 !important; border-color: #262422 !important; }
        .q-heading, .q-h1 { color: #f4f3f1 !important; }
        .q-text { color: #d9d4cf !important; }
        .q-muted { color: #9b958f !important; }
        .q-soft { background: #211f1e !important; border-color: #2c2a28 !important; border-left-color: #fb923c !important; }
        .q-link { color: #fb923c !important; }
    }
</style>
</head>
<body style="margin:0;padding:0;background:${COLORS.page};" class="q-page">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.page};" class="q-page">
    <tr>
        <td align="center" style="padding:40px 16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
                <tr>
                    <td style="padding:0 8px 20px;font-family:${FONT};font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${COLORS.heading};" class="q-heading">
                        <span style="display:inline-block;width:10px;height:10px;margin-right:8px;border-radius:50%;background:${COLORS.accent};vertical-align:middle;"></span><span style="vertical-align:middle;">Quidey</span>
                    </td>
                </tr>
                <tr>
                    <td style="padding:40px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:20px;" class="q-card">
                        <h1 style="margin:0 0 16px;font-family:${FONT};font-size:26px;font-weight:700;line-height:1.25;letter-spacing:-0.02em;color:${COLORS.heading};" class="q-h1">${escapeHtml(heading)}</h1>
                        ${paragraphs.map(paragraph).join("\n")}
                        ${details?.length ? detailsBox(details) : ""}
                        ${cta ? button(cta) : ""}
                        ${after.map(small).join("\n")}
                    </td>
                </tr>
                <tr>
                    <td style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${COLORS.muted};" class="q-muted">
                        ${footer ? `${footer}<br>` : ""}Quidey · <a href="${home}" style="color:${COLORS.muted};" class="q-link">${homeLabel}</a>
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
</body>
</html>`;
}

module.exports = { renderMail, escapeHtml, textToHtml, COLORS };
