# ElevenLabs TTS Web App + CLI (Node.js + Express)

A minimal, production-ready Node.js + Express app and CLI for ElevenLabs Text-to-Speech.

The app provides:
- A browser UI to enter text, `voice_id`, and optional `model_id`
- A backend `POST /api/tts` endpoint that calls ElevenLabs and returns MP3 audio
- Playable and downloadable audio in the client
- Environment-variable based API key loading via `.env`
- A command-line tool that writes MP3 audio to disk

Default model: `eleven_multilingual_v2`  
Low-latency note: use `eleven_flash_v2_5` when low latency matters.

## Project Structure

- `server.js` - Express server + ElevenLabs integration
- `cli.js` - Command-line tool for TTS generation
- `public/index.html` - Minimal frontend UI
- `.env.example` - Sample environment variables
- `package.json` - Scripts and dependencies

## Prerequisites

- Node.js 18+
- An ElevenLabs API key

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
cp .env.example .env
```

3. Add your ElevenLabs API key in `.env`:

```env
ELEVENLABS_API_KEY=your_real_key_here
PORT=3000
```

## Run

Production mode:

```bash
npm start
```

Development mode (auto-reload):

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## CLI Usage

Run from this project:

```bash
npm run tts -- --text "Hello from CLI" --voice-id 21m00Tcm4TlvDq8ikWAM
```

Options:
- `--text`, `-t` (required): text to synthesize
- `--voice-id`, `-v` (required): ElevenLabs `voice_id`
- `--model-id`, `-m` (optional): defaults to `eleven_multilingual_v2`
- `--output`, `-o` (optional): output file path, defaults to `output/speech-YYYYMMDD-HHMMSS.mp3`

Examples:

```bash
# Default model (eleven_multilingual_v2)
npm run tts -- --text "Hello world" --voice-id 21m00Tcm4TlvDq8ikWAM

# Low-latency model
npm run tts -- --text "Quick response" --voice-id 21m00Tcm4TlvDq8ikWAM --model-id eleven_flash_v2_5 --output quick.mp3
```

## API

### `POST /api/tts`

Calls the official ElevenLabs Text-to-Speech endpoint:

`POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`

Headers sent to ElevenLabs include:
- `xi-api-key: <your key>`
- `Content-Type: application/json`
- `Accept: audio/mpeg`

#### Request JSON

```json
{
  "text": "Hello from ElevenLabs",
  "voice_id": "21m00Tcm4TlvDq8ikWAM",
  "model_id": "eleven_multilingual_v2"
}
```

- `text` (required)
- `voice_id` (required)
- `model_id` (optional, defaults to `eleven_multilingual_v2`)

#### Success response

- HTTP `200`
- Binary MP3 audio (`Content-Type: audio/mpeg`)

#### Error response

JSON payload:

```json
{
  "error": "ElevenLabs API error",
  "message": "Human-readable error",
  "details": {}
}
```

Validation and timeout errors are also returned as JSON with appropriate HTTP status codes.

## Notes

- Keep your API key secret. Never expose it in client-side code.
- The browser UI calls your own backend (`/api/tts`), not ElevenLabs directly.
