const {
  app, BrowserWindow, ipcMain, dialog,
  globalShortcut, desktopCapturer, session, systemPreferences, shell
} = require('electron');
const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const {
  normalizeExtractedText, isZipSignature, isOleSignature, bufferToArrayBuffer, LEGACY_DOC
} = require('./extract-helpers');

let mainWindow;
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const OPENROUTER_HOST = 'openrouter.ai';
const OPENROUTER_PATH = '/api/v1';

let openRouterKeyCache = null;
let openRouterWarned = false;

function getOpenRouterApiKey() {
  if (openRouterKeyCache !== null) return openRouterKeyCache;
  if (process.env.OPENROUTER_API_KEY) {
    openRouterKeyCache = process.env.OPENROUTER_API_KEY.trim();
    return openRouterKeyCache;
  }
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let v = m[1] || '';
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        openRouterKeyCache = v.trim();
        return openRouterKeyCache;
      }
    }
  } catch (_) {}
  openRouterKeyCache = '';
  return openRouterKeyCache;
}

function openRouterHeaders() {
  const key = getOpenRouterApiKey();
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://cue.local',
    'X-Title': 'Cue Interview Assistant'
  };
}

function buildOpenRouterTags(model) {
  const tags = new Set(['openrouter']);
  const id = String(model?.id || '');
  const name = String(model?.name || '');
  if (id.endsWith(':free') || id === 'openrouter/free') tags.add('free');
  if (id === 'openrouter/free' || /router/i.test(name)) tags.add('router');

  const modalities = Array.isArray(model?.architecture?.input_modalities)
    ? model.architecture.input_modalities.map(m => String(m).toLowerCase())
    : [];
  if (modalities.includes('image')) tags.add('vision');
  if (modalities.includes('audio')) tags.add('audio');

  const params = Array.isArray(model?.supported_parameters)
    ? model.supported_parameters.map(p => String(p).toLowerCase())
    : [];
  if (params.includes('tools')) tags.add('tools');
  if (params.includes('structured_outputs')) tags.add('structured');
  if (params.includes('reasoning') || params.includes('include_reasoning')) tags.add('reasoning');

  // "File analysis" proxy: multimodal input and/or very large context for long docs.
  const ctx = Number(model?.context_length || 0);
  if (modalities.includes('image') || ctx >= 128000) tags.add('file-analysis');
  return Array.from(tags);
}

function openRouterGetModels() {
  const key = getOpenRouterApiKey();
  if (!key) return Promise.resolve({ ok: false, models: [], error: 'OPENROUTER_API_KEY missing' });
  return new Promise((resolve) => {
    const req = https.request({
      host: OPENROUTER_HOST,
      path: `${OPENROUTER_PATH}/models`,
      method: 'GET',
      headers: openRouterHeaders()
    }, (res) => {
      let body = '';
      res.on('data', c => (body += c.toString()));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const rows = Array.isArray(parsed.data) ? parsed.data : [];
          const free = rows
            .filter(m => typeof m.id === 'string' && (m.id.endsWith(':free') || m.id === 'openrouter/free'))
            .map(m => {
              const tags = buildOpenRouterTags(m);
              return {
                name: `openrouter/${m.id}`,
                size: 0,
                provider: 'openrouter',
                context_length: m.context_length || 0,
                pricing: m.pricing || null,
                tags,
                supports_file_analysis: tags.includes('file-analysis')
              };
            })
            .sort((a, b) => {
              const ar = a.name === 'openrouter/openrouter/free' ? 0 : 1;
              const br = b.name === 'openrouter/openrouter/free' ? 0 : 1;
              if (ar !== br) return ar - br;
              return a.name.localeCompare(b.name);
            });
          resolve({ ok: true, models: free });
        } catch (e) {
          resolve({ ok: false, models: [], error: e.message });
        }
      });
    });
    req.on('error', e => resolve({ ok: false, models: [], error: e.message }));
    req.setTimeout(12000, () => req.destroy(new Error('openrouter models timeout')));
    req.end();
  });
}

