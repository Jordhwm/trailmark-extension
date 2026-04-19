// content.js
// Guarded against double-execution: the popup calls chrome.scripting.executeScript
// on Start to cover tabs that were open before the extension was (re)loaded, and
// the manifest also auto-injects this file. Running the setup twice would stack
// click listeners and duplicate steps — the guard below prevents that.

(() => {
  if (window.__trailmarkContentLoaded) {
    // Already running; just make sure the indicator matches current storage state.
    if (typeof window.__trailmarkRenderIndicator === 'function') {
      chrome.storage.local.get(['recordingState']).then(({ recordingState }) => {
        window.__trailmarkRecordingState = recordingState || 'idle';
        window.__trailmarkRenderIndicator();
      });
    }
    return;
  }
  window.__trailmarkContentLoaded = true;

  // Recording state: 'idle' | 'recording' | 'paused'
  let recordingState = 'idle';
  window.__trailmarkRecordingState = recordingState;

  // Sensitivity (debounce between captures, in ms). Default 300ms.
  let captureSensitivity = 300;
  let lastCaptureTime = 0;

  // Restore state on load
  chrome.storage.local.get(['recordingState', 'captureSensitivity']).then(({ recordingState: stored, captureSensitivity: sens }) => {
    recordingState = stored || 'idle';
    window.__trailmarkRecordingState = recordingState;
    if (typeof sens === 'number') captureSensitivity = sens;
    renderIndicator();
  });

  // React to storage changes (popup toggling start/pause/resume/stop, sensitivity updates)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.recordingState) {
      recordingState = changes.recordingState.newValue || 'idle';
      window.__trailmarkRecordingState = recordingState;
      renderIndicator();
    }
    if (changes.captureSensitivity && typeof changes.captureSensitivity.newValue === 'number') {
      captureSensitivity = changes.captureSensitivity.newValue;
    }
  });

  // Click handler — only capture when actively recording
  document.addEventListener('click', async (e) => {
    if (recordingState !== 'recording') return;

    // Debounce: skip if too soon after the last capture
    const now = Date.now();
    if (now - lastCaptureTime < captureSensitivity) return;
    lastCaptureTime = now;

    const el = e.target;
    const elementContext = {
      tag: el.tagName.toLowerCase(),
      text: el.innerText?.trim().slice(0, 100) || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      placeholder: el.getAttribute('placeholder') || '',
      type: el.getAttribute('type') || '',
      href: el.href || '',
      role: el.getAttribute('role') || '',
      id: el.id || '',
      className: el.className?.toString().slice(0, 100) || '',
      pageTitle: document.title,
      pageUrl: window.location.href
    };

    // Hide the pill so it doesn't appear in the screenshot.
    hideRecordingIndicator();
    await new Promise(r => setTimeout(r, 300));

    try {
      await chrome.runtime.sendMessage({ type: 'CAPTURE_STEP', elementContext });
    } catch (_) {
      // ignore — indicator still needs to come back
    } finally {
      renderIndicator();
    }
  }, true);

  // ─── Indicator ──────────────────────────────────────────────────────────────

  function renderIndicator() {
    hideRecordingIndicator();
    if (recordingState === 'recording') showIndicator('recording');
    else if (recordingState === 'paused') showIndicator('paused');
  }
  window.__trailmarkRenderIndicator = renderIndicator;

  function showIndicator(mode) {
    if (!document.body) return; // defensive — extremely early injection
    const isPaused = mode === 'paused';
    const bg = isPaused ? '#f59e0b' : '#ef4444';
    const label = isPaused ? 'Paused' : 'Recording';

    const indicator = document.createElement('div');
    indicator.id = 'trailmark-recording-indicator';
    indicator.style.cssText = `
      position: fixed;
      top: 12px;
      right: 12px;
      background: ${bg};
      color: white;
      padding: 6px 12px;
      border-radius: 20px;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      font-weight: 600;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 6px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.2);
      pointer-events: none;
    `;
    const dotAnim = isPaused ? '' : 'animation:trailmark-pulse 1s infinite';
    indicator.innerHTML = `<span style="width:8px;height:8px;background:white;border-radius:50%;${dotAnim}"></span> ${label}`;

    if (!document.getElementById('trailmark-indicator-style')) {
      const style = document.createElement('style');
      style.id = 'trailmark-indicator-style';
      style.textContent = `@keyframes trailmark-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`;
      (document.head || document.documentElement).appendChild(style);
    }
    document.body.appendChild(indicator);
  }

  function hideRecordingIndicator() {
    document.getElementById('trailmark-recording-indicator')?.remove();
  }
})();
