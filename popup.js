const els = {
  uiLang: document.getElementById('uiLang'),
  apiKey: document.getElementById('apiKey'),
  sourceLang: document.getElementById('sourceLang'),
  targetLang: document.getElementById('targetLang'),
  model: document.getElementById('model'),
  voice: document.getElementById('voice'),
  vadMode: document.getElementById('vadMode'),
  vadThreshold: document.getElementById('vadThreshold'),
  vadSilenceMs: document.getElementById('vadSilenceMs'),
  originalVolume: document.getElementById('originalVolume'),
  translatedVolume: document.getElementById('translatedVolume'),
  translationSpeed: document.getElementById('translationSpeed'),
  saveBtn: document.getElementById('saveBtn'),
  toggleBtn: document.getElementById('toggleBtn'),
  exportLogsBtn: document.getElementById('exportLogsBtn'),
  status: document.getElementById('status')
};

let running = false;
let currentUiLang = 'en';

const I18N = {
  en: {
    title: 'Tab Audio Translator',
    uiLanguageLabel: 'UI language',
    apiKeyLabel: 'OpenAI API key',
    apiKeyPlaceholder: 'sk-...',
    apiKeyHint: 'Key is stored in chrome.storage.sync. For Chrome Web Store publishing, use a backend with ephemeral tokens.',
    sourceLangLabel: 'Source language',
    sourceLangAuto: 'Auto',
    targetLangLabel: 'Target language',
    modelLabel: 'Model',
    modelMini: 'gpt-realtime-mini (faster)',
    modelFull: 'gpt-realtime (better quality)',
    voiceLabel: 'Voice',
    vadModeLabel: 'VAD / segmentation',
    vadModeServer: 'server_vad (fast, reacts to pauses)',
    vadModeSemantic: 'semantic_vad (smarter, sometimes slower)',
    vadHint: 'If translation stalls on music/noisy video, try semantic_vad or increase threshold.',
    originalVolumeLabel: 'Original volume',
    translatedVolumeLabel: 'Translation volume',
    translationSpeedLabel: 'Translation speech speed',
    translationSpeedHint: 'This is post-processing of translated audio. Slightly increase it (for example, 1.05–1.15) to better keep up with the speaker.',
    saveBtn: 'Save',
    startBtn: 'Start',
    stopBtn: 'Stop',
    exportLogsBtn: 'Download log',
    statusSaved: 'Saved',
    statusStarting: 'Starting…',
    statusStopped: 'Stopped',
    statusStartFailed: 'Start failed: {reason}',
    statusLogExported: 'Log exported ({count} entries)',
    statusLogExportFailed: 'Failed to export log: {error}',
    statusUnknown: 'unknown'
  },
  ru: {
    title: 'Перевод звука вкладки',
    uiLanguageLabel: 'Язык интерфейса',
    apiKeyLabel: 'OpenAI API key',
    apiKeyPlaceholder: 'sk-...',
    apiKeyHint: 'Ключ хранится в chrome.storage.sync. Для публикации в Chrome Web Store рекомендуется бэкенд с ephemeral token.',
    sourceLangLabel: 'Язык исходный',
    sourceLangAuto: 'Авто',
    targetLangLabel: 'Язык перевода',
    modelLabel: 'Модель',
    modelMini: 'gpt-realtime-mini (быстрее)',
    modelFull: 'gpt-realtime (лучше качество)',
    voiceLabel: 'Голос',
    vadModeLabel: 'VAD / сегментация',
    vadModeServer: 'server_vad (быстро, реагирует на паузы)',
    vadModeSemantic: 'semantic_vad (умнее, но иногда медленнее)',
    vadHint: 'Если перевод замирает на видео с музыкой/шумом — попробуйте semantic_vad или увеличьте threshold.',
    originalVolumeLabel: 'Громкость оригинала',
    translatedVolumeLabel: 'Громкость перевода',
    translationSpeedLabel: 'Скорость озвучки перевода',
    translationSpeedHint: 'Это пост-обработка аудио. Можно чуть ускорить (например 1.05–1.15), чтобы «догонять» спикера.',
    saveBtn: 'Сохранить',
    startBtn: 'Старт',
    stopBtn: 'Стоп',
    exportLogsBtn: 'Скачать лог',
    statusSaved: 'Сохранено',
    statusStarting: 'Запуск…',
    statusStopped: 'Остановлено',
    statusStartFailed: 'Старт не удался: {reason}',
    statusLogExported: 'Лог выгружен ({count} записей)',
    statusLogExportFailed: 'Не удалось выгрузить лог: {error}',
    statusUnknown: 'неизвестно'
  }
};