function openRouterChatStream({ model, messages, opts, onChunk, onDone, onError }) {
  const key = getOpenRouterApiKey();
  if (!key) {
    onError(new Error('OPENROUTER_API_KEY missing. Add it to .env and restart the app.'));
    return { destroy() {} };
  }
  const brainMode = (opts && opts.brain === 'deep') ? 'deep' : 'balanced';
  const profile = applyBrainProfile(modelProfile(model), brainMode);
  const temperature = profile.temperature ?? 0.4;
  const body = JSON.stringify({
    model: model.replace(/^openrouter\//, ''),
    stream: true,
    messages,
    temperature,
    max_tokens: profile.num_predict
  });
  const req = https.request({
    host: OPENROUTER_HOST,
    path: `${OPENROUTER_PATH}/chat/completions`,
    method: 'POST',
    headers: { ...openRouterHeaders(), 'Content-Length': Buffer.byteLength(body) }
  }, (res) => {
    let buf = '';
    let done = false;
    const finish = () => { if (!done) { done = true; onDone(); } };
    if (res.statusCode >= 400) {
      let errBody = '';
      res.on('data', c => (errBody += c.toString()));
      res.on('end', () => {
        try {
          const p = JSON.parse(errBody);
          onError(new Error(p?.error?.message || `OpenRouter error (${res.statusCode})`));
        } catch (_) {
          onError(new Error(`OpenRouter error (${res.statusCode})`));
        }
      });
      return;
    }
    res.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { finish(); continue; }
        try {
          const obj = JSON.parse(data);
          const delta = obj?.choices?.[0]?.delta?.content;
          if (delta) onChunk(delta);
        } catch (_) {}
      }
    });
    res.on('end', finish);
    res.on('error', (e) => { if (!done) onError(e); });
  });
  req.on('error', onError);
  req.write(body);
  req.end();
  return req;
}

// ─── Model performance profiles ───────────────────────────────
// 16 GB RAM machine: ~12 GB available after OS + Electron.
// The single biggest lever is num_ctx (KV cache lives in RAM).
// Rule: num_ctx * 2 * num_layers * head_dim * 2 bytes ≈ RAM for KV cache.
// Keep it low. For 7B Q4 models a 2048 ctx uses ~500MB; 4096 uses ~1GB.
//
// num_thread: leave at least half the cores free for macOS / Electron.
// keep_alive: "1m" — Ollama auto-unloads model after 1 min of silence.
function modelProfile(name) {
  const n = (name || '').toLowerCase();

  // Sub-2B: instant, tiny footprint
  if (/moondream|nomic|embed|phi.*:?(0\.5|1)b|tinyllama|qwen.*:?0\.5b/.test(n)) {
    return { num_ctx: 2048, num_predict: 512,  num_thread: 4,  keep_alive: '2m', label: 'tiny' };
  }

  // 3-4B: fast, comfortable on 16 GB
  if (/llama.*:?3b|qwen.*:?3b|gemma.*:?[24]b|phi.*:?3b|mistral.*:?3b|3\.8b/.test(n)) {
    return { num_ctx: 3072, num_predict: 1024, num_thread: 6,  keep_alive: '2m', label: 'small' };
  }

  // 7-8B: sweet spot — qwen2.5-coder:7b, mistral:7b, gemma3:4b, llama3:8b
  // ctx capped at 2048 to prevent RAM pressure on 16GB
  if (/7b|8b|mistral(?!.*:?\d+b)|gemma3|llama3(?!.*:?[0-9]+b)/.test(n)) {
    return { num_ctx: 2048, num_predict: 1024, num_thread: 6,  keep_alive: '1m', label: '7b' };
  }

  // 13-14B: needs careful memory management, warn user
  if (/13b|14b/.test(n)) {
    return { num_ctx: 1536, num_predict: 768,  num_thread: 6,  keep_alive: '1m', label: '14b' };
  }

  // Unknown / large: safe conservative defaults
  return   { num_ctx: 1536, num_predict: 768,  num_thread: 4,  keep_alive: '1m', label: 'safe' };
}

function applyBrainProfile(base, brain) {
  if (brain !== 'deep') return base;
  return {
    ...base,
    num_ctx: Math.min(4096, Math.round(base.num_ctx * 1.5)),
    num_predict: Math.min(1536, Math.round(base.num_predict * 1.35)),
    // Slightly lower temperature for deeper, less jumpy reasoning.
    temperature: 0.25
  };
}

