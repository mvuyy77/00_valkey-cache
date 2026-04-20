// =============================================================================
// scripts/mock-server.ts — Lightweight dev-only mock upstream.
//
// Routes:
//   GET  /mock/user    — happy path JSON response
//   POST /mock/search  — echoes body back (verifies POST body caching)
//   GET  /mock/slow    — delays LATENCY_MS before responding
//   GET  /mock/fail    — always 503 (trips the circuit breaker)
//
// Env vars (all optional):
//   MOCK_PORT    Port to listen on (default: 4000)
//   LATENCY_MS   Delay for /mock/slow in ms (default: 200)
// =============================================================================

import { createServer, IncomingMessage, ServerResponse } from "node:http";

const PORT       = parseInt(process.env.MOCK_PORT  ?? "4000", 10);
const LATENCY_MS = parseInt(process.env.LATENCY_MS ?? "200",  10);

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });
}

function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload).toString(),
    });
    res.end(payload);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url    = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const path   = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/mock/user" && method === "GET") {
        json(res, 200, { route: "mock/user", user: { id: 42, name: "Ada Lovelace" }, ts: Date.now() });
        return;
    }

    if (path === "/mock/search" && method === "POST") {
        const raw = await readBody(req);
        let body: unknown;
        try { body = JSON.parse(raw); } catch { body = raw; }
        json(res, 200, { route: "mock/search", received: body, ts: Date.now() });
        return;
    }

    if (path === "/mock/slow" && method === "GET") {
        setTimeout(() => {
            json(res, 200, { route: "mock/slow", latencyMs: LATENCY_MS, ts: Date.now() });
        }, LATENCY_MS);
        return;
    }

    if (path === "/mock/fail" && method === "GET") {
        json(res, 503, { error: "Service Unavailable" });
        return;
    }

    json(res, 404, { error: "Not Found", path });
});

function shutdown() {
    console.log("[mock-server] shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, () => {
    console.log(`[mock-server] :${PORT} — GET /mock/user | POST /mock/search | GET /mock/slow (${LATENCY_MS}ms) | GET /mock/fail`);
});
