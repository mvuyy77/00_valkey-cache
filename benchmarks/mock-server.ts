// =============================================================================
// benchmarks/mock-server.ts — Fake upstream API for benchmarking.
//
// Returns a JSON payload of configurable size with configurable latency.
// Supports injecting failures for circuit breaker testing.
//
// Usage:
//   npx tsx benchmarks/mock-server.ts
//   PAYLOAD_KB=500 LATENCY_MS=50 FAILURE_RATE=0.1 npx tsx benchmarks/mock-server.ts
// =============================================================================

import { createServer, IncomingMessage, ServerResponse } from "node:http";

const PORT = parseInt(process.env.MOCK_PORT ?? "4000", 10);
const PAYLOAD_KB = parseInt(process.env.PAYLOAD_KB ?? "500", 10);
const LATENCY_MS = parseInt(process.env.LATENCY_MS ?? "50", 10);
const FAILURE_RATE = parseFloat(process.env.FAILURE_RATE ?? "0");

// Pre-generate the payload once — don't allocate per request
const payload = JSON.stringify({
  data: "x".repeat(PAYLOAD_KB * 1024 - 50),
  timestamp: Date.now(),
});

let requestCount = 0;

const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
  requestCount++;

  setTimeout(() => {
    if (FAILURE_RATE > 0 && Math.random() < FAILURE_RATE) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Service Unavailable" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload).toString(),
    });
    res.end(payload);
  }, LATENCY_MS);
});

// Shut down cleanly when Docker (or Ctrl-C) sends SIGTERM/SIGINT.
// Without this, Node.js keeps the setInterval alive and the container
// won't exit on its own — Docker has to wait for stop_grace_period then SIGKILL.
function shutdown() {
  console.log("[mock-server] Shutting down");
  server.close(() => process.exit(0));
  // Force-exit if server.close stalls (e.g. keep-alive connections)
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, () => {
  console.log(`[mock-server] Listening on :${PORT}`);
  console.log(
    `[mock-server] Payload: ${PAYLOAD_KB}KB, Latency: ${LATENCY_MS}ms, Failure rate: ${(FAILURE_RATE * 100).toFixed(0)}%`,
  );
});

setInterval(() => {
  if (requestCount > 0) {
    console.log(`[mock-server] Served ${requestCount} requests total`);
  }
}, 5000);
