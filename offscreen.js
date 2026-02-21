// Offscreen document: handles getUserMedia(tab), WebRTC to OpenAI Realtime, audio playback, and caption events.

let tabId = null;
let settings = null;

let tabStream = null;
let pc = null;
let dc = null;
let audioCtx = null;
let origSource = null;
let origGain = null;
let transSource = null;
let transGain = null;
let origAudioEl = null;
let transAudioEl = null;

let speechActive = false;
let speechStartTs = 0;
let forceCommitTimer = null;

let responseInFlight = false;
let responseQueue = [];
let currentSourceText = '';
let currentTargetText = '';

const MANUAL_RESPONSE_MODE = false;

let localVadSource = null;
let localVadAnalyser = null;
let localVadTimer = null;
let localSpeechActive = false;
let localSpeechStartTs = 0;
let localLastVoiceTs = 0;
let awaitingLocalCommit = false;

function safeSendMessage(message) {
  const result = chrome.runtime.sendMessage(message);
  if (result && typeof result.catch === 'function') {
    result.catch(() => {});
  }
}

function sendLog(level, message, data) {
  safeSendMessage({
    type: 'LOG',
    scope: 'offscreen',
    level: level || 'info',
    message: message || '',
    data: data ?? null
  });
}

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[VOT offscreen]', ...args);
  try {
    const parts = args.map((item) => {
      if (typeof item === 'string') return item;
      try {
        return JSON.stringify(item);
      } catch (e) {
        return String(item);
      }
    });
    sendLog('info', parts.join(' '));
  } catch (e) {
    // ignore
  }
}

function sendStatus(state, message) {
  sendLog('info', 'status', { state, message });
  safeSendMessage({ type: 'OFFSCREEN_STATUS', state, message });
}

function sendFatal(message) {
  sendLog('error', 'fatal', { message });
  safeSendMessage({ type: 'OFFSCREEN_FATAL', message });
}

function sendCaptionUpdate(extra = {}) {
  safeSendMessage({
    type: 'CAPTION_UPDATE',
    tabId,
    sourceText: currentSourceText,
    targetText: currentTargetText,
    statusText: extra.statusText || undefined
  });
}

function makeInstructions() {
  const src = settings?.sourceLang && settings.sourceLang !== 'auto' ? settings.sourceLang : 'auto-detect';
  const tgt = settings?.targetLang || 'ru';

  return `Ты — синхронный переводчик.\n\n` +
    `Задача: переводить речь из аудио (язык: ${src}) на язык ${tgt} и озвучивать перевод.\n` +
    `Правила:\n` +
    `- Говори ТОЛЬКО перевод (без вступлений, без комментариев, без "перевод:" и т.п.).\n` +
    `- Переводи максимально быстро, но не в ущерб смыслу.\n` +
    `- Если в аудио музыка/шум/тишина — молчи.\n` +
    `- Не перебивай себя: лучше чуть подожди и выдай цельный перевод фразы.\n` +
    `- Можно опускать слова-паразиты и повторы.\n`;
}

function buildSessionConfig() {
  return {
    type: 'realtime',
    model: settings?.model || 'gpt-realtime-mini',
    output_modalities: ['audio'],
    instructions: makeInstructions(),
    audio: {
      output: {
        voice: settings?.voice || 'marin',
        speed: settings?.translationSpeed ?? 1.05
      }
    }
  };
}

function buildSessionUpdateConfig() {
  const cfg = buildSessionConfig();
  const turnDetection = {
    type: 'server_vad',
    create_response: true,
    interrupt_response: false,
    threshold: settings?.vadThreshold ?? 0.55,
    prefix_padding_ms: settings?.vadPrefixMs ?? 300,
    silence_duration_ms: settings?.vadSilenceMs ?? 700
  };

  return {
    type: 'realtime',
    output_modalities: cfg.output_modalities,
    instructions: cfg.instructions,
    audio: {
      ...(cfg.audio || {}),
      input: {
        turn_detection: turnDetection
      }
    }
  };
}

