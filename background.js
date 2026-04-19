// background.js
// ─── Trailmark service worker ───────────────────────────────────────────────
// Responsibilities:
//   • LLM provider adapters (Claude, OpenAI, Gemini, Custom)
//   • Screenshot capture → LLM description → step storage
//   • Manual capture (no click target)
//   • Image compression to stay within provider payload limits
//   • Extension badge management (recording / paused / idle)
//   • Auto-set editorTitle from the first step's page title

// ─── LLM Provider Definitions ────────────────────────────────────────────────

const PROVIDERS = {
  claude: {
    name: 'Claude (Anthropic)',
    models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-sonnet-4-6',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    keyPlaceholder: 'sk-ant-...',
    docsUrl: 'https://console.anthropic.com',
    buildRequest(apiKey, model, prompt, base64Image, _customUrl, mimeType) {
      return {
        url: this.apiUrl,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: {
          model,
          max_tokens: 100,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/png', data: base64Image } },
              { type: 'text', text: prompt }
            ]
          }]
        }
      };
    },
    parseResponse(data) {
      return data.content?.[0]?.text?.trim();
    }
  },

  openai: {
    name: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
    defaultModel: 'gpt-4o',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    keyPlaceholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/api-keys',
    buildRequest(apiKey, model, prompt, base64Image, _customUrl, mimeType) {
      return {
        url: this.apiUrl,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: {
          model,
          max_tokens: 100,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType || 'image/png'};base64,${base64Image}` } },
              { type: 'text', text: prompt }
            ]
          }]
        }
      };
    },
    parseResponse(data) {
      return data.choices?.[0]?.message?.content?.trim();
    }
  },

  gemini: {
    name: 'Google Gemini',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    defaultModel: 'gemini-2.5-flash',
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    keyPlaceholder: 'AIza...',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    buildRequest(apiKey, model, prompt, base64Image, _customUrl, mimeType) {
      return {
        url: this.apiUrl.replace('{model}', model),
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: {
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType || 'image/png', data: base64Image } },
              { text: prompt }
            ]
          }],
          generationConfig: { maxOutputTokens: 100 }
        }
      };
    },
    parseResponse(data) {
      return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    }
  },

  custom: {
    name: 'Custom (OpenAI-compatible)',
    models: [],
    defaultModel: '',
    apiUrl: '',
    keyPlaceholder: 'your-api-key',
    docsUrl: '',
    buildRequest(apiKey, model, prompt, base64Image, customUrl, mimeType) {
      return {
        url: customUrl || this.apiUrl,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: {
          model,
          max_tokens: 100,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType || 'image/png'};base64,${base64Image}` } },
              { type: 'text', text: prompt }
            ]
          }]
        }
      };
    },
    parseResponse(data) {
      return data.choices?.[0]?.message?.content?.trim();
    }
  }
};

// ─── Custom provider URL validator ──────────────────────────────────────────
// Rejects non-https, loopback, and private-network endpoints. Defense against
// exfiltration if settings are tampered with, and a sane default for publishing.

function validateCustomUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return { ok: false, reason: 'URL is required' };
  let u;
  try { u = new URL(rawUrl); } catch { return { ok: false, reason: 'Not a valid URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'URL must use https://' };

  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    return { ok: false, reason: 'Localhost endpoints are not allowed' };
  }
  // IPv4 private / loopback / link-local
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    if (a === 127) return { ok: false, reason: 'Loopback addresses are not allowed' };
    if (a === 10) return { ok: false, reason: 'Private IP ranges are not allowed' };
    if (a === 192 && b === 168) return { ok: false, reason: 'Private IP ranges are not allowed' };
    if (a === 172 && b >= 16 && b <= 31) return { ok: false, reason: 'Private IP ranges are not allowed' };
    if (a === 169 && b === 254) return { ok: false, reason: 'Link-local addresses are not allowed' };
    if (a === 0) return { ok: false, reason: 'Invalid address' };
  }
  // IPv6 loopback / link-local
  if (host === '::1' || host === '[::1]') return { ok: false, reason: 'Loopback addresses are not allowed' };
  if (host.startsWith('fe80:') || host.startsWith('[fe80:')) return { ok: false, reason: 'Link-local addresses are not allowed' };

  return { ok: true };
}

