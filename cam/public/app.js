// ── DOM refs ───────────────────────────────────────────────────────
const $feed       = document.getElementById('camera-feed');
const $noFeed     = document.getElementById('no-feed');
const $fpsBadge   = document.getElementById('fps-badge');
const $connStatus = document.getElementById('conn-status');
const $btnStream  = document.getElementById('btn-stream');
const $btnCapture = document.getElementById('btn-capture');
const $btnRecord  = document.getElementById('btn-record');
const $recStatus  = document.getElementById('rec-status');
const $log        = document.getElementById('log');
const $overlay    = document.getElementById('analysis-overlay');
const $analysisLoading = document.getElementById('analysis-loading');
const $analysisData    = document.getElementById('analysis-data');
const $analysisContent = document.getElementById('analysis-content');
const $analysisJson    = document.getElementById('analysis-json');
const $btnCloseAnalysis = document.getElementById('btn-close-analysis');
const $btnCopyJson     = document.getElementById('btn-copy-json');
const $dataScreenText  = document.getElementById('data-screen-text');
const $dataTypedText   = document.getElementById('data-typed-text');
const $dataScore       = document.getElementById('data-score');
const $dataAttempts    = document.getElementById('data-attempts');

let lastAnalysisData = null;

// ── State ──────────────────────────────────────────────────────────
let ws = null;
let isConnected = false;
let isStreaming = false;
let frameCount = 0;
let lastFpsCalc = Date.now();
let clientFps = 0;

let prevBlobUrl = null;

// Recording state
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordCanvas = null;
let recordCtx = null;
let recordStartTime = 0;
let recTimerInterval = null;
let remoteRecording = false;

// ── WebSocket ──────────────────────────────────────────────────────
function initWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => log('Connected to server', 'ok');
    ws.onclose = () => {
        log('Server connection lost', 'err');
        setTimeout(initWS, 2000);
    };

    ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
            handleBinaryFrame(ev.data);
        } else {
            handleJsonMessage(JSON.parse(ev.data));
        }
    };
}

function handleBinaryFrame(ab) {
    const view = new DataView(ab);
    const jpegLen = view.getUint32(0, true);
    const jpeg = new Uint8Array(ab, 4, jpegLen);
    const blob = new Blob([jpeg], { type: 'image/jpeg' });

    if (prevBlobUrl) URL.revokeObjectURL(prevBlobUrl);
    prevBlobUrl = URL.createObjectURL(blob);
    $feed.src = prevBlobUrl;
    $feed.classList.add('active');
    $noFeed.style.display = 'none';

    frameCount++;
    const now = Date.now();
    if (now - lastFpsCalc >= 1000) {
        clientFps = frameCount;
        frameCount = 0;
        lastFpsCalc = now;
        $fpsBadge.textContent = `${clientFps} FPS`;
    }
}

$feed.addEventListener('load', () => {
    if (isRecording && recordCtx) {
        recordCanvas.width = $feed.naturalWidth || 640;
        recordCanvas.height = $feed.naturalHeight || 480;
        recordCtx.drawImage($feed, 0, 0);
    }
});

function handleJsonMessage(msg) {
    if (msg.type === 'status') {
        isConnected = msg.connected;
        updateUI();
        if (msg.error) log(`Error: ${msg.error}`, 'err');
    } else if (msg.type === 'remote-cmd') {
        handleRemoteCmd(msg);
    } else if (msg.type === 'log') {
        const cls = msg.message.startsWith('RSP:OK') ? 'ok'
                  : msg.message.startsWith('RSP:ERROR') ? 'err' : '';
        log(msg.message, cls);
    }
}

// ── Integration remote commands ─────────────────────────────────────
function handleRemoteCmd(msg) {
    if (msg.action === 'start-recording') {
        log(`[Integration] Start recording — target: ${msg.key}`, 'ok');
        if (!isStreaming) {
            cmd('CMD:STREAM');
            isStreaming = true;
            $btnStream.textContent = 'Stop Stream';
        }
        if (!isRecording) {
            remoteRecording = true;
            startRecording();
        }
    } else if (msg.action === 'stop-recording') {
        log('[Integration] Stop recording — analyzing', 'ok');
        if (isRecording) {
            stopRecording();
        }
    }
}

