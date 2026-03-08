const http = require("http");
const readline = require("readline");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(__dirname, "..", ".env.local"), override: false });

const BRIDGE_HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 1337);
const BRIDGE_GET_PATH = process.env.BRIDGE_GET_PATH || "/llm-cmd";
const BRIDGE_SEND_PATH = process.env.BRIDGE_SEND_PATH || "/llm-ret";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-6";
const CLAUDE_MAX_TOKENS = Number(process.env.CLAUDE_MAX_TOKENS || 1024);

const MASTER_SYSTEM_PROMPT = `You are the planning brain of a robotic duck that types on a physical QWERTY keyboard.
The duck arm moves in polar coordinates.
- angle range: 0..60 (0 = leftmost, 60 = rightmost)
- reach range: 0..100 (near to far)
- each key press requires exactly one (angle, reach) pair
The duck base is about 15cm away from the keyboard.
Use common keyboard geometry to estimate key positions.

Return strict JSON only with this schema:
{
  "type_text": "string",
  "commands": [
    {"a": 10, "r": 20, "key": "a"}
  ],
  "say": "string"
}

Rules:
- commands length must equal the number of intended key presses
- each command must include numeric a/r and a key label
- keep a in [0,60] and r in [0,100]
- "say" should sound cranky and begrudging
- do not return markdown code fences`;

const ANALYZE_SYSTEM_PROMPT = `You are a calibration assistant for a robotic duck typist.
You receive sensor feedback JSON from camera/diff systems.
Return strict JSON only:
{
  "calibration_notes": "string",
  "recommended_adjustments": ["string", "string"]
}
Keep it concise and actionable.`;

let analysisMemory = null;
let sendQueue = Promise.resolve();
let commandQueue = Promise.resolve();
const queuedSignatures = new Set();
let pollInFlight = false;

function timestamp() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonSafe(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, value: null };
  }
}

function extractClaudeText(responseJson) {
  if (!responseJson || !Array.isArray(responseJson.content)) return "";
  return responseJson.content
    .filter((entry) => entry && entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function requestGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: BRIDGE_HOST,
        port: BRIDGE_PORT,
        path: pathname,
        method: "GET",
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8").trim(),
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`));
    });

    req.on("error", reject);
    req.end();
  });
}

function normalizeSendInput(input) {
  const text = String(input || "").trim();
  if (!text) return null;

  if (text.startsWith("http://") || text.startsWith("https://")) {
    const u = new URL(text);
    return `${BRIDGE_SEND_PATH}${u.search || ""}`;
  }

  if (text.startsWith("/")) {
    const qIndex = text.indexOf("?");
    return qIndex >= 0 ? `${BRIDGE_SEND_PATH}${text.slice(qIndex)}` : BRIDGE_SEND_PATH;
  }

  if (text.includes("?")) {
    return `${BRIDGE_SEND_PATH}?${text.split("?")[1]}`;
  }

  return `${BRIDGE_SEND_PATH}?${text}`;
}

function normalizeClaudePlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new Error("Claude plan is not a JSON object.");
  }

  if (!Array.isArray(plan.commands) || plan.commands.length === 0) {
    throw new Error("Claude plan must include non-empty commands array.");
  }

  const normalized = plan.commands.map((cmd, index) => {
    const aRaw = Number(cmd.a);
    const rRaw = Number(cmd.r);
    const key = cmd.key === undefined || cmd.key === null ? "" : String(cmd.key).trim();

    if (!Number.isFinite(aRaw) || !Number.isFinite(rRaw) || !key) {
      throw new Error(`Invalid command at index ${index}: requires numeric a/r and non-empty key.`);
    }

    const a = clamp(Math.round(aRaw), 0, 60);
    const r = clamp(Math.round(rRaw), 0, 100);

    return { a, r, key };
  });

  const say = typeof plan.say === "string" && plan.say.trim()
    ? plan.say.trim()
    : "you want me to write code for you again?";

  const typeText = typeof plan.type_text === "string" ? plan.type_text : "";

  return { typeText, say, commands: normalized };
}

function buildBridgeRetPathFromPlan(plan) {
  const pathValues = plan.commands.flatMap((cmd) => [cmd.a, cmd.r]).join(",");
  if (pathValues.split(",").length % 2 !== 0) {
    throw new Error("Generated path is invalid: values must be pairs.");
  }

  const keyValues = plan.commands.map((cmd) => cmd.key).join(",");
  const params = new URLSearchParams({
    path: pathValues,
    keys: keyValues,
    say: plan.say,
  });

  return `${BRIDGE_SEND_PATH}?${params.toString()}`;
}

async function callClaude(userPrompt, systemPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY in environment/.env.local");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: controller.signal,
    });

    const rawBody = await response.text();
    const parsedBody = parseJsonSafe(rawBody);

    if (!response.ok) {
      throw new Error(`Claude API HTTP ${response.status}: ${rawBody || "<empty>"}`);
    }
    if (!parsedBody.ok) {
      throw new Error("Claude API returned non-JSON response.");
    }

    const text = extractClaudeText(parsedBody.value);
    if (!text) {
      throw new Error("Claude response text is empty.");
    }

    return text;
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Claude API timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendToBridge(pathname, source) {
  const target = `http://${BRIDGE_HOST}:${BRIDGE_PORT}${pathname}`;
  console.log(`[${timestamp()}] SEND(${source}) GET ${target}`);

  try {
    const res = await requestGet(pathname);
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log(`[${timestamp()}] SEND(${source}) ok: HTTP ${res.statusCode} body=${res.body || "<empty>"}`);
    } else {
      console.error(`[${timestamp()}] SEND(${source}) err: HTTP ${res.statusCode} body=${res.body || "<empty>"}`);
    }
  } catch (err) {
    console.error(`[${timestamp()}] SEND(${source}) failed: ${err.message}`);
  }
}

