# RubberDucky

## Start LLM Server (`llm/llmserver.js`)

`llm/llmserver.js` is the mastermind loop for the robotic duck.
It only talks to the bridge using GET query parameters.

### Runtime behavior

1. Poll `GET /llm-cmd` every second.
2. If `{"command":"idle"}`: do nothing and keep polling.
3. If `{"command":"prompt","prompt":"..."}`:
   - Call Claude with the user prompt and duck-typing constraints.
   - Parse Claude JSON plan into `path`, `keys`, and `say`.
   - Send `GET /llm-ret?path=...&keys=...&say=...`.
4. If `{"command":"analyze", ...}`:
   - Send the entire JSON payload to Claude for calibration guidance.
   - Store returned guidance and include it in later prompt planning.
5. If `status` is not `OK`: log error and continue polling.

### Start commands

```powershell
cd server
node server.js
```

In another terminal:

```powershell
node llm/llmserver.js
```

### `.env.local` example

```env
ANTHROPIC_API_KEY=your_anthropic_api_key_here
CLAUDE_MODEL=claude-opus-4-6
CLAUDE_MAX_TOKENS=1024

BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=1337
BRIDGE_GET_PATH=/llm-cmd
BRIDGE_SEND_PATH=/llm-ret
POLL_INTERVAL_MS=1000
REQUEST_TIMEOUT_MS=15000
```

### Manual override while running

You can still manually send one request by typing query text in the llmserver terminal:

```text
path=10,20,30,40&keys=a,b,c,d&say=you+want+me+to+code+again
```
