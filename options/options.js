// options.js

// Provider metadata — fallback model list shown before a live fetch.
// Live lists are retrieved via FETCH_MODELS from background.js so users
// always see models their key actually has access to.
const PROVIDER_META = [
  {
    id: 'claude',
    name: 'Claude',
    tagline: 'Anthropic',
    models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-sonnet-4-6',
    keyPlaceholder: 'sk-ant-...',
    docsUrl: 'https://console.anthropic.com/settings/keys'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    tagline: 'GPT',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
    defaultModel: 'gpt-4o',
    keyPlaceholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'gemini',
    name: 'Gemini',
    tagline: 'Google',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    defaultModel: 'gemini-2.5-flash',
    keyPlaceholder: 'AIza...',
    docsUrl: 'https://aistudio.google.com/app/apikey'
  },
  {
    id: 'custom',
    name: 'Custom',
    tagline: 'OpenAI-compatible',
    models: [],
    defaultModel: '',
    keyPlaceholder: 'your-api-key',
    docsUrl: ''
  }
];

const MODELS_CACHE_KEY = 'llmModelsCache';
const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const KEYS_BY_PROVIDER = 'llmKeysByProvider';

// In-memory per-provider key/model cache so switching providers shows the right
// credentials without a round-trip to storage on every click.
const providerState = {}; // { [id]: { apiKey, model, customUrl } }

let selectedProviderId = 'claude';

// DOM refs
const grid = document.getElementById('providersGrid');
const modelSelect = document.getElementById('modelSelect');
const customModelField = document.getElementById('customModelField');
const customModelInput = document.getElementById('customModelInput');
const customUrlField = document.getElementById('customUrlField');
const customUrlInput = document.getElementById('customUrlInput');
const apiKeyInput = document.getElementById('apiKeyInput');
const docsLink = document.getElementById('docsLink');
const saveBtn = document.getElementById('saveBtn');
const testBtn = document.getElementById('testBtn');
const statusMsg = document.getElementById('statusMsg');
const currentConfig = document.getElementById('currentConfig');
const currentConfigText = document.getElementById('currentConfigText');
const toggleKeyBtn = document.getElementById('toggleKeyBtn');
const refreshModelsBtn = document.getElementById('refreshModelsBtn');
const modelsHint = document.getElementById('modelsHint');
const customUrlHint = document.getElementById('customUrlHint');
const removeKeyBtn = document.getElementById('removeKeyBtn');

// ─── Render Provider Cards ────────────────────────────────────────────────────

function renderProviders() {
  grid.innerHTML = PROVIDER_META.map(p => `
    <div class="provider-card ${p.id === selectedProviderId ? 'selected' : ''}"
         data-id="${p.id}">
      <div class="provider-name">${p.name}</div>
      <div class="provider-tag">${p.tagline}</div>
    </div>
  `).join('');

  // CSP-safe click handlers (no inline onclick)
  grid.querySelectorAll('.provider-card').forEach(card => {
    card.addEventListener('click', () => selectProvider(card.dataset.id));
  });
}

function selectProvider(id) {
  // Snapshot the current provider's inputs before switching.
  snapshotCurrentProviderState();
  selectedProviderId = id;
  renderProviders();
  updateProviderFields();
  // Restore the new provider's inputs (or blank if none saved yet).
  restoreProviderState(id);
}

function snapshotCurrentProviderState() {
  if (!selectedProviderId) return;
  const s = providerState[selectedProviderId] || {};
  s.apiKey = apiKeyInput.value;
  s.model = selectedProviderId === 'custom' ? customModelInput.value : modelSelect.value;
  s.customUrl = customUrlInput.value;
  providerState[selectedProviderId] = s;
}

function restoreProviderState(id) {
  const s = providerState[id] || {};
  apiKeyInput.value = s.apiKey || '';
  if (id === 'custom') {
    customModelInput.value = s.model || '';
    customUrlInput.value = s.customUrl || '';
  } else if (s.model) {
    modelSelect.value = s.model;
  }
  // Reset any stale inline status/hints from the previous provider.
  setHint(modelsHint, '', modelSelect.value ? '' : 'Click "Refresh models" after entering your API key to see what you can access.');
  setHint(customUrlHint, '', 'Your API key will be sent to this URL — only use endpoints you trust. https:// required; localhost and private IPs are blocked.');
  statusMsg.className = 'status';
  updateRemoveBtnState();
}

