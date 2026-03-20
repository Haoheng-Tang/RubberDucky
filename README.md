# RubberDucky

A robotic duck that types on keyboards, powered by Claude AI. The system uses three coordinating servers, a browser-based code editor with voice input, and an Arduino-controlled mechanical arm.

## Architecture Overview

```
┌──────────────────┐
│  diffweb/        │  Browser-based code editor + voice input
│  index.html      │  (open directly in Chrome/Edge)
└──────┬───────────┘
       │  polls /dirty, sends /diff, sends /stt
       ▼
┌──────────────────────────────────────────────────┐
│  server/server.js        (Bridge — port 1337)    │
│  Central orchestrator, Arduino serial control    │
└──────┬──────────────────────────┬────────────────┘
       │ polls /llm-cmd           │ polls /cam-cmd
       │ sends /llm-ret           │ sends /cam-ret
       ▼                          ▼
┌──────────────────┐    ┌──────────────────────────┐
│  llm/llmserver.js│    │  cam/server.js           │
│  Claude AI loop  │    │  Camera + Gemini (3001)  │
└──────────────────┘    └──────────────────────────┘
```

### Server roles

| Server | File | Port | Role |
|--------|------|------|------|
| **Bridge** | `server/server.js` | 1337 | Central hub. Connects to Arduino via serial (9600 baud), routes commands between all subsystems |
| **Camera** | `cam/server.js` | 3001 | Reads JPEG frames from XIAO ESP32S3 camera, streams via WebSocket, uses Google Gemini to analyze what keys the duck pressed |
| **LLM** | `llm/llmserver.js` | — (polls bridge) | Polls the bridge for user prompts, calls Claude API to plan duck arm movements, returns keypress sequences |

### Frontend

| Component | File | How to open |
|-----------|------|-------------|
| **Diff Poll Editor** | `diffweb/index.html` | Open directly in **Chrome** or **Edge** (no build step needed) |
| **Camera viewer** | served by cam server | `http://localhost:3001` |

### Optional servers

| Server | File | Port | Role |
|--------|------|------|------|
| **Sound / TTS** | `sound/server.js` | 3000 | ElevenLabs text-to-speech for duck vocalizations |

## Prerequisites

- **Node.js** (v18+)
- **Arduino** connected via USB (for duck arm control)
- **XIAO ESP32S3 Sense** camera module (for key-press verification)
- **API keys** in `.env.local` (see below)
- **Chrome or Edge** browser (Firefox does not support the Web Speech Recognition API)

## Configuration

Create a `.env.local` file in the project root:

```env
ANTHROPIC_API_KEY=your_anthropic_api_key
CLAUDE_MODEL=claude-opus-4-6
CLAUDE_MAX_TOKENS=1024

GEMINI_API_KEY=your_gemini_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key   # optional, for TTS

BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=1337
BRIDGE_GET_PATH=/llm-cmd
BRIDGE_SEND_PATH=/llm-ret
POLL_INTERVAL_MS=1000
REQUEST_TIMEOUT_MS=15000
```

## Starting the System

Open three terminals and start the servers in this order:

### 1. Bridge server (Terminal 1)

```bash
cd server
npm install   # first time only
node server.js
```

Listens on `http://127.0.0.1:1337`. Connects to Arduino automatically via serial.

### 2. Camera server (Terminal 2)

```bash
cd cam
npm install   # first time only
npm start
```

Streams at `http://localhost:3001`. Opens camera feed in browser and polls the bridge for recording commands.

### 3. LLM server (Terminal 3)

```bash
cd llm
npm install   # first time only
node llmserver.js
```

Polls `http://localhost:1337/llm-cmd` every second for new prompts.

### 4. Open the frontend

Open `diffweb/index.html` directly in **Chrome** or **Edge**.

The editor connects to the bridge at `http://localhost:1337` automatically.

## Using Voice Input

The editor has a **"Hold to Talk"** button that uses the browser's Web Speech Recognition API:

1. **Press and hold** the button (mouse or keyboard)
2. **Speak** your prompt (e.g., "write hello world")
3. **Release** — the transcribed text is sent to the bridge at `/stt`
4. The LLM server picks up the prompt, calls Claude, and plans the duck's keypresses

> **Note:** Voice input requires **Chrome** or **Edge**. The button is disabled in Firefox because it does not support the Web Speech Recognition API.

## Data Flow

1. **User speaks** in diffweb → browser transcribes via Web Speech API → `GET /stt?text=...` to bridge
2. **LLM polls** `GET /llm-cmd` → receives prompt → calls Claude API → returns keypress plan via `GET /llm-ret`
3. **Bridge executes** each keypress: sends motor commands to Arduino via serial, triggers camera recording
4. **Camera records** the keypress → sends frames to Gemini for analysis → returns result via `GET /cam-ret`
5. **Diff tracking**: diffweb polls `GET /dirty` every 150ms, computes character-level diffs, sends via `GET /diff`
6. **Calibration**: camera/diff results are fed back to Claude for improved accuracy on subsequent keypresses

## Bridge API Reference

| Endpoint | Direction | Purpose |
|----------|-----------|---------|
| `GET /motor?a=<angle>&r=<reach>` | LLM → Bridge | Move duck arm (polar coordinates) |
| `GET /llm-cmd` | Bridge → LLM | Poll for next command (`idle`, `prompt`, `analyze`) |
| `GET /llm-ret?path=...&keys=...&say=...` | LLM → Bridge | Submit keypress plan |
| `GET /cam-cmd` | Bridge → Camera | Poll for recording command (`idle`, `start`, `stop`) |
| `GET /cam-ret?da=...&dr=...&typed=...` | Camera → Bridge | Submit analysis results |
| `GET /dirty` | Bridge → Diffweb | Check if code changed |
| `GET /diff?diff=...` | Diffweb → Bridge | Submit character-level diff |
| `GET /stt?text=...` | Diffweb → Bridge | Submit voice transcription |
| `GET /say?text=...` | Bridge → Sound | Trigger TTS vocalization |

## LLM Server Details

### Runtime behavior

1. Poll `GET /llm-cmd` every second.
2. If `{"command":"idle"}`: do nothing, keep polling.
3. If `{"command":"prompt","prompt":"..."}`:
   - Call Claude with the user prompt and duck-typing constraints.
   - Parse Claude's JSON plan into `path`, `keys`, and `say`.
   - Send `GET /llm-ret?path=...&keys=...&say=...`.
4. If `{"command":"analyze", ...}`:
   - Send the JSON payload to Claude for calibration guidance.
   - Store guidance for future prompt planning.

### Manual override

While the LLM server is running, you can type a query directly in its terminal:

```text
path=10,20,30,40&keys=a,b,c,d&say=you+want+me+to+code+again
```
