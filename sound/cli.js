#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_TTS_BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const DEFAULT_OUTPUT_DIR = 'output';
const DEFAULT_OUTPUT_PATTERN = 'output/speech-YYYYMMDD-HHMMSS.mp3';
const REQUEST_TIMEOUT_MS = 30_000;

function getTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');

  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hour = pad(now.getHours());
  const minute = pad(now.getMinutes());
  const second = pad(now.getSeconds());

  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function getDefaultOutputFile() {
  return path.join(DEFAULT_OUTPUT_DIR, `speech-${getTimestamp()}.mp3`);
}

function printHelp() {
  console.log(`
ElevenLabs TTS CLI

Usage:
  node cli.js --text "Hello world" --voice-id <VOICE_ID> [options]
  npm run tts -- --text "Hello world" --voice-id <VOICE_ID> [options]

Required:
  --text, -t         Text to synthesize
  --voice-id, -v     ElevenLabs voice_id

Optional:
  --model-id, -m     ElevenLabs model_id (default: ${DEFAULT_MODEL_ID})
  --output, -o       Output MP3 path (default: ${DEFAULT_OUTPUT_PATTERN})
  --help, -h         Show this help message

Examples:
  npm run tts -- --text "Hi there" --voice-id 21m00Tcm4TlvDq8ikWAM
  npm run tts -- --text "Fast mode" --voice-id 21m00Tcm4TlvDq8ikWAM --model-id eleven_flash_v2_5 --output fast.mp3
`);
}

function parseArgs(argv) {
  const args = {
    text: '',
    voiceId: '',
    modelId: DEFAULT_MODEL_ID,
    output: '',
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }

    if (arg === '--text' || arg === '-t') {
      args.text = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (arg === '--voice-id' || arg === '-v') {
      args.voiceId = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (arg === '--model-id' || arg === '-m') {
      args.modelId = argv[i + 1] || DEFAULT_MODEL_ID;
      i += 1;
      continue;
    }

    if (arg === '--output' || arg === '-o') {
      args.output = argv[i + 1] || '';
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  args.text = String(args.text).trim();
  args.voiceId = String(args.voiceId).trim();
  args.modelId = String(args.modelId || DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
  args.output = String(args.output || '').trim();

  return args;
}

async function generateSpeech({ text, voiceId, modelId, output }) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('Missing ELEVENLABS_API_KEY in .env');
  }

  if (!text) {
    throw new Error('Missing required argument: --text');
  }

  if (!voiceId) {
    throw new Error('Missing required argument: --voice-id');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${ELEVENLABS_TTS_BASE_URL}/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id: modelId
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const rawError = await response.text();
    let parsed;

    try {
      parsed = JSON.parse(rawError);
    } catch {
      parsed = null;
    }

    const upstreamMessage =
      parsed?.detail?.message ||
      parsed?.detail ||
      parsed?.message ||
      rawError ||
      'ElevenLabs request failed.';

    throw new Error(`ElevenLabs API error (${response.status}): ${upstreamMessage}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  const outputPath = path.resolve(process.cwd(), output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, audioBuffer);

  return outputPath;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
      printHelp();
      return;
    }

    const outputPath = await generateSpeech({
      ...args,
      output: args.output || getDefaultOutputFile()
    });
    console.log(`Saved MP3: ${outputPath}`);
    console.log(`Model used: ${args.modelId}`);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      console.error('Error: ElevenLabs request timed out.');
      process.exit(1);
    }

    console.error(`Error: ${error.message || 'Unknown error'}`);
    printHelp();
    process.exit(1);
  }
}

main();
