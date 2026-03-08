require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_TTS_BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const REQUEST_TIMEOUT_MS = 30_000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/tts', async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'Missing ELEVENLABS_API_KEY in environment variables.'
      });
    }

    const { text, voice_id: voiceId, model_id: modelId } = req.body || {};

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Field "text" is required and must be a non-empty string.'
      });
    }

    if (typeof voiceId !== 'string' || !voiceId.trim()) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Field "voice_id" is required and must be a non-empty string.'
      });
    }

    const payload = {
      text: text.trim(),
      model_id: typeof modelId === 'string' && modelId.trim() ? modelId.trim() : DEFAULT_MODEL_ID
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let elevenLabsResponse;

    try {
      elevenLabsResponse = await fetch(`${ELEVENLABS_TTS_BASE_URL}/${encodeURIComponent(voiceId.trim())}`, {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!elevenLabsResponse.ok) {
      const rawError = await elevenLabsResponse.text();
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

      return res.status(elevenLabsResponse.status).json({
        error: 'ElevenLabs API error',
        message: typeof upstreamMessage === 'string' ? upstreamMessage : 'ElevenLabs request failed.',
        details: parsed || rawError
      });
    }

    const audioBuffer = Buffer.from(await elevenLabsResponse.arrayBuffer());

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Content-Disposition', 'attachment; filename="speech.mp3"');

    return res.status(200).send(audioBuffer);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return res.status(504).json({
        error: 'Gateway timeout',
        message: 'The ElevenLabs request timed out. Please try again.'
      });
    }

    console.error('Unexpected /api/tts error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Unexpected server error while generating speech.'
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
