const els = {
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

function setStatus(text) {
  els.status.textContent = text || '—';
}

function populate(settings) {
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
  els.toggleBtn.textContent = running ? 'Стоп' : 'Старт';
}

async function init() {
  const res = await chrome.runtime.sendMessage({ type: 'POPUP_GET_STATE' });
  if (res?.ok) {
    populate(res.settings);
    running = !!res.running;
    updateToggleBtn();
  }
}

els.saveBtn.addEventListener('click', async () => {
  const patch = collectPatch();
  const res = await chrome.runtime.sendMessage({ type: 'POPUP_SAVE_SETTINGS', patch });
  if (res?.ok) {
    setStatus('Сохранено');
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
      setStatus('Запуск…');
    } else {
      running = false;
      updateToggleBtn();
      setStatus(`Старт не удался: ${res?.reason || res?.error || 'unknown'}`);
    }
  } else {
    await chrome.runtime.sendMessage({ type: 'POPUP_STOP' });
    running = false;
    updateToggleBtn();
    setStatus('Остановлено');
  }
});

els.exportLogsBtn.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'POPUP_EXPORT_LOGS' });
  if (res?.ok) {
    setStatus(`Лог выгружен (${res.count || 0} записей)`);
  } else {
    setStatus(`Не удалось выгрузить лог: ${res?.error || 'unknown'}`);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'STATUS') {
    setStatus(msg.message || msg.state);
  }
});

init();
