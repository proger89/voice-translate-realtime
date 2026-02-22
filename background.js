// MV3 service worker (module)

const OFFSCREEN_URL = 'offscreen.html';
const DEFAULT_SETTINGS = {
  uiLang: 'en',
  provider: 'openai',
  openaiApiKey: '',
  model: 'gpt-realtime-mini',
  voice: 'marin',
  sourceLang: 'auto',
  targetLang: 'ru',
  vadMode: 'server_vad', // server_vad | semantic_vad
  vadThreshold: 0.55,
  vadSilenceMs: 650,
  vadPrefixMs: 300,
  interruptResponse: false,
  createResponse: false, // we will manually queue response.create events
  translationSpeed: 1.05,
  originalVolume: 0.0,
  translatedVolume: 1.0
};

const I18N = {
  en: {
    missingApiKey: 'Specify OpenAI API key in extension settings.',
    noActiveTab: 'Failed to determine active tab.',
    streamIdError: 'tabCapture did not provide streamId: {error}',
    starting: 'Starting…',
    stopped: 'Stopped',
    offscreenFatal: 'Offscreen error'
  },
  ru: {
    missingApiKey: 'Укажите OpenAI API key в настройках расширения.',
    noActiveTab: 'Не удалось определить активную вкладку.',
    streamIdError: 'tabCapture не дал streamId: {error}',
    starting: 'Запуск…',
    stopped: 'Остановлено',
    offscreenFatal: 'Ошибка в offscreen'
  }
};

function getUiLang(settings) {
  return settings?.uiLang === 'ru' ? 'ru' : 'en';
}

function detectInitialUiLang() {
  try {
    const browserLang = (chrome.i18n?.getUILanguage?.() || '').toLowerCase();
    return browserLang.startsWith('ru') ? 'ru' : 'en';
  } catch (e) {
    return 'en';
  }
}

function t(settings, key, vars = {}) {
  const lang = getUiLang(settings);
  const dict = I18N[lang] || I18N.en;
  const fallback = I18N.en[key] || key;
  let text = dict[key] || fallback;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

let creatingOffscreen = null;
let currentTabId = null;
let running = false;
let logWriteQueue = Promise.resolve();

const LOG_STORAGE_KEY = 'debugLogs';
const MAX_LOG_ENTRIES = 3000;

function safeSendMessage(message) {
  const result = chrome.runtime.sendMessage(message);
  if (result && typeof result.catch === 'function') {
    result.catch(() => {});
  }
}

function normalizeLogData(data) {
  if (data === undefined || data === null) return null;
  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') return data;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch (e) {
    return String(data);
  }
}

function enqueueLogWrite(task) {
  logWriteQueue = logWriteQueue
    .then(task)
    .catch(() => {});
  return logWriteQueue;
}

function writeLog(level, scope, message, data) {
  const entry = {
    ts: new Date().toISOString(),
    level: level || 'info',
    scope: scope || 'background',
    message: message || '',
    data: normalizeLogData(data)
  };

  const printer = entry.level === 'error' ? console.error : entry.level === 'warn' ? console.warn : console.log;
  printer('[VOT]', entry.scope, entry.message, entry.data ?? '');

  return enqueueLogWrite(async () => {
    const storage = await chrome.storage.local.get(LOG_STORAGE_KEY);
    const logs = Array.isArray(storage[LOG_STORAGE_KEY]) ? storage[LOG_STORAGE_KEY] : [];
    logs.push(entry);
    if (logs.length > MAX_LOG_ENTRIES) {
      logs.splice(0, logs.length - MAX_LOG_ENTRIES);
    }
    await chrome.storage.local.set({ [LOG_STORAGE_KEY]: logs });
  });
}

function formatLogLine(entry) {
  const base = `${entry.ts || ''} [${entry.level || 'info'}] [${entry.scope || 'background'}] ${entry.message || ''}`;
  if (entry.data === null || entry.data === undefined) return base;
  if (typeof entry.data === 'string') return `${base} | ${entry.data}`;
  return `${base} | ${JSON.stringify(entry.data)}`;
}

