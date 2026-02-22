(() => {
  if (window.__VOT_OVERLAY_INSTALLED__) return;
  window.__VOT_OVERLAY_INSTALLED__ = true;

  const overlay = document.createElement('div');
  overlay.id = 'vot-overlay';

  overlay.innerHTML = `
    <div class="top">
      <div class="badge">VOT</div>
      <div class="status" id="vot-status">—</div>
    </div>
    <div class="line source" id="vot-source"></div>
    <div class="line" id="vot-target"></div>
  `;

  document.documentElement.appendChild(overlay);

  const elStatus = overlay.querySelector('#vot-status');
  const elSource = overlay.querySelector('#vot-source');
  const elTarget = overlay.querySelector('#vot-target');

  function setStatus(text) {
    elStatus.textContent = text || '—';
  }

  function setText(source, target) {
    elSource.textContent = source || '';
    elTarget.textContent = target || '';
  }

  // simple hide/show on click
  overlay.addEventListener('click', () => {
    overlay.classList.toggle('hidden');
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg?.type) return;

    if (msg.type === 'STATUS') {
      setStatus(msg.message || msg.state);
      return;
    }

    if (msg.type === 'CAPTION_UPDATE') {
      setStatus(msg.statusText || 'Working');
      setText(msg.sourceText, msg.targetText);
      return;
    }

    if (msg.type === 'VOT_STOP') {
      overlay.remove();
      window.__VOT_OVERLAY_INSTALLED__ = false;
      return;
    }
  });

  setStatus('Ready');
})();