async function updateProviderFields() {
  const provider = PROVIDER_META.find(p => p.id === selectedProviderId);
  if (!provider) return;

  // Docs link
  docsLink.href = provider.docsUrl || '#';
  docsLink.style.display = provider.docsUrl ? '' : 'none';

  // API key placeholder
  apiKeyInput.placeholder = provider.keyPlaceholder;

  // Model dropdown vs custom model input
  if (selectedProviderId === 'custom') {
    modelSelect.style.display = 'none';
    customModelField.style.display = 'block';
    customUrlField.style.display = 'block';
    refreshModelsBtn.style.display = 'none';
    modelsHint.textContent = '';
    modelsHint.className = 'field-hint';
  } else {
    modelSelect.style.display = 'block';
    customModelField.style.display = 'none';
    customUrlField.style.display = 'none';
    refreshModelsBtn.style.display = '';

    // Prefer a cached live list; fall back to the curated defaults.
    const cached = await getCachedModels(selectedProviderId);
    const list = (cached && cached.length) ? cached : provider.models;
    renderModelDatalist(list);
    modelSelect.value = provider.defaultModel;
    if (cached && cached.length) {
      setHint(modelsHint, 'success', `Showing ${cached.length} models from your API key.`);
    } else {
      setHint(modelsHint, '', 'Click "Refresh models" after entering your API key to see what you can access.');
    }
  }
}

function renderModelDatalist(models) {
  const datalist = document.getElementById('modelSuggestions');
  // Build with DOM APIs (not innerHTML) so there's no escaping concern.
  datalist.textContent = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    datalist.appendChild(opt);
  }
}

async function getCachedModels(providerId) {
  const { [MODELS_CACHE_KEY]: cache = {} } = await chrome.storage.local.get([MODELS_CACHE_KEY]);
  const entry = cache[providerId];
  if (!entry) return null;
  if (Date.now() - entry.ts > MODELS_CACHE_TTL_MS) return null;
  return entry.models;
}

async function setCachedModels(providerId, models) {
  const { [MODELS_CACHE_KEY]: cache = {} } = await chrome.storage.local.get([MODELS_CACHE_KEY]);
  cache[providerId] = { ts: Date.now(), models };
  await chrome.storage.local.set({ [MODELS_CACHE_KEY]: cache });
}

function setHint(el, kind, text) {
  if (!el) return;
  el.className = 'field-hint' + (kind ? ` ${kind}` : '');
  el.textContent = text || '';
}

// ─── Refresh models ──────────────────────────────────────────────────────────

refreshModelsBtn.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setHint(modelsHint, 'error', 'Enter your API key first, then click Refresh.');
    return;
  }
  refreshModelsBtn.disabled = true;
  setHint(modelsHint, '', 'Fetching models…');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'FETCH_MODELS',
      providerId: selectedProviderId,
      apiKey
    });
    if (result?.success && Array.isArray(result.models) && result.models.length) {
      await setCachedModels(selectedProviderId, result.models);
      renderModelDatalist(result.models);
      // Keep current value if it's still valid, otherwise pick a sensible default.
      if (!result.models.includes(modelSelect.value)) {
        modelSelect.value = result.models[0];
      }
      setHint(modelsHint, 'success', `Loaded ${result.models.length} models.`);
    } else {
      setHint(modelsHint, 'error', result?.error || 'No models returned.');
    }
  } catch (err) {
    setHint(modelsHint, 'error', 'Could not reach the provider.');
  } finally {
    refreshModelsBtn.disabled = false;
  }
});

// ─── Custom URL live validation ──────────────────────────────────────────────