async function exportLogsToFile(reason = 'manual', saveAs = true) {
  const storage = await chrome.storage.local.get(LOG_STORAGE_KEY);
  const logs = Array.isArray(storage[LOG_STORAGE_KEY]) ? storage[LOG_STORAGE_KEY] : [];

  const lines = [
    '# Tab Voice Translator debug log',
    `# created_at=${new Date().toISOString()}`,
    `# reason=${reason}`,
    `# entries=${logs.length}`,
    ''
  ];

  for (const entry of logs) {
    lines.push(formatLogLine(entry));
  }

  const text = lines.join('\n');
  const filename = `realtime-tab-translator/log-${Date.now()}-${reason}.log`;

  await chrome.downloads.download({
    url: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`,
    filename,
    saveAs
  });

  return { filename, count: logs.length };
}

async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.sync.set({ settings: next });
  return next;
}

async function ensureOffscreen() {
  await writeLog('info', 'background', 'ensureOffscreen.start');
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);

  // Chrome 116+
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length > 0) {
      await writeLog('info', 'background', 'ensureOffscreen.alreadyExists', { contexts: contexts.length });
      return;
    }
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA', 'WEB_RTC', 'AUDIO_PLAYBACK'],
    justification: 'Capture tab audio, stream it to a realtime translation model, and play translated audio.'
  });

  await creatingOffscreen;
  creatingOffscreen = null;
  await writeLog('info', 'background', 'ensureOffscreen.created');
}

async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
    await writeLog('info', 'background', 'offscreen.closed');
  } catch (e) {
    // ignore
    await writeLog('warn', 'background', 'offscreen.closeFailed', { error: e?.message || String(e) });
  }
}

async function injectOverlay(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['overlay.css'] });
  } catch (e) {
    // ignore duplicate
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
  } catch (e) {
    // ignore
  }
}

async function startOnActiveTab() {
  await writeLog('info', 'background', 'start.requested');
  const settings = await getSettings();
  if (!settings.openaiApiKey) {
    await writeLog('warn', 'background', 'start.blocked.missingApiKey');
    await setStatus('error', t(settings, 'missingApiKey'));
    return { ok: false, reason: 'missing_api_key' };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    await writeLog('error', 'background', 'start.failed.noActiveTab');
    await setStatus('error', t(settings, 'noActiveTab'));
    return { ok: false, reason: 'no_active_tab' };
  }

  currentTabId = tab.id;
  running = true;

  await injectOverlay(currentTabId);

  await ensureOffscreen();

  // Get a stream ID for the tab audio that the offscreen document can consume
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: currentTabId });
    await writeLog('info', 'background', 'start.streamId.ok', { tabId: currentTabId });
  } catch (e) {
    running = false;
    await writeLog('error', 'background', 'start.streamId.failed', { error: e?.message || String(e) });
    await setStatus('error', t(settings, 'streamIdError', { error: e?.message || e }));
    return { ok: false, reason: 'stream_id_error', error: e?.message || String(e) };
  }

  // Tell offscreen to start
  safeSendMessage({
    type: 'OFFSCREEN_START',
    tabId: currentTabId,
    streamId,
    settings
  });

  await chrome.storage.session.set({ running: true, tabId: currentTabId });
  await chrome.action.setBadgeText({ text: 'ON' });
  await chrome.action.setBadgeBackgroundColor({ color: '#0b7d3a' });
  await setStatus('starting', t(settings, 'starting'));
  await writeLog('info', 'background', 'start.dispatchedToOffscreen', { tabId: currentTabId });
  return { ok: true };
}

async function stop() {
  await writeLog('info', 'background', 'stop.requested');
  const settings = await getSettings();
  running = false;
  const { tabId } = await chrome.storage.session.get('tabId');
  const targetTabId = tabId || currentTabId;

  safeSendMessage({ type: 'OFFSCREEN_STOP' });

  if (targetTabId) {
    try {
      await chrome.tabs.sendMessage(targetTabId, { type: 'VOT_STOP' });
    } catch (e) {
      // ignore
    }
  }

  await chrome.storage.session.set({ running: false, tabId: null });
  await chrome.action.setBadgeText({ text: '' });
  await setStatus('stopped', t(settings, 'stopped'));

  // Optional: keep offscreen alive for fast restart, or close to be tidy.
  // We'll close to reduce resources.
  await closeOffscreen();
  await writeLog('info', 'background', 'stop.completed');
}

async function setStatus(state, message) {
  await writeLog('info', 'status', 'setStatus', { state, message });
  // Update popup (if open)
  safeSendMessage({ type: 'STATUS', state, message });
  // Update overlay in page
  const { tabId } = await chrome.storage.session.get('tabId');
  const targetTabId = tabId || currentTabId;
  if (targetTabId) {
    try {
      await chrome.tabs.sendMessage(targetTabId, { type: 'STATUS', state, message });
    } catch (e) {
      // ignore
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  // Set defaults only if not set
  const { settings } = await chrome.storage.sync.get('settings');
  if (!settings) {
    await chrome.storage.sync.set({
      settings: {
        ...DEFAULT_SETTINGS,
        uiLang: detectInitialUiLang()
      }
    });
  } else if (!settings.uiLang) {
    await chrome.storage.sync.set({
      settings: {
        ...DEFAULT_SETTINGS,
        ...settings,
        uiLang: 'en'
      }
    });
  }
  await writeLog('info', 'background', 'extension.installedOrUpdated');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return false;

  writeLog('info', 'background.message', 'received', {
    type: msg.type,
    from: sender?.url || sender?.id || 'unknown'
  });

  if (msg.type === 'POPUP_GET_STATE') {
    (async () => {
      try {
        const s = await getSettings();
        const sess = await chrome.storage.session.get(['running', 'tabId']);
        sendResponse({ ok: true, settings: s, running: !!sess.running });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'POPUP_SAVE_SETTINGS') {
    (async () => {
      try {
        const next = await saveSettings(msg.patch || {});
        sendResponse({ ok: true, settings: next });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'POPUP_START') {
    (async () => {
      try {
        const result = await startOnActiveTab();
        sendResponse(result || { ok: false, reason: 'unknown_start_result' });
      } catch (e) {
        await writeLog('error', 'background', 'POPUP_START.failed', { error: e?.message || String(e) });
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'POPUP_STOP') {
    (async () => {
      try {
        await stop();
        sendResponse({ ok: true });
      } catch (e) {
        await writeLog('error', 'background', 'POPUP_STOP.failed', { error: e?.message || String(e) });
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'POPUP_EXPORT_LOGS') {
    (async () => {
      try {
        const exported = await exportLogsToFile('manual', true);
        await writeLog('info', 'background', 'logs.exported.manual', exported);
        sendResponse({ ok: true, ...exported });
      } catch (e) {
        await writeLog('error', 'background', 'logs.export.manual.failed', { error: e?.message || String(e) });
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'LOG') {
    (async () => {
      try {
        await writeLog(msg.level || 'info', msg.scope || 'offscreen', msg.message || '', msg.data);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'CAPTION_UPDATE') {
    (async () => {
      try {
        const { tabId } = msg;
        if (tabId) {
          try {
            await chrome.tabs.sendMessage(tabId, msg);
          } catch (e) {
            // ignore
          }
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'OFFSCREEN_STATUS') {
    (async () => {
      try {
        await setStatus(msg.state, msg.message);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'OFFSCREEN_FATAL') {
    (async () => {
      try {
        const settings = await getSettings();
        await writeLog('error', 'background', 'offscreen.fatal', { message: msg.message || t(settings, 'offscreenFatal') });
        running = false;
        await setStatus('error', msg.message || t(settings, 'offscreenFatal'));
        try {
          const exported = await exportLogsToFile('fatal', false);
          await writeLog('info', 'background', 'logs.exported.fatal', exported);
        } catch (exportErr) {
          await writeLog('warn', 'background', 'logs.export.fatal.failed', { error: exportErr?.message || String(exportErr) });
        }
        await stop();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  return false;
});

// Safety: if the tab is closed while running, stop.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const sess = await chrome.storage.session.get(['running', 'tabId']);
  if (sess.running && sess.tabId === tabId) {
    await writeLog('info', 'background', 'tab.closedWhileRunning', { tabId });
    await stop();
  }
});