function enqueueSend(pathname, source) {
  sendQueue = sendQueue.then(() => sendToBridge(pathname, source)).catch((err) => {
    console.error(`[${timestamp()}] SEND(${source}) queue error: ${err.message}`);
  });
}

async function handlePromptCommand(payload) {
  if (typeof payload.prompt !== "string" || !payload.prompt.trim()) {
    console.error(`[${timestamp()}] PROMPT command missing usable prompt field.`);
    return;
  }

  const calibrationBlock = analysisMemory
    ? `\n\nCalibration context from prior analyze command:\n${analysisMemory}`
    : "\n\nNo prior calibration context available.";

  const userPrompt = `User wants typed output:\n${payload.prompt.trim()}${calibrationBlock}`;

  console.log(`[${timestamp()}] PROMPT command: calling Claude...`);

  try {
    const claudeText = await callClaude(userPrompt, MASTER_SYSTEM_PROMPT);
    const parsed = parseJsonSafe(claudeText);
    if (!parsed.ok) {
      throw new Error(`Claude prompt response is not valid JSON: ${claudeText}`);
    }

    const plan = normalizeClaudePlan(parsed.value);
    const bridgePath = buildBridgeRetPathFromPlan(plan);
    enqueueSend(bridgePath, "prompt");
  } catch (err) {
    console.error(`[${timestamp()}] PROMPT handling failed: ${err.message}`);
  }
}

async function handleAnalyzeCommand(payload) {
  const analyzeJson = JSON.stringify(payload);
  console.log(`[${timestamp()}] ANALYZE command: calling Claude with sensor feedback...`);

  try {
    const claudeText = await callClaude(analyzeJson, ANALYZE_SYSTEM_PROMPT);
    analysisMemory = claudeText;
    console.log(`[${timestamp()}] ANALYZE memory updated: ${claudeText}`);
  } catch (err) {
    console.error(`[${timestamp()}] ANALYZE handling failed: ${err.message}`);
  }
}

