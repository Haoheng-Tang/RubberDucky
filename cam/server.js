
const express = require('express');
const { SerialPort } = require('serialport');
const { WebSocketServer } = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');


const dotenv = require('dotenv');

function loadEnv() {
  const parentEnvPath = path.resolve(process.cwd(), '..', '.env');
  const localEnvPath = path.resolve(process.cwd(), '.env');

  let parentEnv = {};
  let localEnv = {};

  if (fs.existsSync(parentEnvPath)) {
    parentEnv = dotenv.parse(fs.readFileSync(parentEnvPath));
  }

  if (fs.existsSync(localEnvPath)) {
    localEnv = dotenv.parse(fs.readFileSync(localEnvPath));
  }

  const merged = { ...parentEnv, ...localEnv };

  for (const key of Object.keys(merged)) {
    if (!process.env[key]) {
      process.env[key] = merged[key];
    }
  }
}
loadEnv();


const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── State ──────────────────────────────────────────────────────────
const BAUD_RATE = 2000000;
const TARGET_VID = '303A';
const TARGET_PID = '1001';
let serial = null;
let connected = false;
let buffer = Buffer.alloc(0);
let frameCount = 0;
let lastFpsTime = Date.now();
let fps = 0;

// ── Integration with main system (localhost:1337) ───────────────────
const MAIN_SYSTEM_URL = 'http://localhost:1337';
const POLL_INTERVAL = 1000;
let integrationState = 'idle'; // idle | recording | analyzing
let targetKey = null;
let recordedFrames = [];
const MAX_BUFFERED_FRAMES = 500;

// ── Binary frame parser (state machine) ────────────────────────────
const S_MAGIC = 0, S_SIZE = 1, S_DATA = 2;
let parseState = S_MAGIC;
let sizeBytes = Buffer.alloc(4);
let sizeBytesRead = 0;
let frameBuffer = null;
let frameBytesRead = 0;

function findMagic(buf) {
    for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0xBE && buf[i + 1] === 0xEF) return i;
    }
    return -1;
}

function processSerialData(data) {
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length > 0) {
        if (parseState === S_MAGIC) {
            const nl = buffer.indexOf(0x0A);
            const mg = findMagic(buffer);

            if (mg === -1 && nl === -1) break;

            if (nl !== -1 && (mg === -1 || nl < mg)) {
                const line = buffer.subarray(0, nl).toString('utf-8').trim();
                buffer = buffer.subarray(nl + 1);
                if (line.length > 0) handleText(line);
                continue;
            }
            if (mg !== -1) {
                if (mg > 0) {
                    const pre = buffer.subarray(0, mg).toString('utf-8').trim();
                    if (pre.length) handleText(pre);
                }
                buffer = buffer.subarray(mg + 2);
                parseState = S_SIZE;
                sizeBytesRead = 0;
                continue;
            }
            break;
        }

        if (parseState === S_SIZE) {
            const need = 4 - sizeBytesRead;
            const avail = Math.min(need, buffer.length);
            buffer.copy(sizeBytes, sizeBytesRead, 0, avail);
            sizeBytesRead += avail;
            buffer = buffer.subarray(avail);
            if (sizeBytesRead === 4) {
                const sz = sizeBytes.readUInt32LE(0);
                if (sz === 0 || sz > 500000) {
                    parseState = S_MAGIC;
                    continue;
                }
                frameBuffer = Buffer.alloc(sz);
                frameBytesRead = 0;
                parseState = S_DATA;
            }
            continue;
        }

        if (parseState === S_DATA) {
            const need = frameBuffer.length - frameBytesRead;
            const avail = Math.min(need, buffer.length);
            buffer.copy(frameBuffer, frameBytesRead, 0, avail);
            frameBytesRead += avail;
            buffer = buffer.subarray(avail);
            if (frameBytesRead === frameBuffer.length) {
                handleFrame(frameBuffer);
                parseState = S_MAGIC;
            }
            continue;
        }
    }

    if (buffer.length > 1_000_000) {
        buffer = buffer.subarray(buffer.length - 1024);
        parseState = S_MAGIC;
    }
}