// ─── http helpers ──────────────────────────────────────────────
function httpGet(urlPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: OLLAMA_HOST, port: OLLAMA_PORT, path: urlPath, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', c => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('JSON: ' + body.slice(0, 80))); }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs || 5000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function httpStream(urlPath, body, onChunk, onDone, onError) {
  const str = JSON.stringify(body);
  const req = http.request(
    {
      host: OLLAMA_HOST, port: OLLAMA_PORT, path: urlPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(str) }
    },
    (res) => {
      let buf = '';
      let done = false;
      const finish = () => { if (!done) { done = true; onDone(); } };
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.message?.content) onChunk(obj.message.content);
            if (obj.done === true) finish();
          } catch (_) {}
        }
      });
      res.on('end',   finish);
      res.on('error', e => { if (!done) { done = true; onError(e); } });
    }
  );
  req.on('error', e => onError(e));
  req.write(str);
  req.end();
  return req;
}

function httpDelete(urlPath, body) {
  return new Promise((resolve) => {
    const str = JSON.stringify(body);
    const req = http.request(
      {
        host: OLLAMA_HOST, port: OLLAMA_PORT, path: urlPath,
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(str) }
      },
      (res) => { res.resume(); res.on('end', () => resolve({ ok: true })); }
    );
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.write(str);
    req.end();
  });
}

// Unload a model from RAM immediately via keep_alive: 0
function unloadModel(modelName) {
  if (!modelName) return;
  const str = JSON.stringify({ model: modelName, keep_alive: 0 });
  const req = http.request({
    host: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/generate',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(str) }
  }, res => res.resume());
  req.on('error', () => {});
  req.write(str);
  req.end();
  console.log('[ollama] unloaded', modelName, 'from RAM');
}

// Let Chromium media / screen-capture prompts succeed in our local UI (file://)
function installMediaPermissionHandlers() {
  const allowed = new Set(['media', 'display-capture', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (allowed.has(permission)) return callback(true);
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => permission === 'media');
}

// ─── Window ────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420, height: 540, minWidth: 360, minHeight: 360,
    show: false, frame: false, transparent: true,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, resizable: true,
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: 'active',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false
    },
    type: process.platform === 'darwin' ? 'panel' : 'normal',
    titleBarStyle: 'hidden'
  });

  mainWindow.setContentProtection(true);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.platform === 'darwin') mainWindow.setWindowButtonVisibility(false);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); mainWindow.setOpacity(0.97); });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('console-message', (_, level, msg) => {
    if (level >= 2) console.error('[renderer]', msg.slice(0, 300));
  });

  const toggleLauncher = () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  };

  globalShortcut.register('CommandOrControl+K', toggleLauncher);
  globalShortcut.register('CommandOrControl+Shift+G', toggleLauncher);
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!mainWindow) return;
    mainWindow.setOpacity(mainWindow.getOpacity() > 0.1 ? 0.05 : 0.97);
  });
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    if (mainWindow) mainWindow.webContents.send('shortcut:listen');
  });
}

app.whenReady().then(() => {
  installMediaPermissionHandlers();
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Unload active model on exit so next launch starts fresh
  if (lastModel) unloadModel(lastModel);
});

// ─── IPC: Ollama ───────────────────────────────────────────────

ipcMain.handle('ollama:models', async () => {
  const all = [];
  let ollamaErr = null;
  let orErr = null;

  try {
    const d = await httpGet('/api/tags');
    const models = (d.models || []).map(m => ({ name: m.name, size: m.size || 0, provider: 'ollama' }));
    all.push(...models);
  } catch (e) {
    ollamaErr = e.message;
  }

  const hasOpenRouterKey = !!getOpenRouterApiKey();
  if (hasOpenRouterKey) {
    const or = await openRouterGetModels();
    if (or.ok) all.push(...or.models);
    else orErr = or.error;
  } else if (!openRouterWarned) {
    openRouterWarned = true;
    console.warn('[openrouter] OPENROUTER_API_KEY not set; OpenRouter models hidden');
  }

  if (all.length > 0) {
    const sorted = all.sort((a, b) => {
      const ar = a.name === 'openrouter/openrouter/free' ? 0 : 1;
      const br = b.name === 'openrouter/openrouter/free' ? 0 : 1;
      if (ar !== br) return ar - br;
      return String(a.name).localeCompare(String(b.name));
    });
    console.log('[models]', sorted.map(m => m.name).join(', '));
    return { ok: true, models: sorted };
  }
  return { ok: false, models: [], error: ollamaErr || orErr || 'No model providers available' };
});

let activeStream = null;
let lastModel    = null;
let idleTimer    = null;

// Auto-unload model after 5 minutes of no requests (frees RAM)
function resetIdleTimer(model) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (model) { unloadModel(model); lastModel = null; }
  }, 5 * 60 * 1000);   // 5 minutes
}