// ─── Image Compression ──────────────────────────────────────────────────────
// Resizes + compresses screenshots to stay within LLM provider payload limits.
// Gemini's inline limit is 4MB; aiming for ≤2MB base64 as a universal safe cap.

const MAX_BASE64_SIZE = 2 * 1024 * 1024; // 2MB of base64 chars
const MAX_IMAGE_WIDTH = 1280;

async function compressScreenshot(dataUrl) {
  // dataUrl is "data:image/png;base64,AAAA..."
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');

  // If already small enough, return as-is (keep as PNG)
  if (base64.length <= MAX_BASE64_SIZE) {
    return { base64, mimeType: 'image/png' };
  }

  // Need to resize / re-encode as JPEG.
  // Service workers can't use HTMLCanvasElement, so use OffscreenCanvas.
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  let w = bitmap.width;
  let h = bitmap.height;
  if (w > MAX_IMAGE_WIDTH) {
    const scale = MAX_IMAGE_WIDTH / w;
    w = MAX_IMAGE_WIDTH;
    h = Math.round(h * scale);
  }

  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  // Encode as JPEG at quality 0.7
  const jpegBlob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  const ab = await jpegBlob.arrayBuffer();
  const bytes = new Uint8Array(ab);

  // Manual base64 encoding in service worker
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);

  return { base64: b64, mimeType: 'image/jpeg' };
}

// ─── Text-only request builder (for TEST_CONNECTION) ─────────────────────────

function buildTextOnlyRequest(providerId, provider, config, prompt, maxTokens = 20) {
  const apiKey = config.apiKey;
  const model = config.model || provider.defaultModel;

  if (providerId === 'claude') {
    return {
      url: provider.apiUrl,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: {
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
      }
    };
  }

  if (providerId === 'gemini') {
    return {
      url: provider.apiUrl.replace('{model}', model),
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens }
      }
    };
  }

  // openai / custom — OpenAI-compatible chat/completions shape
  return {
    url: providerId === 'custom' ? (config.customUrl || provider.apiUrl) : provider.apiUrl,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    }
  };
}

function parseProviderTextResponse(providerId, data) {
  if (providerId === 'claude') return data?.content?.[0]?.text?.trim() || '';
  if (providerId === 'gemini') return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

// ─── Badge Management ────────────────────────────────────────────────────────

function updateBadge(state) {
  if (state === 'recording') {
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else if (state === 'paused') {
    chrome.action.setBadgeText({ text: '||' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Sync badge on service worker startup
chrome.storage.local.get(['recordingState'], ({ recordingState }) => {
  updateBadge(recordingState || 'idle');
});

// Sync badge whenever recordingState changes (from popup, content, etc.)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.recordingState) {
    updateBadge(changes.recordingState.newValue || 'idle');
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_STEP') {
    handleCaptureStep(message.elementContext, sender.tab, sendResponse);
    return true;
  }
  if (message.type === 'MANUAL_CAPTURE') {
    handleManualCapture(sendResponse);
    return true;
  }
  if (message.type === 'GET_STEPS') {
    chrome.storage.local.get(['steps'], (result) => {
      sendResponse({ steps: result.steps || [] });
    });
    return true;
  }
  if (message.type === 'CLEAR_STEPS') {
    chrome.storage.local.set({ steps: [] }, () => sendResponse({ success: true }));
    return true;
  }
  if (message.type === 'GET_PROVIDERS') {
    const meta = Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      name: p.name,
      models: p.models,
      defaultModel: p.defaultModel,
      keyPlaceholder: p.keyPlaceholder,
      docsUrl: p.docsUrl
    }));
    sendResponse({ providers: meta });
    return true;
  }
  if (message.type === 'TEST_CONNECTION') {
    handleTestConnection(message.config, sendResponse);
    return true;
  }
  if (message.type === 'VALIDATE_CUSTOM_URL') {
    sendResponse(validateCustomUrl(message.url || ''));
    return true;
  }
  if (message.type === 'FETCH_MODELS') {
    handleFetchModels(message.providerId, message.apiKey, sendResponse);
    return true;
  }
  if (message.type === 'CHECK_DESCRIPTION') {
    handleCheckDescription(message.text, sendResponse);
    return true;
  }
});