// ── Frame / text handlers ──────────────────────────────────────────
function handleFrame(jpeg) {
    frameCount++;
    const now = Date.now();
    if (now - lastFpsTime >= 1000) {
        fps = frameCount;
        frameCount = 0;
        lastFpsTime = now;
    }

    if (integrationState === 'recording') {
        recordedFrames.push(Buffer.from(jpeg));
        if (recordedFrames.length > MAX_BUFFERED_FRAMES) {
            recordedFrames.shift();
        }
    }

    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(jpeg.length, 0);
    const msg = Buffer.concat([hdr, jpeg]);

    for (const c of wss.clients) {
        if (c.readyState === 1) c.send(msg);
    }
}

function handleText(line) {
    // Filter out binary garbage that leaks through the parser
    if (!/^[\x20-\x7E\r\n\t]*$/.test(line)) return;
    console.log('[ESP32]', line);
    broadcast({ type: 'log', message: line });
}

function broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const c of wss.clients) {
        if (c.readyState === 1) c.send(msg);
    }
}

// ── REST endpoints ─────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
    res.json({ connected, fps, port: serial?.path || null });
});

// ── WebSocket (browser clients) ────────────────────────────────────
wss.on('connection', (ws) => {
    console.log('Browser client connected');
    ws.send(JSON.stringify({ type: 'status', connected, fps }));

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'connect')       connectPort(msg.port);
            else if (msg.type === 'disconnect') disconnectPort();
            else if (msg.type === 'command')    sendCmd(msg.command);
        } catch (e) {
            console.error('Bad WS message', e);
        }
    });
});

// ── Serial port management ─────────────────────────────────────────
function connectPort(portPath) {
    if (serial?.isOpen) serial.close();

    parseState = S_MAGIC;
    buffer = Buffer.alloc(0);

    serial = new SerialPort({ path: portPath, baudRate: BAUD_RATE });

    serial.on('open', () => {
        connected = true;
        console.log(`Connected to ${portPath}`);
        broadcast({ type: 'status', connected: true });
        setTimeout(() => sendCmd('CMD:PING'), 500);
    });

    serial.on('data', processSerialData);

    serial.on('error', (err) => {
        console.error('Serial error:', err.message);
        connected = false;
        broadcast({ type: 'status', connected: false, error: err.message });
    });

    serial.on('close', () => {
        connected = false;
        console.log('Serial port closed');
        broadcast({ type: 'status', connected: false });
    });
}

function disconnectPort() {
    if (serial?.isOpen) {
        sendCmd('CMD:STOP');
        setTimeout(() => { serial.close(); serial = null; }, 200);
    }
}

function sendCmd(cmd) {
    if (!serial?.isOpen) return;
    if (!cmd.endsWith('\n')) cmd += '\n';
    serial.write(cmd);
    console.log('[CMD]', cmd.trim());
}

// ── Gemini video analysis ──────────────────────────────────────────
const ANALYSIS_PROMPT = `You are the vision system for a rubber-duck keyboard-typing robot.

## Physical setup
- The duck sits on a fixed base approximately 15 cm from the near edge of the keyboard.
- It uses a POLAR coordinate system on the horizontal plane:
  • **angle** (degrees): 0 = straight ahead, negative = left, positive = right.
  • **distance** (0-100 scale): 0 = the closest keyboard row to the base, 100 = the furthest row.
- The duck extends to the target (angle, distance), then pecks straight down.
- After pecking it looks up at the computer screen so the camera can read what appeared.

## Your task
Analyze the video and return your response in **exactly two parts**.

### PART 1 — Human-readable analysis (markdown)
Write a concise report covering:
1. **Screen text** — all text currently visible on the screen.
2. **Typed text** — only the new characters that were produced by the duck's key presses in this session.
3. **Attempt log** — for each peck: intended key → actual key, hit/partial/miss, precision 1-10.
4. **Correction vectors** — for each missed or imprecise hit, state the recommended angle shift (degrees, - = left, + = right) and distance shift (on the 0-100 scale, - = pull closer, + = extend further) to improve the next attempt.
5. **Overall precision score** (1-100).
6. **Suggestions** — 3-5 actionable tips.

### PART 2 — Machine-readable JSON
After the markdown, output a single fenced JSON code block (tagged \`\`\`json) containing exactly this structure:

\`\`\`json
{
  "screen_text": "<all text visible on screen>",
  "typed_text": "<new characters typed this session>",
  "overall_score": <1-100>,
  "attempts": [
    {
      "intended_key": "<key>",
      "actual_key": "<key(s) hit>",
      "hit_result": "<hit | partial | miss>",
      "precision": <1-10>,
      "angle_shift": <degrees, - left / + right>,
      "distance_shift": <0-100 scale delta, - closer / + further>
    }
  ],
  "suggestions": ["<tip 1>", "<tip 2>", "..."]
}
\`\`\`

IMPORTANT: Output ONLY the markdown report followed by the single JSON block. No other text after the JSON block.`;