ipcMain.handle('ollama:chat', (event, { model, messages, opts }) => {
  // Kill any in-flight stream
  if (activeStream) { try { activeStream.destroy(); } catch (_) {} activeStream = null; }

  if (String(model || '').startsWith('openrouter/')) {
    return new Promise(resolve => {
      const send = (ch, data) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data);
      };
      activeStream = openRouterChatStream({
        model,
        messages,
        opts,
        onChunk: (chunk) => send('chat:chunk', chunk),
        onDone: () => { activeStream = null; send('chat:done', null); resolve({ ok: true }); },
        onError: (err) => { activeStream = null; send('chat:error', err.message); resolve({ ok: false, error: err.message }); }
      });
    });
  }

  lastModel = model;
  resetIdleTimer(model);

  const brainMode = (opts && opts.brain === 'deep') ? 'deep' : 'balanced';
  const profile = applyBrainProfile(modelProfile(model), brainMode);
  const temperature = profile.temperature ?? 0.4;
  console.log(`[ollama:chat] model=${model} brain=${brainMode} ctx=${profile.num_ctx} max_tokens=${profile.num_predict}`);

  return new Promise(resolve => {
    const send = (ch, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data);
    };
    activeStream = httpStream(
      '/api/chat',
      {
        model, messages, stream: true,
        keep_alive: profile.keep_alive,
        options: {
          temperature,
          num_predict: profile.num_predict,
          num_ctx:     profile.num_ctx,
          num_thread:  profile.num_thread,
          num_gpu:     1,        // use GPU layers when available (Apple Silicon MPS)
          low_vram:    false
        }
      },
      chunk => send('chat:chunk', chunk),
      ()    => { activeStream = null; send('chat:done', null); resolve({ ok: true }); },
      err   => { activeStream = null; send('chat:error', err.message); resolve({ ok: false, error: err.message }); }
    );
  });
});

ipcMain.handle('ollama:cancel', () => {
  if (activeStream) { try { activeStream.destroy(); } catch (_) {} activeStream = null; }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:done', null);
  return { ok: true };
});

ipcMain.handle('ollama:unload', (_, { name }) => {
  unloadModel(name || lastModel);
  return { ok: true };
});

ipcMain.handle('ollama:pull', (event, { name }) => {
  return new Promise(resolve => {
    const send = (ch, d) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, d); };
    const str  = JSON.stringify({ name, stream: true });
    const req  = http.request(
      {
        host: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/pull',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(str) }
      },
      res => {
        let buf = '';
        res.on('data', c => {
          buf += c.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              send('pull:progress', { status: obj.status||'', total: obj.total||0, completed: obj.completed||0 });
              if (obj.status === 'success') { send('pull:done', { name }); resolve({ ok: true }); }
            } catch (_) {}
          }
        });
        res.on('end', () => { send('pull:done', { name }); resolve({ ok: true }); });
        res.on('error', e => resolve({ ok: false, error: e.message }));
      }
    );
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.write(str);
    req.end();
  });
});

ipcMain.handle('ollama:delete', async (_, { name }) => {
  return httpDelete('/api/delete', { name });
});

ipcMain.handle('ollama:profile', (_, { name }) => {
  return modelProfile(name);
});

// ─── IPC: Window ───────────────────────────────────────────────
ipcMain.handle('win:minimize', () => mainWindow?.minimize());
ipcMain.handle('win:hide',     () => mainWindow?.hide());
ipcMain.handle('win:pin',  (_, on) => mainWindow?.setAlwaysOnTop(on));
ipcMain.handle('win:ghost',    () => {
  if (!mainWindow) return 0.97;
  const op = mainWindow.getOpacity() > 0.1 ? 0.05 : 0.97;
  mainWindow.setOpacity(op);
  return op;
});

// ─── IPC: Audio sources ────────────────────────────────────────
ipcMain.handle('audio:sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    });
    return { ok: true, sources: sources.map(s => ({ id: s.id, name: s.name })) };
  } catch (e) {
    return { ok: false, sources: [], error: e.message };
  }
});