function getUiLang(lang) {
  return lang === 'ru' ? 'ru' : 'en';
}

function t(key, vars = {}) {
  const dict = I18N[currentUiLang] || I18N.en;
  const fallback = I18N.en[key] || key;
  let text = dict[key] || fallback;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

function applyI18n(lang) {
  currentUiLang = getUiLang(lang);
  document.documentElement.lang = currentUiLang;

  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n;
    node.textContent = t(key);
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    const key = node.dataset.i18nPlaceholder;
    node.placeholder = t(key);
  });

  updateToggleBtn();
}

function setStatus(text) {
  els.status.textContent = text || '—';
}

function populate(settings) {
  els.uiLang.value = getUiLang(settings.uiLang || 'en');
  els.apiKey.value = settings.openaiApiKey || '';
  els.sourceLang.value = settings.sourceLang || 'auto';
  els.targetLang.value = settings.targetLang || 'ru';
  els.model.value = settings.model || 'gpt-realtime-mini';
  els.voice.value = settings.voice || 'marin';
  els.vadMode.value = settings.vadMode || 'server_vad';
  els.vadThreshold.value = settings.vadThreshold ?? 0.55;
  els.vadSilenceMs.value = settings.vadSilenceMs ?? 650;
  els.originalVolume.value = settings.originalVolume ?? 0.0;
  els.translatedVolume.value = settings.translatedVolume ?? 1.0;
  els.translationSpeed.value = settings.translationSpeed ?? 1.05;
}

function collectPatch() {
  return {
    uiLang: getUiLang(els.uiLang.value),
    openaiApiKey: els.apiKey.value.trim(),
    sourceLang: els.sourceLang.value,
    targetLang: els.targetLang.value,
    model: els.model.value,
    voice: els.voice.value,
    vadMode: els.vadMode.value,
    vadThreshold: Number(els.vadThreshold.value),
    vadSilenceMs: Number(els.vadSilenceMs.value),
    originalVolume: Number(els.originalVolume.value),
    translatedVolume: Number(els.translatedVolume.value),
    translationSpeed: Number(els.translationSpeed.value)
  };
}

function updateToggleBtn() {
  els.toggleBtn.textContent = running ? t('stopBtn') : t('startBtn');
}

async function init() {
  const res = await chrome.runtime.sendMessage({ type: 'POPUP_GET_STATE' });
  if (res?.ok) {
    populate(res.settings);
    applyI18n(res.settings?.uiLang || 'en');
    running = !!res.running;
    updateToggleBtn();
  } else {
    applyI18n('en');
  }
}

els.uiLang.addEventListener('change', () => {
  applyI18n(els.uiLang.value);
});

els.saveBtn.addEventListener('click', async () => {
  const patch = collectPatch();
  const res = await chrome.runtime.sendMessage({ type: 'POPUP_SAVE_SETTINGS', patch });
  if (res?.ok) {
    setStatus(t('statusSaved'));
  }
});

els.toggleBtn.addEventListener('click', async () => {
  if (!running) {
    // save current settings first
    await chrome.runtime.sendMessage({ type: 'POPUP_SAVE_SETTINGS', patch: collectPatch() });
    const res = await chrome.runtime.sendMessage({ type: 'POPUP_START' });
    if (res?.ok) {
      running = true;
      updateToggleBtn();
      setStatus(t('statusStarting'));
    } else {
      running = false;
      updateToggleBtn();
      setStatus(t('statusStartFailed', { reason: res?.reason || res?.error || t('statusUnknown') }));
    }
  } else {
    await chrome.runtime.sendMessage({ type: 'POPUP_STOP' });
    running = false;
    updateToggleBtn();
    setStatus(t('statusStopped'));
  }
});

els.exportLogsBtn.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'POPUP_EXPORT_LOGS' });
  if (res?.ok) {
    setStatus(t('statusLogExported', { count: res.count || 0 }));
  } else {
    setStatus(t('statusLogExportFailed', { error: res?.error || t('statusUnknown') }));
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'STATUS') {
    setStatus(msg.message || msg.state);
  }
});

init();