// ── Commands ───────────────────────────────────────────────────────
function send(obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); }
function cmd(c)    { send({ type: 'command', command: c }); }

// ── UI state sync ──────────────────────────────────────────────────
function updateUI() {
    const ctrls = [$btnStream, $btnCapture, $btnRecord];

    if (isConnected) {
        $connStatus.textContent = 'Connected';
        $connStatus.className = 'status ok';
        ctrls.forEach(el => el.disabled = false);
    } else {
        $connStatus.textContent = 'Waiting for device…';
        $connStatus.className = 'status';
        ctrls.forEach(el => el.disabled = true);
        isStreaming = false;
        $btnStream.textContent = 'Start Stream';
        $fpsBadge.textContent = '0 FPS';
    }
}

// ── Logging ────────────────────────────────────────────────────────
function log(text, cls = '') {
    const t = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.innerHTML = `<span class="ts">${t}</span> <span class="${cls}">${esc(text)}</span>`;
    $log.appendChild(line);
    $log.scrollTop = $log.scrollHeight;
    if ($log.children.length > 200) $log.firstChild.remove();
}

function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Event listeners ────────────────────────────────────────────────
$btnStream.addEventListener('click', () => {
    if (isStreaming) {
        cmd('CMD:STOP');
        isStreaming = false;
        $btnStream.textContent = 'Start Stream';
    } else {
        cmd('CMD:STREAM');
        isStreaming = true;
        $btnStream.textContent = 'Stop Stream';
    }
});

$btnCapture.addEventListener('click', () => cmd('CMD:CAPTURE'));

// ── Recording ──────────────────────────────────────────────────────
function startRecording() {
    recordCanvas = document.createElement('canvas');
    recordCanvas.width = $feed.naturalWidth || 640;
    recordCanvas.height = $feed.naturalHeight || 480;
    recordCtx = recordCanvas.getContext('2d');

    const stream = recordCanvas.captureStream(15);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9' : 'video/webm';
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    recordedChunks = [];

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        log(`Recording complete — ${(blob.size / 1024 / 1024).toFixed(1)} MB`, 'ok');
        const wasRemote = remoteRecording;
        remoteRecording = false;
        analyzeRecording(blob, wasRemote);
    };

    mediaRecorder.start(200);
    isRecording = true;
    recordStartTime = Date.now();

    $feed.classList.add('recording-border');
    $btnRecord.textContent = 'Stop Recording';
    $btnRecord.classList.add('recording');
    $recStatus.style.display = 'block';

    recTimerInterval = setInterval(() => {
        const sec = Math.floor((Date.now() - recordStartTime) / 1000);
        const m = String(Math.floor(sec / 60)).padStart(2, '0');
        const s = String(sec % 60).padStart(2, '0');
        $recStatus.textContent = `Recording ${m}:${s}`;
        $recStatus.className = 'status err';
    }, 500);
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    isRecording = false;
    clearInterval(recTimerInterval);

    $feed.classList.remove('recording-border');
    $btnRecord.textContent = 'Record';
    $btnRecord.classList.remove('recording');
    $recStatus.style.display = 'none';
}

$btnRecord.addEventListener('click', () => {
    if (isRecording) {
        stopRecording();
    } else {
        if (!isStreaming) {
            log('Start streaming before recording', 'err');
            return;
        }
        startRecording();
    }
});

// ── Gemini analysis ────────────────────────────────────────────────
let isAnalyzing = false;