// macOS: query / prompt mic; report screen-capture (System Settings) status
ipcMain.handle('audio:prepare', async () => {
  const out = { ok: true, mic: 'granted', screen: 'granted' };
  if (process.platform !== 'darwin') return out;
  try {
    let mic = systemPreferences.getMediaAccessStatus('microphone');
    if (mic === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone');
      mic = systemPreferences.getMediaAccessStatus('microphone');
    }
    out.mic = mic;
    out.screen = systemPreferences.getMediaAccessStatus('screen');
  } catch (e) {
    out.ok = false;
    out.error = e.message;
  }
  return out;
});

// Open System Settings to the right privacy pane (user must allow Screen / Mic manually if denied)
ipcMain.handle('audio:open-privacy', async (_, { tab }) => {
  if (process.platform === 'darwin') {
    if (tab === 'screen') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    } else if (tab === 'mic') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    }
  } else if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:privacy-microphone');
  }
  return { ok: true };
});

// ─── IPC: File picker ──────────────────────────────────────────
ipcMain.handle('pick:resume', async () => {
  if (!mainWindow) return { canceled: true };
  return dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Documents', extensions: ['pdf','doc','docx','txt','md'] }]
  });
});

const RESUME_BYTES_MAX = 25 * 1024 * 1024;

async function parseResumeBuffer(buf, ext) {
  const e = (ext && ext.toLowerCase().startsWith('.')) ? ext.toLowerCase() : '.' + String(ext || '').toLowerCase().replace(/^\./, '');

  if (['.txt', '.md', '.markdown'].includes(e)) {
    return { ok: true, text: normalizeExtractedText(buf.toString('utf8')) };
  }

  if (e === '.pdf') {
    const pdfParse = require('pdf-parse');
    const result   = await pdfParse(buf);
    return { ok: true, text: normalizeExtractedText(result.text) };
  }

  if (e === '.doc' && isOleSignature(buf)) {
    return { ok: false, error: LEGACY_DOC };
  }
  if (e === '.docx' && isOleSignature(buf)) {
    return { ok: false, error: 'This file looks like legacy .doc, not .docx. Save as .docx or PDF and try again.' };
  }
  if (e === '.docx' && buf.length > 0 && !isZipSignature(buf)) {
    return { ok: false, error: 'Invalid or corrupted .docx (not a valid Office document).' };
  }

  if (e === '.docx' || (e === '.doc' && isZipSignature(buf))) {
    const mammoth = require('mammoth');
    const res     = await mammoth.extractRawText({ arrayBuffer: bufferToArrayBuffer(buf) });
    const t       = normalizeExtractedText(res.value);
    if (t.length < 15) {
      return { ok: false, error: 'Could not read text from this document. Re-save as .docx in Word or use PDF.' };
    }
    return { ok: true, text: t };
  }

  if (e === '.doc') {
    const mammoth = require('mammoth');
    try {
      const res = await mammoth.extractRawText({ arrayBuffer: bufferToArrayBuffer(buf) });
      const t   = normalizeExtractedText(res.value);
      if (t.length < 15) return { ok: false, error: LEGACY_DOC };
      return { ok: true, text: t };
    } catch (_) {
      return { ok: false, error: LEGACY_DOC };
    }
  }

  return { ok: false, error: 'Unsupported format: ' + e };
}

async function parseAttachmentBuffer(buf, ext) {
  const e = (ext && ext.toLowerCase().startsWith('.')) ? ext.toLowerCase() : '.' + String(ext || '').toLowerCase().replace(/^\./, '');

  if (['.txt', '.md', '.markdown', '.json', '.js', '.ts', '.py', '.java', '.go', '.rs', '.sql', '.html', '.css'].includes(e)) {
    return { ok: true, kind: 'text', text: normalizeExtractedText(buf.toString('utf8')) };
  }
  if (e === '.pdf') {
    const pdfParse = require('pdf-parse');
    const res = await pdfParse(buf);
    return { ok: true, kind: 'text', text: normalizeExtractedText(res.text) };
  }
  if (e === '.doc' && isOleSignature(buf)) return { ok: false, error: LEGACY_DOC };
  if (e === '.docx' || (e === '.doc' && isZipSignature(buf))) {
    const mammoth = require('mammoth');
    const res = await mammoth.extractRawText({ arrayBuffer: bufferToArrayBuffer(buf) });
    return { ok: true, kind: 'text', text: normalizeExtractedText(res.value) };
  }
  if (['.csv', '.xlsx', '.xls'].includes(e)) {
    const xlsx = require('xlsx');
    const wb = xlsx.read(buf, { type: 'buffer' });
    const text = wb.SheetNames.map(name => {
      const sheet = wb.Sheets[name];
      return `=== Sheet: ${name} ===\n` + xlsx.utils.sheet_to_csv(sheet);
    }).join('\n\n');
    return { ok: true, kind: 'text', text: normalizeExtractedText(text) };
  }
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(e)) {
    const mime = e === '.jpg' ? 'image/jpeg' : `image/${e.slice(1)}`;
    return { ok: true, kind: 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  }
  return { ok: false, error: 'Unsupported attachment format: ' + e };
}