function removePath(obj, dottedPath) {
  if (!obj || !dottedPath) return false;
  const parts = dottedPath.split('.').filter(Boolean);
  if (parts.length === 0) return false;

  let node = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!node || typeof node !== 'object' || !(key in node)) return false;
    node = node[key];
  }

  const leaf = parts[parts.length - 1];
  if (!node || typeof node !== 'object' || !(leaf in node)) return false;
  delete node[leaf];
  return true;
}

async function createClientSecret(openaiApiKey) {
  const session = buildSessionConfig();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resp = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ session })
    });

    if (resp.ok) {
      const data = await resp.json();
      if (!data?.value) throw new Error('client_secrets: missing value');
      return data.value;
    }

    const text = await resp.text().catch(() => '');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = null;
    }

    const unknownParam = parsed?.error?.type === 'invalid_request_error'
      ? parsed?.error?.param
      : null;

    if (unknownParam && unknownParam.startsWith('session.') && attempt < 2) {
      const paramPath = unknownParam.replace(/^session\./, '');
      const protectedPaths = new Set(['type']);
      if (protectedPaths.has(paramPath)) {
        throw new Error(`client_secrets error: ${resp.status} ${resp.statusText} ${text}`);
      }
      const removed = removePath(session, paramPath);
      sendLog('warn', 'client_secrets.retry_without_unknown_param', {
        attempt: attempt + 1,
        param: unknownParam,
        removed
      });
      if (removed) {
        continue;
      }
    }

    throw new Error(`client_secrets error: ${resp.status} ${resp.statusText} ${text}`);
  }

  throw new Error('client_secrets: exhausted retries');
}

async function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise((resolve) => {
    const onState = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onState);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', onState);
    // Fallback timeout
    setTimeout(resolve, 3000);
  });
}

function sendEvent(evt) {
  if (!dc || dc.readyState !== 'open') return;
  dc.send(JSON.stringify(evt));
}

function ensureAudioContext() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function ensureAudioElement(kind) {
  const existing = kind === 'translated' ? transAudioEl : origAudioEl;
  if (existing) return existing;

  const el = document.createElement('audio');
  el.autoplay = true;
  el.playsInline = true;
  el.style.display = 'none';
  document.body.appendChild(el);

  if (kind === 'translated') {
    transAudioEl = el;
  } else {
    origAudioEl = el;
  }

  return el;
}

async function attachStreamToElement(kind, stream, volume) {
  const el = ensureAudioElement(kind);
  el.srcObject = stream;
  el.volume = Math.max(0, Math.min(1, Number(volume ?? 1)));
  try {
    await el.play();
  } catch (e) {
    sendLog('warn', 'audio.element.play.failed', {
      kind,
      error: e?.message || String(e)
    });
  }
}

async function startAudioPlayback() {
  ensureAudioContext();
  try {
    if (audioCtx.state !== 'running') {
      await audioCtx.resume();
    }
  } catch (e) {
    // ignore
  }
}

function setupOriginalAudio(stream) {
  // Do not re-play original tab stream from offscreen to avoid echo/doubling.
  // Browser tab audio remains the source of original audio.
  void stream;
}

function setupTranslatedAudio(stream) {
  // Prefer direct media element playback in offscreen for reliability.
  attachStreamToElement('translated', stream, settings?.translatedVolume ?? 1.0);
}