function enqueueCommandHandler(payload) {
  const signature = JSON.stringify(payload);
  if (queuedSignatures.has(signature)) {
    return;
  }

  queuedSignatures.add(signature);
  commandQueue = commandQueue
    .then(async () => {
      if (payload.command === "prompt") {
        await handlePromptCommand(payload);
      } else if (payload.command === "analyze") {
        await handleAnalyzeCommand(payload);
      }
    })
    .catch((err) => {
      console.error(`[${timestamp()}] Command queue error: ${err.message}`);
    })
    .finally(() => {
      queuedSignatures.delete(signature);
    });
}

async function handlePollResponse(res) {
  if (res.statusCode === 429) {
    console.log(`[${timestamp()}] POLL busy: HTTP 429 body=${res.body || "<empty>"}`);
    return;
  }

  if (res.statusCode !== 200) {
    console.error(`[${timestamp()}] POLL err: HTTP ${res.statusCode} body=${res.body || "<empty>"}`);
    return;
  }

  const parsed = parseJsonSafe(res.body || "");
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    console.error(`[${timestamp()}] POLL err: invalid JSON body=${res.body || "<empty>"}`);
    return;
  }

  const payload = parsed.value;
  if (payload.status !== "OK") {
    console.error(`[${timestamp()}] POLL status not OK: ${JSON.stringify(payload)}`);
    return;
  }

  const command = payload.command;
  if (command === "idle") {
    return;
  }

  if (command === "prompt" || command === "analyze") {
    enqueueCommandHandler(payload);
    return;
  }

  console.log(`[${timestamp()}] POLL unknown command: ${JSON.stringify(payload)}`);
}

async function pollBridgeOnce() {
  const target = `http://${BRIDGE_HOST}:${BRIDGE_PORT}${BRIDGE_GET_PATH}`;
  console.log(`[${timestamp()}] POLL GET ${target}`);

  try {
    const res = await requestGet(BRIDGE_GET_PATH);
    await handlePollResponse(res);
  } catch (err) {
    console.error(`[${timestamp()}] POLL request failed: ${err.message}`);
  }
}

function startPollingLoop() {
  setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    pollBridgeOnce()
      .catch((err) => {
        console.error(`[${timestamp()}] POLL loop error: ${err.message}`);
      })
      .finally(() => {
        pollInFlight = false;
      });
  }, POLL_INTERVAL_MS);
}

function setupInputChannel() {
  console.log(
    `[${timestamp()}] Input ready. Enter query like "path=10,20,30,40&keys=a,b,Backspace,y&say=you+again" to send via /llm-ret.`
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("line", (line) => {
    const input = line.trim();
    if (!input) return;

    const lower = input.toLowerCase();
    if (lower === "exit" || lower === "quit") {
      console.log(`[${timestamp()}] Exiting llmserver.`);
      process.exit(0);
    }

    const sendPath = normalizeSendInput(input);
    if (!sendPath) {
      console.error(`[${timestamp()}] Manual input ignored: empty query.`);
      return;
    }

    enqueueSend(sendPath, "stdin");
  });
}

async function main() {
  const startupInput = process.argv.slice(2).join(" ").trim();

  console.log(
    `[${timestamp()}] llmserver running. Poll=${BRIDGE_GET_PATH} every ${POLL_INTERVAL_MS}ms, Send=${BRIDGE_SEND_PATH}`
  );

  setupInputChannel();

  if (startupInput) {
    const startupPath = normalizeSendInput(startupInput);
    if (startupPath) {
      enqueueSend(startupPath, "startup");
    }
  }

  await pollBridgeOnce();
  startPollingLoop();

  while (true) {
    await sleep(3600_000);
  }
}

main().catch((err) => {
  console.error(`[${timestamp()}] fatal: ${err.message}`);
  process.exit(1);
});
