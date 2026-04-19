// popup.js

// Recording state machine: 'idle' | 'recording' | 'paused'
let recordingState = 'idle';
let steps = [];

const recordBtn     = document.getElementById('recordBtn');
const captureBtn    = document.getElementById('captureBtn');
const endSessionBtn = document.getElementById('endSessionBtn');
const stepsList     = document.getElementById('stepsList');
const emptyState    = document.getElementById('emptyState');
const stepCount     = document.getElementById('stepCount');
const footer        = document.getElementById('footer');
const postSession   = document.getElementById('postSession');
const warningModal  = document.getElementById('warningModal');
const noApiKeyWarning = document.getElementById('noApiKeyWarning');

// ─── Init ─────────────────────────────────────────────────────────────────

async function ensureContentScript() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return false;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    return true;
  } catch (err) {
    console.warn('Trailmark: could not inject content script:', err.message);
    return false;
  }
}

async function init() {
  const { llmConfig, steps: s, recordingState: rs } =
    await chrome.storage.local.get(['llmConfig', 'steps', 'recordingState']);

  if (!llmConfig?.apiKey) {
    noApiKeyWarning.style.display = 'flex';
  }
  recordBtn.disabled = false;

  steps = s || [];
  recordingState = rs || 'idle';

  renderSteps();
  updateUI();
}

// ─── Record button ────────────────────────────────────────────────────────

recordBtn.addEventListener('click', async () => {
  if (recordingState === 'idle') {
    const injected = await ensureContentScript();
    if (!injected) {
      alert("Can't record on this page (chrome:// pages, the Web Store, and PDFs are blocked by Chrome). Open a normal website and try again.");
      return;
    }
    recordingState = 'recording';
  } else if (recordingState === 'recording') {
    recordingState = 'paused';
  } else if (recordingState === 'paused') {
    recordingState = 'recording';
  }
  await chrome.storage.local.set({ recordingState });
  updateUI();
});

// ─── Manual capture button ────────────────────────────────────────────────

captureBtn.addEventListener('click', async () => {
  captureBtn.disabled = true;
  captureBtn.textContent = 'Capturing...';
  try {
    await chrome.runtime.sendMessage({ type: 'MANUAL_CAPTURE' });
  } catch (err) {
    console.error('Manual capture failed:', err);
  } finally {
    captureBtn.disabled = false;
    captureBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> Capture`;
  }
});

// ─── End Session ──────────────────────────────────────────────────────────

endSessionBtn.addEventListener('click', async () => {
  recordingState = 'idle';
  await chrome.storage.local.set({ recordingState: 'idle' });
  showPostSession();
});

// ─── Post-Session view ───────────────────────────────────────────────────

document.getElementById('postExportBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
});

document.getElementById('postNewSessionBtn').addEventListener('click', () => {
  warningModal.style.display = 'flex';
});

document.getElementById('postBackBtn').addEventListener('click', () => {
  hidePostSession();
});

// ─── Warning modal ──────────────────────────────────────────────────────

document.getElementById('warningCancelBtn').addEventListener('click', () => {
  warningModal.style.display = 'none';
});

document.getElementById('warningConfirmBtn').addEventListener('click', async () => {
  warningModal.style.display = 'none';
  steps = [];
  recordingState = 'idle';
  await chrome.storage.local.set({ steps: [], recordingState: 'idle', editorTitle: '' });
  hidePostSession();
  renderSteps();
  updateUI();
  // Open the editor in "new" mode so the user gets a blank drop-zone canvas.
  chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html?mode=new') });
});

// ─── Step event from background ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STEP_ADDED') {
    steps.push(message.step);
    renderSteps();
  }
});

// ─── Edit & Export (footer) ─────────────────────────────────────────────

document.getElementById('exportBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
});

// ─── Settings ───────────────────────────────────────────────────────────

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById('openOptionsLink')?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ─── UI helpers ─────────────────────────────────────────────────────────

function updateUI() {
  updateRecordBtn();

  // Capture btn: visible when recording or paused
  captureBtn.style.display = (recordingState === 'recording' || recordingState === 'paused') ? 'flex' : 'none';

  // End Session btn: visible when recording or paused (regardless of step count)
  endSessionBtn.style.display = (recordingState === 'recording' || recordingState === 'paused') ? 'inline-flex' : 'none';
}

function updateRecordBtn() {
  const label = recordBtn.querySelector('.btn-label');
  recordBtn.classList.remove('recording', 'paused');

  if (recordingState === 'recording') {
    recordBtn.classList.add('recording');
    label.textContent = 'Pause';
  } else if (recordingState === 'paused') {
    recordBtn.classList.add('paused');
    label.textContent = 'Resume';
  } else {
    label.textContent = steps.length > 0 ? 'Resume Recording' : 'Start Recording';
  }
}

function showPostSession() {
  footer.style.display = 'none';
  postSession.style.display = 'flex';
  captureBtn.style.display = 'none';
  endSessionBtn.style.display = 'none';
  updateRecordBtn();
}

function hidePostSession() {
  postSession.style.display = 'none';
  renderSteps(); // re-shows footer if steps exist
  updateUI();
}

function renderSteps() {
  stepCount.textContent = `${steps.length} step${steps.length !== 1 ? 's' : ''}`;

  if (steps.length === 0) {
    emptyState.style.display = 'flex';
    stepsList.innerHTML = '';
    footer.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  // Only show footer if post-session view isn't active
  if (postSession.style.display === 'none' || postSession.style.display === '') {
    footer.style.display = 'flex';
  }

  stepsList.innerHTML = steps.map((step, i) => `
    <div class="step-item" data-id="${step.id}">
      <div class="step-number">${i + 1}</div>
      <div class="step-content">
        <div class="step-description">${escapeHtml(step.description)}</div>
        <img class="step-thumbnail" src="${step.screenshot}" alt="Step ${i + 1}"
             title="Click to view full size"
             data-full="${step.screenshot}"/>
      </div>
    </div>
  `).join('');

  stepsList.querySelectorAll('.step-thumbnail').forEach(img => {
    img.addEventListener('click', () => {
      window.open(img.dataset.full, '_blank');
    });
  });

  stepsList.scrollTop = stepsList.scrollHeight;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

init();