function startLocalVad(stream) {
  ensureAudioContext();

  if (localVadSource) {
    try { localVadSource.disconnect(); } catch (e) {}
    localVadSource = null;
  }
  localVadAnalyser = audioCtx.createAnalyser();
  localVadAnalyser.fftSize = 1024;
  localVadSource = audioCtx.createMediaStreamSource(stream);
  localVadSource.connect(localVadAnalyser);

  const samples = new Uint8Array(localVadAnalyser.fftSize);
  const voiceThreshold = Number(settings?.vadThreshold ?? 0.55) * 0.08;
  const silenceMs = Number(settings?.vadSilenceMs ?? 650);

  if (localVadTimer) clearInterval(localVadTimer);
  localVadTimer = setInterval(() => {
    if (!localVadAnalyser || !dc || dc.readyState !== 'open') return;

    localVadAnalyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const centered = (samples[i] - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();

    if (rms >= voiceThreshold) {
      localLastVoiceTs = now;
      if (!localSpeechActive) {
        localSpeechActive = true;
        localSpeechStartTs = now;
        sendCaptionUpdate({ statusText: 'Слушаю…' });
      }
      return;
    }

    if (localSpeechActive && now - localLastVoiceTs >= silenceMs) {
      const utteranceMs = localLastVoiceTs - localSpeechStartTs;
      localSpeechActive = false;

      if (utteranceMs >= 220) {
        sendLog('info', 'local_vad.commit', { utteranceMs, rms, voiceThreshold });
        awaitingLocalCommit = true;
        sendEvent({ type: 'input_audio_buffer.commit' });
      }
    }
  }, 80);
}

function stopLocalVad() {
  if (localVadTimer) {
    clearInterval(localVadTimer);
    localVadTimer = null;
  }
  if (localVadSource) {
    try { localVadSource.disconnect(); } catch (e) {}
    localVadSource = null;
  }
  localVadAnalyser = null;
  localSpeechActive = false;
  awaitingLocalCommit = false;
}

function resetTranscripts() {
  currentSourceText = '';
  currentTargetText = '';
  sendCaptionUpdate({ statusText: '…' });
}

function scheduleForceCommit() {
  return;
  clearForceCommit();

  // Force-chunk long uninterrupted speech so we don't "freeze" on streams without pauses.
  // 4s is a decent compromise; make it configurable later.
  const MAX_CHUNK_MS = 4000;

  forceCommitTimer = setInterval(() => {
    if (!speechActive) return;
    const elapsed = Date.now() - speechStartTs;
    if (elapsed >= MAX_CHUNK_MS) {
      log('Force commit after', elapsed, 'ms');
      // Commit current audio buffer slice.
      sendEvent({ type: 'input_audio_buffer.commit' });
      // Reset timer baseline.
      speechStartTs = Date.now();
    }
  }, 500);
}

function clearForceCommit() {
  if (forceCommitTimer) {
    clearInterval(forceCommitTimer);
    forceCommitTimer = null;
  }
}

function queueResponseForItem(itemId) {
  if (!MANUAL_RESPONSE_MODE) return;
  responseQueue.push(itemId ?? null);
  maybeCreateResponse();
}

function maybeCreateResponse() {
  if (!MANUAL_RESPONSE_MODE) return;
  if (!dc || dc.readyState !== 'open') return;
  if (responseInFlight) return;
  if (responseQueue.length === 0) return;
  const nextItemId = responseQueue.shift();

  responseInFlight = true;
  currentTargetText = '';
  sendCaptionUpdate({ statusText: 'Перевод…' });

  sendEvent({
    type: 'response.create',
    response: {
      output_modalities: ['audio'],
      ...(nextItemId ? { metadata: { source_item_id: nextItemId } } : {})
    }
  });
}

function handleServerEvent(evt) {
  if (!evt?.type) return;
  sendLog('info', 'server.event', { type: evt.type });

  switch (evt.type) {
    case 'session.created':
      sendStatus('session', 'Сессия создана');
      break;

    case 'session.updated':
      sendStatus('ready', 'Подключено');
      break;

    case 'input_audio_buffer.speech_started':
      speechActive = true;
      speechStartTs = Date.now();
      // clear target while user is speaking
      sendCaptionUpdate({ statusText: 'Слушаю…' });
      break;

    case 'input_audio_buffer.speech_stopped':
      speechActive = false;
      clearForceCommit();
      break;

    case 'input_audio_buffer.committed':
      if (MANUAL_RESPONSE_MODE && awaitingLocalCommit) {
        awaitingLocalCommit = false;
        queueResponseForItem(evt.item_id || null);
      }
      break;

    case 'conversation.item.input_audio_transcription.delta':
      if (typeof evt.delta === 'string') {
        currentSourceText += evt.delta;
        sendCaptionUpdate({ statusText: 'Слушаю…' });
      }
      break;

    case 'conversation.item.input_audio_transcription.completed':
      if (typeof evt.transcript === 'string') {
        currentSourceText = evt.transcript;
        sendCaptionUpdate({ statusText: '…' });
      }
      break;

    // Output audio transcript (what the model says)
    case 'response.output_audio_transcription.delta':
    case 'response.output_audio_transcript.delta':
      if (typeof evt.delta === 'string') {
        currentTargetText += evt.delta;
        sendCaptionUpdate({ statusText: 'Говорю…' });
      }
      break;

    case 'response.created':
      responseInFlight = true;
      break;

    case 'response.output_text.delta':
      // Fallback if model outputs text modality in the future
      if (typeof evt.delta === 'string') {
        currentTargetText += evt.delta;
        sendCaptionUpdate({ statusText: 'Говорю…' });
      }
      break;

    case 'response.done':
      responseInFlight = false;
      sendCaptionUpdate({ statusText: 'Подключено' });
      // Create next queued response (if any)
      if (MANUAL_RESPONSE_MODE) {
        maybeCreateResponse();
      }
      break;

    case 'error':
      if (typeof evt.error?.message === 'string' && evt.error.message.includes('active response in progress')) {
        responseInFlight = true;
        sendLog('warn', 'server.error.suppressed', { reason: 'active_response_in_progress' });
        break;
      }
      if (typeof evt.error?.message === 'string' && evt.error.message.includes('buffer too small')) {
        sendLog('warn', 'server.error.suppressed', { reason: 'buffer_too_small' });
        break;
      }
      sendStatus('error', evt.error?.message || 'Ошибка realtime');
      break;

    default:
      // ignore
      break;
  }
}

async function connectOpenAIRealtime(stream) {
  const openaiApiKey = settings?.openaiApiKey;
  if (!openaiApiKey) throw new Error('Missing OpenAI API key');

  sendLog('info', 'realtime.connect.start', {
    model: settings?.model || 'gpt-realtime-mini',
    vadMode: settings?.vadMode || 'server_vad'
  });

  sendStatus('auth', 'Создаю client secret…');
  const clientSecret = await createClientSecret(openaiApiKey);

  sendStatus('webrtc', 'Подключаю WebRTC…');
  pc = new RTCPeerConnection();

  // Send the tab audio to the model
  for (const track of stream.getAudioTracks()) {
    pc.addTrack(track, stream);
  }

  pc.ontrack = (event) => {
    sendLog('info', 'pc.ontrack', {
      kind: event.track?.kind,
      streams: event.streams?.length || 0
    });
    const remoteStream = event.streams?.[0] || new MediaStream([event.track]);
    setupTranslatedAudio(remoteStream);
  };

  pc.onconnectionstatechange = () => {
    log('pc.connectionState', pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      sendStatus('reconnecting', `WebRTC ${pc.connectionState}`);
    }
  };

  dc = pc.createDataChannel('oai-events');
  dc.onopen = () => {
    log('datachannel open');
    sendEvent({ type: 'session.update', session: buildSessionUpdateConfig() });
    sendLog('info', 'session.update.sent', {
      reason: 'set_audio_input_turn_detection_interrupt_false'
    });
    sendStatus('connected', 'Подключено');
    resetTranscripts();
  };

  dc.onmessage = (e) => {
    try {
      const evt = JSON.parse(e.data);
      handleServerEvent(evt);
    } catch (err) {
      // ignore
    }
  };

  dc.onerror = (e) => {
    log('datachannel error', e);
    sendLog('error', 'datachannel.error', { error: String(e) });
  };

  // SDP offer/answer handshake
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);

  const url = `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(settings?.model || 'gpt-realtime-mini')}`;
  const makeCallsRequest = async (useBetaHeader) => {
    const headers = {
      'Authorization': `Bearer ${clientSecret}`,
      'Content-Type': 'application/sdp'
    };
    if (useBetaHeader) {
      headers['OpenAI-Beta'] = 'realtime=v1';
    }
    return fetch(url, {
      method: 'POST',
      headers,
      body: pc.localDescription.sdp
    });
  };

  let sdpResp = await makeCallsRequest(false);

  if (!sdpResp.ok) {
    const firstText = await sdpResp.text().catch(() => '');
    let firstParsed = null;
    try {
      firstParsed = JSON.parse(firstText);
    } catch (e) {
      firstParsed = null;
    }

    const mismatchCode = firstParsed?.error?.code;
    if (mismatchCode === 'api_version_mismatch') {
      sendLog('warn', 'realtime.calls.version_mismatch_retry_with_beta', { code: mismatchCode });
      sdpResp = await makeCallsRequest(true);
      if (!sdpResp.ok) {
        const retryText = await sdpResp.text().catch(() => '');
        throw new Error(`realtime/calls error: ${sdpResp.status} ${sdpResp.statusText} ${retryText}`);
      }
    } else {
      throw new Error(`realtime/calls error: ${sdpResp.status} ${sdpResp.statusText} ${firstText}`);
    }
  }

  const answerSdp = await sdpResp.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
}