async function analyzeRecording(videoBlob, remote = false) {
    if (isAnalyzing) {
        log('Analysis already in progress', 'err');
        return;
    }

    isAnalyzing = true;
    $btnRecord.disabled = true;
    $overlay.classList.remove('hidden');
    $analysisLoading.classList.remove('hidden');
    $analysisContent.innerHTML = '';
    $analysisData.classList.add('hidden');
    $analysisJson.textContent = '';
    $dataAttempts.innerHTML = '';

    log(`Uploading ${(videoBlob.size / 1024 / 1024).toFixed(1)} MB to Gemini…`);

    try {
        const analyzeUrl = remote ? '/api/analyze?remote=true' : '/api/analyze';
        const res = await fetch(analyzeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'video/webm' },
            body: videoBlob,
        });

        const body = await res.json();
        $analysisLoading.classList.add('hidden');

        if (!res.ok) {
            $analysisContent.innerHTML = `<div class="analysis-error">Error: ${esc(body.error)}</div>`;
            log(`Analysis failed: ${body.error}`, 'err');
            return;
        }

        if (body.analysis) {
            $analysisContent.innerHTML = renderMarkdown(body.analysis);
        }

        if (body.data) {
            lastAnalysisData = body.data;
            renderStructuredData(body.data);
            $analysisJson.textContent = JSON.stringify(body.data, null, 2);
        }

        log('Analysis complete', 'ok');
    } catch (e) {
        $analysisLoading.classList.add('hidden');
        $analysisContent.innerHTML = `<div class="analysis-error">Network error: ${esc(e.message)}</div>`;
        log(`Analysis error: ${e.message}`, 'err');
    } finally {
        isAnalyzing = false;
        $btnRecord.disabled = !isConnected;
    }
}

$btnCloseAnalysis.addEventListener('click', () => {
    $overlay.classList.add('hidden');
});

$btnCopyJson.addEventListener('click', () => {
    if (!lastAnalysisData) return;
    navigator.clipboard.writeText(JSON.stringify(lastAnalysisData, null, 2))
        .then(() => log('JSON copied to clipboard', 'ok'))
        .catch(() => log('Failed to copy JSON', 'err'));
});

// ── Render structured data cards ───────────────────────────────────
function renderStructuredData(d) {
    $analysisData.classList.remove('hidden');

    $dataScreenText.textContent = d.screen_text || '(none detected)';
    $dataTypedText.textContent = d.typed_text || '(none detected)';

    const score = d.overall_score ?? 0;
    $dataScore.textContent = score;
    $dataScore.className = 'big-score ' +
        (score >= 70 ? 'good' : score >= 40 ? 'mid' : 'low');

    if (d.attempts && d.attempts.length > 0) {
        const rows = d.attempts.map((a, i) => {
            const hitCls = a.hit_result === 'hit' ? 'hit'
                         : a.hit_result === 'miss' ? 'miss' : 'partial';
            const fmtShift = (v, unit) => {
                if (v == null) return '<span class="shift-zero">0</span>';
                const cls = v > 0 ? 'shift-pos' : v < 0 ? 'shift-neg' : 'shift-zero';
                const sign = v > 0 ? '+' : '';
                return `<span class="${cls}">${sign}${v}${unit}</span>`;
            };
            return `<tr>
                <td>${i + 1}</td>
                <td>${esc(a.intended_key || '?')}</td>
                <td>${esc(a.actual_key || '?')}</td>
                <td class="${hitCls}">${a.hit_result}</td>
                <td>${a.precision ?? '—'}/10</td>
                <td>${fmtShift(a.angle_shift, '°')}</td>
                <td>${fmtShift(a.distance_shift, '')}</td>
            </tr>`;
        }).join('');

        $dataAttempts.innerHTML = `<table>
            <thead><tr>
                <th>#</th><th>Target</th><th>Actual</th><th>Result</th>
                <th>Precision</th><th>Angle Shift</th><th>Dist Shift</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    }
}

// ── Minimal markdown → HTML ────────────────────────────────────────
function renderMarkdown(md) {
    let html = esc(md);

    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    html = html.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_m, hdr, _sep, rows) => {
        const ths = hdr.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
        const trs = rows.trim().split('\n').map(r => {
            const tds = r.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
            return `<tr>${tds}</tr>`;
        }).join('');
        return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
    });

    html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

    html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

    html = html.replace(/^(?!<[hulo]|<li|<table|<thead|<tbody|<tr|<td|<th)(.+)$/gm, '<p>$1</p>');

    html = html.replace(/\n{2,}/g, '\n');

    return html;
}

// ── Init ───────────────────────────────────────────────────────────
initWS();