// ─── Description clarity check ──────────────────────────────────────────────

async function handleCheckDescription(text, sendResponse) {
  try {
    if (typeof text !== 'string' || !text.trim()) {
      sendResponse({ ok: false, reason: 'empty' });
      return;
    }
    if (text.length > 500) {
      sendResponse({ ok: false, reason: 'too-long' });
      return;
    }

    const { llmConfig } = await chrome.storage.local.get(['llmConfig']);
    if (!llmConfig?.apiKey || !llmConfig?.providerId) {
      sendResponse({ ok: false, reason: 'no-key' });
      return;
    }
    const provider = PROVIDERS[llmConfig.providerId];
    if (!provider) { sendResponse({ ok: false, reason: 'no-key' }); return; }

    if (llmConfig.providerId === 'custom') {
      const check = validateCustomUrl(llmConfig.customUrl || '');
      if (!check.ok) { sendResponse({ ok: false, reason: 'bad-custom-url' }); return; }
    }

    const prompt = `You are reviewing ONE step instruction from a how-to walkthrough.

Rules the sentence should follow:
- Start with an action verb (Click, Select, Enter, Navigate to, etc.)
- Be clear and specific
- Under 20 words
- Present tense imperative mood

Description: "${text.replace(/"/g, '\\"')}"

Reply with ONLY a compact JSON object, no prose, no code fences:
{"ok": <true|false>, "reason": "<under 12 words>", "suggestion": "<rewrite or empty string>"}
Set "ok": true if the description already follows the rules. Otherwise "ok": false, and set "suggestion" to a cleaner rewrite.`;

    const req = buildTextOnlyRequest(llmConfig.providerId, provider, llmConfig, prompt, 160);
    const resp = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body)
    });

    if (!resp.ok) {
      let reason = 'network';
      if (resp.status === 401 || resp.status === 403) reason = 'auth';
      else if (resp.status === 429) reason = 'rate-limit';
      console.warn('Trailmark description check failed', { status: resp.status });
      sendResponse({ ok: false, reason });
      return;
    }

    const data = await resp.json().catch(() => null);
    const raw = data ? parseProviderTextResponse(llmConfig.providerId, data) : '';
    if (!raw) { sendResponse({ ok: false, reason: 'parse' }); return; }

    // Tolerate chatter around the JSON.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) { sendResponse({ ok: false, reason: 'parse' }); return; }
    let parsed;
    try { parsed = JSON.parse(match[0]); } catch { sendResponse({ ok: false, reason: 'parse' }); return; }

    const result = {
      ok: parsed.ok === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 160) : '',
      suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion.slice(0, 240) : ''
    };
    sendResponse({ ok: true, result });
  } catch (_err) {
    console.warn('Trailmark description check errored');
    sendResponse({ ok: false, reason: 'network' });
  }
}

// ─── Live model discovery ───────────────────────────────────────────────────