function getAnalysisPrompt(key) {
    if (!key) return ANALYSIS_PROMPT;
    const keySection = `\n\n## Target key\nThe duck was commanded to press the key **"${key}"**. This is the confirmed target — use "${key}" as the \`intended_key\` in your response. Do not guess the intended key.\n`;
    return ANALYSIS_PROMPT.replace('## Your task', keySection + '## Your task');
}

let analysisInProgress = false;

app.post('/api/analyze', express.raw({ type: 'video/*', limit: '100mb' }), async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    console.log(apiKey);
    if (!apiKey) return res.status(400).json({ error: 'Missing GEMINI_API_KEY in .env' });
    if (!req.body || req.body.length === 0) return res.status(400).json({ error: 'Empty video' });

    if (analysisInProgress) {
        return res.status(429).json({ error: 'Analysis already in progress, please wait' });
    }
    analysisInProgress = true;

    const modelName = 'gemini-2.5-flash';
    const videoSize = (req.body.length / 1024 / 1024).toFixed(2);
    console.log(`[Analyze] Starting — model=${modelName}, video=${videoSize} MB`);

    const tmpPath = path.join(os.tmpdir(), `rubberducky_${Date.now()}.webm`);
    fs.writeFileSync(tmpPath, req.body);

    try {
        const fileManager = new GoogleAIFileManager(apiKey);

        console.log('[Analyze] Uploading video to Gemini File API…');
        const upload = await fileManager.uploadFile(tmpPath, {
            mimeType: 'video/webm',
            displayName: `rubberducky_${Date.now()}`,
        });

        let file = upload.file;
        let polls = 0;
        while (file.state === 'PROCESSING') {
            polls++;
            console.log(`[Analyze] File processing… (poll ${polls})`);
            await new Promise(r => setTimeout(r, 3000));
            file = await fileManager.getFile(file.name);
        }
        if (file.state === 'FAILED') throw new Error('Gemini video processing failed');
        console.log('[Analyze] File ready, calling generateContent…');

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: modelName });

        const result = await model.generateContent([
            { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
            { text: ANALYSIS_PROMPT },
        ]);

        const raw = result.response.text();
        console.log('[Analyze] Done — response received');

        // Extract JSON block from the response
        let data = null;
        let analysis = raw;
        const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
            try {
                data = JSON.parse(jsonMatch[1].trim());
                analysis = raw.slice(0, jsonMatch.index).trim();
                console.log('\n[Analyze] ── Parsed JSON ──────────────────────');
                console.log(JSON.stringify(data, null, 2));
                console.log('[Analyze] ────────────────────────────────────\n');
            } catch (parseErr) {
                console.error('[Analyze] JSON parse error:', parseErr.message);
                console.log('[Analyze] Raw JSON text:', jsonMatch[1].trim().slice(0, 500));
            }
        } else {
            console.warn('[Analyze] No ```json block found in Gemini response');
            console.log('[Analyze] Raw response preview:', raw.slice(0, 500));
        }

        res.json({ analysis, data });

        fileManager.deleteFile(file.name).catch(() => {});
    } catch (e) {
        console.error('[Analyze] Error:', e.message);
        res.status(500).json({ error: e.message });
    } finally {
        analysisInProgress = false;
        fs.unlink(tmpPath, () => {});
    }
});

// ── Auto-connect to Seeed XIAO by USB VID/PID ─────────────────────
function isTargetDevice(port) {
    if (port.vendorId?.toUpperCase() === TARGET_VID &&
        port.productId?.toUpperCase() === TARGET_PID) return true;
    if (port.pnpId?.toUpperCase().includes(`VID_${TARGET_VID}`) &&
        port.pnpId?.toUpperCase().includes(`PID_${TARGET_PID}`)) return true;
    return false;
}