function validateCustomUrlClientSide(raw) {
  if (!raw) return { ok: false, reason: 'URL is required' };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'Not a valid URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'URL must use https://' };
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    return { ok: false, reason: 'Localhost endpoints are not allowed' };
  }
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    if (a === 127 || a === 10 || a === 0) return { ok: false, reason: 'Private/loopback IPs are not allowed' };
    if (a === 192 && b === 168) return { ok: false, reason: 'Private IP ranges are not allowed' };
    if (a === 172 && b >= 16 && b <= 31) return { ok: false, reason: 'Private IP ranges are not allowed' };
    if (a === 169 && b === 254) return { ok: false, reason: 'Link-local addresses are not allowed' };
  }
  if (host === '::1' || host.startsWith('fe80:')) return { ok: false, reason: 'Private/loopback IPs are not allowed' };
  return { ok: true };
}

if (customUrlInput) {
  customUrlInput.addEventListener('input', () => {
    const v = customUrlInput.value.trim();
    if (!v) {
      setHint(customUrlHint, '', 'Your API key will be sent to this URL — only use endpoints you trust. https:// required; localhost and private IPs are blocked.');
      return;
    }
    const res = validateCustomUrlClientSide(v);
    if (res.ok) setHint(customUrlHint, 'warning', 'Your API key will be sent to this URL — only use endpoints you trust.');
    else setHint(customUrlHint, 'error', res.reason);
  });
}

// ─── Remove API key ──────────────────────────────────────────────────────────

function updateRemoveBtnState() {
  if (!removeKeyBtn) return;
  // Enabled when there's anything to remove: either a typed key or a saved one.
  const hasTyped = !!apiKeyInput.value.trim();
  const hasSaved = !!(providerState[selectedProviderId]?.apiKey);
  removeKeyBtn.disabled = !hasTyped && !hasSaved;
}

apiKeyInput.addEventListener('input', updateRemoveBtnState);

removeKeyBtn?.addEventListener('click', async () => {
  const provider = PROVIDER_META.find(p => p.id === selectedProviderId);
  const name = provider?.name || 'this provider';
  if (!confirm(`Remove the saved API key for ${name}? You'll need to re-enter it to use AI features.`)) return;

  // Clear inputs and in-memory cache for this provider.
  apiKeyInput.value = '';
  if (selectedProviderId === 'custom') {
    customModelInput.value = '';
    customUrlInput.value = '';
  }
  providerState[selectedProviderId] = { apiKey: '', model: '', customUrl: '' };

  // Update storage: drop this provider from the per-provider cache, and if this
  // provider was the active one, drop llmConfig entirely so AI features disable.
  const { llmConfig, [KEYS_BY_PROVIDER]: keysByProvider = {} } =
    await chrome.storage.local.get(['llmConfig', KEYS_BY_PROVIDER]);
  delete keysByProvider[selectedProviderId];

  const updates = { [KEYS_BY_PROVIDER]: keysByProvider };
  if (llmConfig?.providerId === selectedProviderId) {
    await chrome.storage.local.remove('llmConfig');
  }
  await chrome.storage.local.set(updates);

  // Hide "Active: …" banner if it referred to this provider.
  if (llmConfig?.providerId === selectedProviderId) {
    currentConfig.style.display = 'none';
  }

  showStatus('success', `${name} API key removed.`);
  updateRemoveBtnState();
});

// ─── Toggle key visibility ────────────────────────────────────────────────────

toggleKeyBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  document.getElementById('eyeIcon').innerHTML = isPassword
    ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
});

// ─── Save ─────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) return showStatus('error', 'Please enter an API key.');

  const provider = PROVIDER_META.find(p => p.id === selectedProviderId);
  const model = selectedProviderId === 'custom'
    ? customModelInput.value.trim()
    : modelSelect.value;

  if (!model) return showStatus('error', 'Please enter a model name.');

  const customUrl = customUrlInput.value.trim() || undefined;
  if (selectedProviderId === 'custom') {
    const urlCheck = validateCustomUrlClientSide(customUrl || '');
    if (!urlCheck.ok) return showStatus('error', `Custom URL rejected: ${urlCheck.reason}`);
  }

  const llmConfig = {
    providerId: selectedProviderId,
    model,
    apiKey,
    customUrl
  };

  // Persist the active config and keep a per-provider cache so switching
  // providers in the UI restores the right key automatically.
  providerState[selectedProviderId] = { apiKey, model, customUrl };
  const { [KEYS_BY_PROVIDER]: existing = {} } = await chrome.storage.local.get([KEYS_BY_PROVIDER]);
  existing[selectedProviderId] = { apiKey, model, customUrl };
  await chrome.storage.local.set({ llmConfig, [KEYS_BY_PROVIDER]: existing });
  showStatus('success', 'Configuration saved!');
  showCurrentConfig(provider, model);
});