async function handleFetchModels(providerId, apiKey, sendResponse) {
  try {
    if (!apiKey) { sendResponse({ success: false, error: 'API key required' }); return; }

    let url, headers;
    if (providerId === 'claude') {
      url = 'https://api.anthropic.com/v1/models';
      headers = {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      };
    } else if (providerId === 'openai') {
      url = 'https://api.openai.com/v1/models';
      headers = { 'Authorization': `Bearer ${apiKey}` };
    } else if (providerId === 'gemini') {
      url = 'https://generativelanguage.googleapis.com/v1beta/models';
      headers = { 'x-goog-api-key': apiKey };
    } else {
      sendResponse({ success: false, error: 'No discovery endpoint for this provider' });
      return;
    }

    const resp = await fetch(url, { method: 'GET', headers });
    if (!resp.ok) {
      let hint = `HTTP ${resp.status}`;
      if (resp.status === 401 || resp.status === 403) hint = 'Authentication failed — check your API key';
      else if (resp.status === 429) hint = 'Rate limit exceeded';
      sendResponse({ success: false, error: hint });
      return;
    }
    const data = await resp.json();

    let models = [];
    if (providerId === 'claude') {
      models = (data.data || []).map(m => m.id).filter(Boolean);
    } else if (providerId === 'openai') {
      // Only chat models likely to support vision inputs.
      models = (data.data || [])
        .map(m => m.id)
        .filter(id => typeof id === 'string')
        .filter(id => /^(gpt-|o\d|chatgpt-)/.test(id))
        .filter(id => !/-audio|-tts|whisper|embedding|moderation|image|dall-e|search|instruct/i.test(id));
    } else if (providerId === 'gemini') {
      models = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => (m.name || '').replace(/^models\//, ''))
        .filter(id => id && !/embedding|aqa|tts/i.test(id));
    }
    // Dedup + sort
    models = Array.from(new Set(models)).sort();

    sendResponse({ success: true, models });
  } catch (_err) {
    sendResponse({ success: false, error: 'Network error' });
  }
}

async function handleTestConnection(config, sendResponse) {
  try {
    const provider = PROVIDERS[config.providerId];
    if (!provider) {
      sendResponse({ success: false, error: `Unknown provider: ${config.providerId}` });
      return;
    }
    if (!config.apiKey) {
      sendResponse({ success: false, error: 'Missing API key' });
      return;
    }
    if (!config.model) {
      sendResponse({ success: false, error: 'Missing model' });
      return;
    }

    const req = buildTextOnlyRequest(config.providerId, provider, config, 'Reply with exactly: OK');
    const resp = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body)
    });
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      // Only surface auth/rate-limit hints to the UI; avoid echoing raw provider messages.
      let hint = `HTTP ${resp.status}`;
      if (resp.status === 401 || resp.status === 403) hint = 'Authentication failed — check your API key';
      else if (resp.status === 404) hint = 'Model not found for this key';
      else if (resp.status === 429) hint = 'Rate limit or quota exceeded';
      else if (resp.status >= 500) hint = 'Provider server error — try again later';
      sendResponse({ success: false, error: hint });
      return;
    }
    sendResponse({ success: true });
  } catch (_err) {
    sendResponse({ success: false, error: 'Network error' });
  }
}

// ─── Template-based description (no LLM needed) ──────────────────────────────

function generateTemplateDescription(elementContext) {
  const tag = elementContext.tag || '';
  const text = elementContext.text || '';
  const label = elementContext.ariaLabel || '';
  const placeholder = elementContext.placeholder || '';
  const type = elementContext.type || '';
  const href = elementContext.href || '';
  const page = elementContext.pageTitle || '';

  // Best available name for the element
  const name = text || label || placeholder || '';

  // Manual capture / full page
  if (tag === 'page') {
    return page ? `View the "${page}" page` : 'View the current page';
  }

  // Buttons
  if (tag === 'button' || type === 'submit' || type === 'button' || elementContext.role === 'button') {
    return name ? `Click the "${name}" button` : 'Click the button';
  }

  // Links
  if (tag === 'a') {
    return name ? `Click the "${name}" link` : (href ? `Navigate to ${href}` : 'Click the link');
  }

  // Text inputs
  if (tag === 'input' && ['text', 'email', 'password', 'search', 'tel', 'url', 'number'].includes(type)) {
    const fieldName = name || type;
    return `Enter text in the "${fieldName}" field`;
  }

  // Checkboxes & radios
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    return name ? `Select the "${name}" ${type}` : `Click the ${type}`;
  }

  // Select dropdowns
  if (tag === 'select') {
    return name ? `Select an option from "${name}"` : 'Select an option from the dropdown';
  }

  // Textareas
  if (tag === 'textarea') {
    return name ? `Enter text in the "${name}" field` : 'Enter text in the text area';
  }

  // Images
  if (tag === 'img') {
    return name ? `Click the "${name}" image` : 'Click the image';
  }

  // Generic fallback
  if (name) return `Click on "${name}"`;
  return page ? `Interact with the "${page}" page` : 'Click on the element';
}