async function autoConnect() {
    if (connected || serial?.isOpen) return;
    try {
        const ports = await SerialPort.list();
        if (ports.length > 0) {
            console.log(`[AutoConnect] Found ${ports.length} port(s):`,
                ports.map(p => `${p.path} [VID=${p.vendorId||'?'} PID=${p.productId||'?'}]`).join(', '));
        }
        const match = ports.find(isTargetDevice);
        if (match) {
            console.log(`[AutoConnect] Seeed XIAO detected on ${match.path} — connecting…`);
            connectPort(match.path);
        }
    } catch (e) {
        console.error('[AutoConnect] Error scanning ports:', e.message);
    }
}

setInterval(() => { if (!connected) autoConnect(); }, 3000);

// ── Integration polling & result forwarding ─────────────────────────
function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

async function pollCamCmd() {
    if (integrationState === 'analyzing') return POLL_INTERVAL;

    try {
        const { status, body } = await httpGet(`${MAIN_SYSTEM_URL}/cam-cmd`);

        if (status === 429) {
            console.log('[Integration] System busy (429), will retry in 2s');
            return 2000;
        }

        const data = JSON.parse(body);
        console.log(`[Integration] Received:`, JSON.stringify(data));

        switch (data.command) {
            case 'start':
                if (integrationState !== 'recording') {
                    targetKey = data.key;
                    integrationState = 'recording';
                    recordedFrames = [];
                    sendCmd('CMD:STREAM');
                    console.log(`[Integration] Start — target key: "${targetKey}", streaming started`);
                    broadcast({ type: 'remote-cmd', action: 'start-recording', key: targetKey });
                }
                break;
            case 'continue':
                break;
            case 'stop':
                if (integrationState === 'recording') {
                    integrationState = 'analyzing';
                    console.log(`[Integration] Stop — ${recordedFrames.length} frames captured, analyzing…`);
                    broadcast({ type: 'remote-cmd', action: 'stop-recording' });
                    analyzeAndReport();
                }
                break;
            case 'idle':
                break;
        }
    } catch (e) {
        console.error('[Integration] Poll error:', e.message);
    }

    return POLL_INTERVAL;
}

function startPolling() {
    pollCamCmd().then(delay => {
        setTimeout(startPolling, delay);
    });
}

function sampleFrames(frames, maxCount) {
    if (frames.length <= maxCount) return frames;
    const step = frames.length / maxCount;
    const sampled = [];
    for (let i = 0; i < maxCount; i++) {
        sampled.push(frames[Math.floor(i * step)]);
    }
    return sampled;
}

async function analyzeAndReport() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('[Integration] Missing GEMINI_API_KEY — cannot analyze');
        integrationState = 'idle';
        targetKey = null;
        recordedFrames = [];
        return;
    }

    const frames = sampleFrames(recordedFrames, 30);
    recordedFrames = [];
    console.log(`[Integration] Sending ${frames.length} frames to Gemini…`);

    try {
        console.log(apiKey);
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

        const prompt = getAnalysisPrompt(targetKey);
        const parts = frames.map(f => ({
            inlineData: { mimeType: 'image/jpeg', data: f.toString('base64') }
        }));
        parts.push({ text: prompt });

        const result = await model.generateContent(parts);
        const raw = result.response.text();
        console.log('[Integration] Gemini response received');

        const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
            const data = JSON.parse(jsonMatch[1].trim());
            console.log('[Integration] Parsed result:', JSON.stringify(data, null, 2));
            await sendResultToMainSystem(data);
        } else {
            console.warn('[Integration] No JSON block in Gemini response');
            console.log('[Integration] Raw:', raw.slice(0, 500));
        }
    } catch (e) {
        console.error('[Integration] Analysis error:', e.message);
    } finally {
        integrationState = 'idle';
        targetKey = null;
    }
}

async function sendResultToMainSystem(analysisData) {
    const da = analysisData.attempts?.[0]?.angle_shift ?? 0;
    const dr = analysisData.attempts?.[0]?.distance_shift ?? 0;
    const typed = analysisData.typed_text ?? '';

    const params = new URLSearchParams({ da: String(da), dr: String(dr), typed });
    const url = `${MAIN_SYSTEM_URL}/cam-ret?${params}`;

    console.log(`[Integration] Sending result → ${url}`);

    try {
        const { status } = await httpGet(url);
        console.log(`[Integration] Result acknowledged — HTTP ${status}`);
    } catch (e) {
        console.error('[Integration] Failed to send result:', e.message);
    }
}

// ── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Rubberducky Camera  →  http://localhost:${PORT}`);
    autoConnect();
    startPolling();
    console.log('[Integration] Polling localhost:1337/cam-cmd');
});