// ─── Test Connection ──────────────────────────────────────────────────────────

testBtn.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) return showStatus('error', 'Enter an API key first.');

  showStatus('testing', 'Testing connection...', true);
  testBtn.disabled = true;

  try {
    const provider = PROVIDER_META.find(p => p.id === selectedProviderId);
    const model = selectedProviderId === 'custom'
      ? customModelInput.value.trim()
      : modelSelect.value;

    const result = await chrome.runtime.sendMessage({
      type: 'TEST_CONNECTION',
      config: {
        providerId: selectedProviderId,
        model,
        apiKey,
        customUrl: customUrlInput.value.trim() || undefined
      }
    });

    if (result?.success) {
      showStatus('success', `✓ Connected to ${provider.name} (${model})`);
    } else {
      showStatus('error', `Connection failed: ${result?.error || 'Unknown error'}`);
    }
  } catch (err) {
    showStatus('error', `Error: ${err.message}`);
  } finally {
    testBtn.disabled = false;
  }
});

// ─── Load saved config ────────────────────────────────────────────────────────

async function loadSaved() {
  const { llmConfig, [KEYS_BY_PROVIDER]: keysByProvider = {} } =
    await chrome.storage.local.get(['llmConfig', KEYS_BY_PROVIDER]);

  // Hydrate in-memory cache from storage.
  for (const [id, entry] of Object.entries(keysByProvider)) {
    providerState[id] = { ...entry };
  }

  if (llmConfig) {
    selectedProviderId = llmConfig.providerId || 'claude';
    // If saved provider no longer exists (e.g. Mistral was removed), fall back
    if (!PROVIDER_META.find(p => p.id === selectedProviderId)) {
      selectedProviderId = 'claude';
    }
    // Make sure the active provider's cache reflects the latest llmConfig.
    providerState[selectedProviderId] = {
      apiKey: llmConfig.apiKey || '',
      model: llmConfig.model || '',
      customUrl: llmConfig.customUrl || ''
    };
    renderProviders();
    await updateProviderFields();
    restoreProviderState(selectedProviderId);

    const provider = PROVIDER_META.find(p => p.id === selectedProviderId);
    showCurrentConfig(provider, llmConfig.model);
  } else {
    renderProviders();
    await updateProviderFields();
  }
  updateRemoveBtnState();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function showStatus(type, text, withSpinner = false) {
  statusMsg.className = `status ${type}`;
  statusMsg.textContent = '';
  if (withSpinner) {
    const s = document.createElement('span');
    s.className = 'spinner';
    statusMsg.appendChild(s);
    statusMsg.appendChild(document.createTextNode(' '));
  }
  statusMsg.appendChild(document.createTextNode(text));
  if (type === 'success') {
    setTimeout(() => { statusMsg.className = 'status'; }, 3000);
  }
}

function showCurrentConfig(provider, model) {
  if (!provider || !model) return;
  currentConfig.style.display = 'flex';
  currentConfigText.textContent = `Active: ${provider.name} · ${model}`;
}

// ─── Sensitivity slider ──────────────────────────────────────────────────────

const sensitivitySlider = document.getElementById('sensitivitySlider');
const sensitivityValue = document.getElementById('sensitivityValue');

if (sensitivitySlider && sensitivityValue) {
  sensitivitySlider.addEventListener('input', () => {
    sensitivityValue.textContent = `${sensitivitySlider.value}ms`;
  });

  sensitivitySlider.addEventListener('change', async () => {
    const val = parseInt(sensitivitySlider.value, 10);
    await chrome.storage.local.set({ captureSensitivity: val });
  });

  // Load saved value
  chrome.storage.local.get(['captureSensitivity']).then(({ captureSensitivity }) => {
    const val = captureSensitivity ?? 300;
    sensitivitySlider.value = val;
    sensitivityValue.textContent = `${val}ms`;
  });
}

loadSaved();