// ─── Step Capture (from click) ──────────────────────────────────────────────

async function handleCaptureStep(elementContext, tab, sendResponse) {
  let screenshotDataUrl;
  try {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
      quality: 90
    });
  } catch (err) {
    console.error('Trailmark: screenshot failed:', err);
    try { sendResponse?.({ ok: false, error: err.message }); } catch (_) {}
    return;
  }

  // Tell content.js it can re-show the indicator now.
  try { sendResponse?.({ ok: true }); } catch (_) {}

  try {
    // Current steps
    const { steps = [], llmConfig } = await chrome.storage.local.get(['steps', 'llmConfig']);
    const stepNumber = steps.length + 1;

    // Start with template description (always works)
    let description = generateTemplateDescription(elementContext);
    let usedProvider = 'template';

    // If LLM is configured, try to enhance the description
    const provider = llmConfig?.apiKey && llmConfig?.providerId
      ? PROVIDERS[llmConfig.providerId] : null;

    // Reject unsafe custom endpoints before sending the API key.
    let skipLlm = false;
    if (provider && llmConfig.providerId === 'custom') {
      const check = validateCustomUrl(llmConfig.customUrl || '');
      if (!check.ok) {
        console.warn('Trailmark: custom endpoint rejected, using template description.');
        skipLlm = true;
      }
    }

    if (provider && !skipLlm) {
      try {
        const elementSummary = [
          elementContext.text && `visible text: "${elementContext.text}"`,
          elementContext.ariaLabel && `aria-label: "${elementContext.ariaLabel}"`,
          elementContext.placeholder && `placeholder: "${elementContext.placeholder}"`,
          elementContext.type && `input type: "${elementContext.type}"`,
          elementContext.href && `links to: "${elementContext.href}"`,
          `tag: <${elementContext.tag}>`,
          `page: "${elementContext.pageTitle}"`
        ].filter(Boolean).join(', ');

        const prompt = `You are generating step-by-step instructions for a how-to guide.

The user just clicked on an element with these properties: ${elementSummary}

Look at the screenshot and write ONE clear, concise instruction sentence describing what the user should do at this step.

Rules:
- Start with an action verb (Click, Select, Enter, Toggle, Navigate to, etc.)
- Be specific about what to click using the element's visible text or label
- Keep it under 15 words
- Do not mention technical details like CSS classes or IDs
- Write as if instructing someone else to follow these steps

Reply with ONLY the instruction sentence, nothing else.`;

        const { base64, mimeType } = await compressScreenshot(screenshotDataUrl);
        const req = provider.buildRequest(
          llmConfig.apiKey,
          llmConfig.model || provider.defaultModel,
          prompt,
          base64,
          llmConfig.customUrl,
          mimeType
        );

        const response = await fetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body)
        });

        const data = await response.json();

        if (response.ok) {
          const llmDescription = provider.parseResponse(data);
          if (llmDescription) {
            description = llmDescription;
            usedProvider = llmConfig.providerId;
          }
        } else {
          console.warn('Trailmark LLM request failed', { status: response.status });
        }
      } catch (_llmErr) {
        console.warn('Trailmark LLM request errored (using template fallback)');
      }
    }

    const newStep = {
      id: Date.now(),
      stepNumber,
      description,
      screenshot: screenshotDataUrl,
      timestamp: new Date().toISOString(),
      url: elementContext.pageUrl,
      pageTitle: elementContext.pageTitle,
      provider: usedProvider,
      elementContext,
      annotations: []
    };

    await chrome.storage.local.set({ steps: [...steps, newStep] });

    // Auto-set editorTitle from first step's page title
    if (stepNumber === 1) {
      const { editorTitle } = await chrome.storage.local.get(['editorTitle']);
      if (!editorTitle) {
        await chrome.storage.local.set({ editorTitle: elementContext.pageTitle || 'Untitled Guide' });
      }
    }

    // Notify popup
    chrome.runtime.sendMessage({ type: 'STEP_ADDED', step: newStep }).catch(() => {});

  } catch (err) {
    console.error('Trailmark capture error:', err);
  }
}

