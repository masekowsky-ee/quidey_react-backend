// The Untis helpers without a network: periods → lessons, double lessons merged, iCal read,
// hosts checked, the password sealed and opened again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
process.env.UNTIS_SECRET = "a-test-secret-that-is-long-enough-1234";
const untis = require("../../utils/untis.js");

test("periods become lessons, a double lesson one block, a cancelled one marked", () => {
    const lessons = untis.mergePeriods([
        { id: 1, date: 20261119, startTime: 800, endTime: 845, su: [{ name: "M", longname: "Mathematik" }], ro: [{ name: "R12" }], kl: [{ name: "10b" }] },
        { id: 2, date: 20261119, startTime: 850, endTime: 935, su: [{ name: "M", longname: "Mathematik" }], ro: [{ name: "R12" }], kl: [{ name: "10b" }] },
        { id: 3, date: 20261119, startTime: 955, endTime: 1040, su: [{ name: "E" }], ro: [{ name: "R3" }], code: "cancelled", substText: "Entfall" },
        { id: 4, date: 20261119, startTime: 1100, endTime: 1100, su: [{ name: "X" }] },
    ].map(untis.periodToLesson).filter(Boolean));
    assert.deepEqual(lessons.map(l => [l.day, l.startMin, l.endMin, l.subject, l.room, l.status]), [
        ["2026-11-19", 480, 575, "M", "R12", "normal"],
        ["2026-11-19", 595, 640, "E", "R3", "cancelled"],
    ]);
    assert.equal(lessons[0].subjectLong, "Mathematik");
    assert.equal(lessons[1].info, "Entfall");
});

test("an iCal file: local times as written, UTC turned into the school's time, cancellations seen", () => {
    const ics = [
        "BEGIN:VCALENDAR", "VERSION:2.0",
        "BEGIN:VEVENT", "UID:a1", "DTSTART;TZID=Europe/Berlin:20261119T080000", "DTEND;TZID=Europe/Berlin:20261119T084500", "SUMMARY:Mathematik", "LOCATION:R12", "END:VEVENT",
        "BEGIN:VEVENT", "UID:a2", "DTSTART:20261119T075500Z", "DTEND:20261119T084000Z", "SUMMARY:Englisch", "STATUS:CANCELLED", "END:VEVENT",
        "BEGIN:VEVENT", "UID:a3", "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261121", "SUMMARY:Ferien", "END:VEVENT",
        "END:VCALENDAR",
    ].join("\r\n");
    const lessons = untis.parseIcal(ics, "Europe/Berlin");
    assert.deepEqual(lessons.map(l => [l.day, l.startMin, l.endMin, l.subject, l.room, l.status]), [
        ["2026-11-19", 480, 525, "Mathematik", "R12", "normal"],
        ["2026-11-19", 535, 580, "Englisch", "", "cancelled"],
    ]);
});

test("only webuntis.com hosts, only https links", () => {
    assert.equal(untis.validServer("neilo.webuntis.com"), "neilo.webuntis.com");
    assert.equal(untis.validServer("evil.com"), null);
    assert.equal(untis.validServer("webuntis.com.evil.com"), null);
    assert.equal(untis.validIcalUrl("https://neilo.webuntis.com/WebUntis/Ical.do?key=abc"), "https://neilo.webuntis.com/WebUntis/Ical.do?key=abc");
    assert.equal(untis.validIcalUrl("http://neilo.webuntis.com/x.ics"), null);
    assert.equal(untis.validIcalUrl("https://user:pw@neilo.webuntis.com/x.ics"), null);
    assert.equal(untis.validIcalUrl("https://127.0.0.1/x.ics"), null);
});

test("the password is sealed and opened again, and can't be changed unseen", () => {
    const sealed = untis.seal("geheim");
    assert.notEqual(sealed, "geheim");
    assert.equal(untis.open(sealed), "geheim");
    const [iv, tag, data] = sealed.split(":");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 1;
    assert.throws(() => untis.open([iv, tag, flipped.toString("base64")].join(":")));
});

test("the homework estimate: the AI's minutes within range, null when it fails or there is no AI", async () => {
    const ai = require("../../utils/ai.js");
    const before = process.env.AI_FAKE;
    try {
        process.env.AI_FAKE = JSON.stringify({ "homework-minutes": { minutes: 45 } });
        assert.equal(await ai.estimateHomeworkMinutes({ text: "Seite 12", subject: "Deutsch", daysUntilDue: 2 }), 45);
        assert.equal(await ai.estimateHomeworkMinutes({ text: "AI_FAIL", subject: "Deutsch", daysUntilDue: 2 }), null);
        process.env.AI_FAKE = JSON.stringify({ "homework-minutes": { minutes: 9999 } });
        assert.equal(await ai.estimateHomeworkMinutes({ text: "Seite 12", subject: "Deutsch", daysUntilDue: 2 }), 240);
        process.env.AI_FAKE = JSON.stringify({ "homework-minutes": { minutes: 1 } });
        assert.equal(await ai.estimateHomeworkMinutes({ text: "Seite 12", subject: "Deutsch", daysUntilDue: 2 }), 5);
        delete process.env.AI_FAKE;
        assert.equal(await ai.estimateHomeworkMinutes({ text: "Seite 12", subject: "Deutsch", daysUntilDue: 2 }), null);
    } finally {
        if (before === undefined) delete process.env.AI_FAKE; else process.env.AI_FAKE = before;
    }
});
