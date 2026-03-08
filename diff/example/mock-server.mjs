#!/usr/bin/env node
import http from "node:http";

let dirtyCommand = "idle";
let lastDiff = null;

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1:3000");

  if (req.method === "GET" && url.pathname === "/dirty") {
    sendJson(res, 200, { command: dirtyCommand });
    return;
  }

  if (req.method === "GET" && url.pathname === "/set-dirty") {
    const raw = String(url.searchParams.get("value") || "diff").toLowerCase();
    dirtyCommand = raw === "diff" || raw === "yes" ? "diff" : "idle";
    sendJson(res, 200, { command: dirtyCommand });
    return;
  }

  if (req.method === "GET" && url.pathname === "/last-diff") {
    sendJson(res, 200, {
      dirtyCommand,
      hasLastDiff: Boolean(lastDiff),
      lastDiff
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/diff") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        lastDiff = JSON.parse(body);
        dirtyCommand = "idle";
        console.log(`[${new Date().toISOString()}] Received diff for ${lastDiff?.filePath || "<unknown>"}. hasChanges=${String(lastDiff?.hasChanges)}`);
        sendJson(res, 200, { ok: true, received: true });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
    return;
  }

  sendText(res, 404, "Not Found");
});

server.listen(3000, "127.0.0.1", () => {
  console.log("Mock server listening at http://127.0.0.1:3000");
  console.log("GET  /dirty -> {\"command\":\"idle|diff\"}");
  console.log("GET  /set-dirty?value=diff");
  console.log("POST /diff");
  console.log("GET  /last-diff");
});