async function start({ tabId: tId, streamId, settings: s }) {
  sendLog('info', 'offscreen.start.requested', {
    tabId: tId,
    hasStreamId: !!streamId
  });
  tabId = tId;
  settings = s;

  await stop();

  sendStatus('starting', 'Захватываю звук вкладки…');

  // Get the tab audio stream using the streamId from tabCapture.getMediaStreamId()
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  await startAudioPlayback();
  setupOriginalAudio(tabStream);
  await connectOpenAIRealtime(tabStream);
  sendLog('info', 'offscreen.start.completed', { tabId });
}

async function stop() {
  sendLog('info', 'offscreen.stop.requested', { tabId });
  clearForceCommit();
  stopLocalVad();
  speechActive = false;
  responseQueue = [];
  responseInFlight = false;

  if (dc) {
    try { dc.close(); } catch (e) {}
    dc = null;
  }

  if (pc) {
    try { pc.close(); } catch (e) {}
    pc = null;
  }

  if (tabStream) {
    for (const t of tabStream.getTracks()) {
      try { t.stop(); } catch (e) {}
    }
    tabStream = null;
  }

  if (origSource) {
    try { origSource.disconnect(); } catch (e) {}
    origSource = null;
  }
  if (transSource) {
    try { transSource.disconnect(); } catch (e) {}
    transSource = null;
  }

  if (audioCtx) {
    try { await audioCtx.close(); } catch (e) {}
    audioCtx = null;
  }

  if (origAudioEl) {
    try { origAudioEl.pause(); } catch (e) {}
    origAudioEl.srcObject = null;
  }
  if (transAudioEl) {
    try { transAudioEl.pause(); } catch (e) {}
    transAudioEl.srcObject = null;
  }

  currentSourceText = '';
  currentTargetText = '';
  sendLog('info', 'offscreen.stop.completed');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return false;

  if (msg.type === 'OFFSCREEN_START') {
    (async () => {
      try {
        await start(msg);
        sendResponse({ ok: true });
      } catch (e) {
        log('start error', e);
        sendFatal(e?.message || String(e));
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'OFFSCREEN_STOP') {
    (async () => {
      try {
        await stop();
      } catch (e) {}
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});