// Parse resume file in main process (path and/or base64 for drag-drop when file.path is missing)
ipcMain.handle('parse:resume', async (_, payload) => {
  try {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'Invalid request' };
    }
    if (payload.base64 != null && (payload.fileName != null || payload.name != null)) {
      const buf = Buffer.from(String(payload.base64), 'base64');
      if (!buf.length) return { ok: false, error: 'Empty file' };
      if (buf.length > RESUME_BYTES_MAX) return { ok: false, error: 'File is too large' };
      const name = payload.fileName || payload.name;
      const ext  = path.extname(name);
      if (!ext) return { ok: false, error: 'Missing file extension' };
      return await parseResumeBuffer(buf, ext);
    }
    const filePath = payload.filePath;
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, error: 'No file path or file data' };
    }
    if (!fs.existsSync(filePath)) return { ok: false, error: 'File not found' };
    const st = fs.statSync(filePath);
    if (st.size > RESUME_BYTES_MAX) return { ok: false, error: 'File is too large' };
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    if (!ext) return { ok: false, error: 'Missing file extension' };
    return await parseResumeBuffer(buf, ext);
  } catch (e) {
    console.error('[parse:resume]', e.message);
    return { ok: false, error: e.message || 'Parse failed' };
  }
});

ipcMain.handle('parse:attachment', async (_, payload) => {
  try {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'Invalid request' };
    const name = payload.fileName || payload.name || '';
    const ext = path.extname(name);
    if (!ext) return { ok: false, error: 'Missing file extension' };
    let buf = null;
    if (payload.base64 != null) buf = Buffer.from(String(payload.base64), 'base64');
    else if (payload.filePath) {
      if (!fs.existsSync(payload.filePath)) return { ok: false, error: 'File not found' };
      buf = fs.readFileSync(payload.filePath);
    }
    if (!buf || !buf.length) return { ok: false, error: 'Empty file' };
    if (buf.length > RESUME_BYTES_MAX) return { ok: false, error: 'File is too large' };
    return await parseAttachmentBuffer(buf, ext);
  } catch (e) {
    console.error('[parse:attachment]', e.message);
    return { ok: false, error: e.message || 'Attachment parse failed' };
  }
});

ipcMain.handle('get:platform', () => process.platform);

// ─── IPC: Knowledge Base (RAG) ─────────────────────────────────
const kb = require('./kb-engine');

ipcMain.handle('kb:pick-files', async () => {
  if (!mainWindow) return { canceled: true };
  return dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Documents & Images', extensions: ['pdf','docx','doc','txt','md','xlsx','xls','csv','png','jpg','jpeg','webp'] }
    ]
  });
});

ipcMain.handle('kb:add-file', async (event, { kbId, filePath }) => {
  try {
    const result = await kb.addFile(kbId, filePath, (pct, status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('kb:progress', { filePath, pct, status });
      }
    });
    return { ok: true, ...result };
  } catch (e) {
    console.error('[kb:add-file]', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('kb:query', async (_, { kbId, query, topK }) => {
  try {
    const context = await kb.query(kbId, query, topK || 5);
    return { ok: true, context };
  } catch (e) {
    return { ok: false, context: '', error: e.message };
  }
});

ipcMain.handle('kb:remove-file', async (_, { kbId, filePath }) => {
  try {
    const result = await kb.removeFile(kbId, filePath);
    return { ok: true, ...result };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('kb:list-files', async (_, { kbId }) => {
  try {
    const files = await kb.listFiles(kbId);
    return { ok: true, files };
  } catch (e) { return { ok: false, files: [], error: e.message }; }
});

ipcMain.handle('kb:get-stats', async (_, { kbId }) => {
  try {
    const stats = await kb.getStats(kbId);
    return { ok: true, ...stats };
  } catch (e) { return { ok: false, chunks: 0, files: 0 }; }
});

ipcMain.handle('kb:delete', async (_, { kbId }) => {
  try { await kb.deleteKB(kbId); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
