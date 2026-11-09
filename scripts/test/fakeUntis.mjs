// A tiny stand-in for WebUntis in the API tests (the server reaches it through UNTIS_TEST_BASE):
// the school search, the JSON-RPC login / timetable / logout and an iCal file. User "lena" with
// password "richtig"; lessons today (a double maths lesson and a cancelled English one) and tomorrow.
import http from "node:http";

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => Number(`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`);

export async function startFakeUntis() {
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            const send = (data, status = 200, type = "application/json") => {
                res.writeHead(status, { "Content-Type": type });
                res.end(typeof data === "string" ? data : JSON.stringify(data));
            };
            const url = new URL(req.url, "http://fake");
            if (url.pathname === "/ms/schoolquery2") {
                const { params } = JSON.parse(body || "{}");
                calls.push({ method: "searchSchool", search: params?.[0]?.search });
                return send({ result: { schools: [
                    { server: "neilo.webuntis.com", loginName: "gym-muster", displayName: "Gymnasium Musterstadt", address: "Musterstadt" },
                    { server: "evil.example.com", loginName: "bad", displayName: "Somewhere else", address: "" },
                ] } });
            }
            if (url.pathname === "/WebUntis/jsonrpc.do") {
                const { method, params } = JSON.parse(body || "{}");
                calls.push({ method, school: url.searchParams.get("school"), cookie: req.headers.cookie ?? null, params });
                if (method === "authenticate") {
                    if (params.user === "lena" && params.password === "richtig") return send({ result: { sessionId: "S1", personId: 42, personType: 5, klasseId: 7 } });
                    return send({ error: { code: -8504, message: "bad credentials" } });
                }
                if (!String(req.headers.cookie ?? "").includes("JSESSIONID=S1")) return send({ error: { code: -8520, message: "not authenticated" } });
                if (method === "logout") return send({ result: null });
                if (method === "getTimetable") {
                    const today = new Date();
                    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
                    return send({ result: [
                        { id: 1, date: ymd(today), startTime: 800, endTime: 845, su: [{ id: 1, name: "M", longname: "Mathematik" }], ro: [{ id: 1, name: "R12" }], kl: [{ id: 7, name: "10b" }] },
                        { id: 2, date: ymd(today), startTime: 850, endTime: 935, su: [{ id: 1, name: "M", longname: "Mathematik" }], ro: [{ id: 1, name: "R12" }], kl: [{ id: 7, name: "10b" }] },
                        { id: 3, date: ymd(today), startTime: 955, endTime: 1040, su: [{ id: 2, name: "E", longname: "Englisch" }], ro: [{ id: 2, name: "R3" }], code: "cancelled", substText: "Entfall" },
                        { id: 4, date: ymd(tomorrow), startTime: 800, endTime: 845, su: [{ id: 3, name: "D", longname: "Deutsch" }], ro: [{ id: 3, name: "R1" }] },
                    ] });
                }
                return send({ error: { code: -32601, message: "no such method" } });
            }
            if (url.pathname === "/WebUntis/Ical.do") {
                calls.push({ method: "ical", key: url.searchParams.get("key") });
                if (url.searchParams.get("key") !== "abc") return send("nope", 403, "text/plain");
                const d = ymd(new Date());
                return send([
                    "BEGIN:VCALENDAR", "VERSION:2.0",
                    "BEGIN:VEVENT", "UID:x1", `DTSTART:${d}T100000`, `DTEND:${d}T104500`, "SUMMARY:Biologie", "LOCATION:Lab", "END:VEVENT",
                    "END:VCALENDAR",
                ].join("\r\n"), 200, "text/calendar");
            }
            send({ error: "not found" }, 404);
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { base: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}