// ─── Manual Capture (from popup button, no click target) ────────────────────

async function handleManualCapture(sendResponse) {
  try {
    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      sendResponse?.({ ok: false, error: 'No active tab' });
      return;
    }

    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
      quality: 90
    });

    const { steps = [], llmConfig } = await chrome.storage.local.get(['steps', 'llmConfig']);
    const stepNumber = steps.length + 1;

    const elementContext = {
      tag: 'page',
      text: '',
      ariaLabel: null,
      placeholder: null,
      type: null,
      href: null,
      role: null,
      id: null,
      className: null,
      pageTitle: tab.title || '',
      pageUrl: tab.url || ''
    };

    // Start with template description
    let description = generateTemplateDescription(elementContext);
    let usedProvider = 'template';

    // If LLM is configured, try to enhance the description
    const provider = llmConfig?.apiKey && llmConfig?.providerId
      ? PROVIDERS[llmConfig.providerId] : null;

    // Reject unsafe custom endpoints before sending the API key.
    let skipLlm = false;
    if (provider && llmConfig.providerId === 'custom') {
      const check = validateCustomUrl(llmConfig.customUrl || '');
      if (!check.ok) {
        console.warn('Trailmark: custom endpoint rejected, using template description.');
        skipLlm = true;
      }
    }

    if (provider && !skipLlm) {
      try {
        const prompt = `You are generating step-by-step instructions for a how-to guide.

Look at this screenshot of a web page and write ONE clear, concise instruction sentence describing the most likely action the user should take on this page.

Rules:
- Start with an action verb (Click, Select, Enter, Navigate to, Review, etc.)
- Be specific about what to interact with
- Keep it under 15 words
- Write as if instructing someone to follow these steps

Reply with ONLY the instruction sentence, nothing else.`;

        const { base64, mimeType } = await compressScreenshot(screenshotDataUrl);
        const req = provider.buildRequest(
          llmConfig.apiKey,
          llmConfig.model || provider.defaultModel,
          prompt,
          base64,
          llmConfig.customUrl,
          mimeType
        );

        const response = await fetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body)
        });

        const data = await response.json();

        if (response.ok) {
          const llmDescription = provider.parseResponse(data);
          if (llmDescription) {
            description = llmDescription;
            usedProvider = llmConfig.providerId;
          }
        } else {
          console.warn('Trailmark manual capture LLM request failed', { status: response.status });
        }
      } catch (_llmErr) {
        console.warn('Trailmark manual capture LLM request errored (using template)');
      }
    }

    const newStep = {
      id: Date.now(),
      stepNumber,
      description,
      screenshot: screenshotDataUrl,
      timestamp: new Date().toISOString(),
      url: elementContext.pageUrl,
      pageTitle: elementContext.pageTitle,
      provider: usedProvider,
      elementContext,
      annotations: []
    };

    await chrome.storage.local.set({ steps: [...steps, newStep] });

    // Auto-set editorTitle on first step
    if (stepNumber === 1) {
      const { editorTitle } = await chrome.storage.local.get(['editorTitle']);
      if (!editorTitle) {
        await chrome.storage.local.set({ editorTitle: elementContext.pageTitle || 'Untitled Guide' });
      }
    }

    chrome.runtime.sendMessage({ type: 'STEP_ADDED', step: newStep }).catch(() => {});
    sendResponse?.({ ok: true });

  } catch (err) {
    console.error('Trailmark manual capture error:', err);
    sendResponse?.({ ok: false, error: err.message });
  }
}
