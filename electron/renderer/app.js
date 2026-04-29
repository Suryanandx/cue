mermaid.initialize({ startOnLoad:false, theme:'dark', securityLevel:'loose' });

// Path helper for renderer (no Node path module in renderer context)
const path = { basename: s => (s || '').split(/[\\/]/).pop() };

// ── State ────────────────────────────────────────────────────
const S = {
  busy:        false,
  sidePane:    null,
  resume:      null,
  listening:   false,
  stream:      null,
  recog:       null,
  dictating:   false,
  dictateRec:  null,
  dictationBase: '',
  ctxMenu:     { targetId: null },
  popoverOpen: false,
  attachments: []
};

const RAM_SAFE_GB  = 5.0;
const RAM_TIGHT_GB = 6.5;

// ── DOM ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
let E   = {};

function cacheEls() {
  E = {
    messages:       $('messages'),
    chatInput:      $('chat-input'),
    btnSend:        $('btn-send'),
    btnAttach:      $('btn-attach'),
    chatAttachInput:$('chat-attachments'),
    attachmentTray: $('attachment-tray'),
    btnDictate:     $('btn-dictate'),
    agentSel:       $('agent-select'),
    agentTag:       $('agent-tag'),
    modelSel:       $('model-select'),
    brainSel:       $('brain-select'),
    statusBadge:    $('ollama-status'),
    sideCol:        $('side-col'),
    sidebar:        $('sidebar'),
    chatList:       $('chat-list'),
    chatTitle:      $('chat-title-display'),
    listenPill:     $('listen-pill'),
    listenLabel:    $('listen-label'),
    listenBanner:   $('listen-banner'),
    liveText:       $('live-transcript'),
    bannerStop:     $('banner-stop'),
    btnGhost:       $('btn-ghost'),
    btnMin:         $('btn-minimize'),
    btnNotes:       $('btn-notes'),
    btnModels:      $('btn-models'),
    btnResume:      $('btn-resume'),
    btnToggleSidebar: $('btn-toggle-sidebar'),
    btnNewChat:     $('btn-new-chat'),
    btnClearChat:   $('btn-clear-chat'),
    btnDeleteChat:  $('btn-delete-chat'),
    btnChatSettings:$('btn-chat-settings'),
    settingsPopover:$('settings-popover'),
    settingsChatName:$('settings-chat-name'),
    settingsTone:   $('settings-tone'),
    settingsContext:$('settings-context'),
    settingsMemInfo:$('settings-memory-info'),
    btnSettingsSave:$('btn-settings-save'),
    btnSettingsCancel:$('btn-settings-cancel'),
    btnClearMemory: $('btn-clear-memory'),
    notesArea:      $('notes-area'),
    modelsList:     $('models-installed'),
    pullInput:      $('pull-input'),
    btnPull:        $('btn-pull'),
    pullProg:       $('pull-progress'),
    pullBar:        $('pull-bar'),
    pullText:       $('pull-text'),
    btnKB:          $('btn-kb'),
    btnUnload:      $('btn-unload-model'),
    memWarning:     $('mem-warning'),
    memWarningText: $('mem-warning-text'),
    memoryBar:      $('memory-bar'),
    memoryBarText:  $('memory-bar-text'),
    ctxMenu:        $('ctx-menu'),
    ctxRename:      $('ctx-rename'),
    ctxClear:       $('ctx-clear'),
    ctxDelete:      $('ctx-delete'),
  };
}

// ── Boot ─────────────────────────────────────────────────────
function init() {
  cacheEls();

  // ── Migrate / sanitise localStorage ──────────────────────
  // Wipe any chats whose messages contain raw dev-session content
  // (identifiable by markdown table pipes, changelog text, etc.)
  try {
    const raw = localStorage.getItem('cue-chats');
    if (raw) {
      const chats = JSON.parse(raw);
      let dirty = false;
      for (const [id, chat] of Object.entries(chats)) {
        if (!chat.messages) continue;
        chat.messages = chat.messages.filter(m => {
          // Drop messages that look like dev-session spill
          const c = m.content || '';
          const isSpill = c.includes('| Before | After | Saved |') ||
                          c.includes('npm start') && c.includes('Total vertical') ||
                          c.includes('sidebar-w') || c.includes('topbar-h') ||
                          (c.length > 2000 && c.includes('---') && c.includes('|'));
          if (isSpill) { dirty = true; return false; }
          return true;
        });
      }
      if (dirty) {
        localStorage.setItem('cue-chats', JSON.stringify(chats));
        console.log('[cue] Wiped corrupt dev-session chat messages');
      }
    }
  } catch (e) { console.warn('[cue] Migration error:', e.message); }

  S.resume = new window.ResumeManager();
  window.resumeManager = S.resume;  // expose for analysis callbacks
  S.resume.init();

  // Init KB store
  window.kbStore.init(() => renderKBPanel());

  const saved = localStorage.getItem('cue-notes') || '';
  if (saved) E.notesArea.value = saved;

  bindWindow();
  bindChat();
  bindSidebar();
  bindSide();
  bindSettings();
  bindNotes();
  bindModels();
  bindKB();
  bindListen();
  bindDictation();
  bindMessageBubbleActions();
  bindCtxMenu();
  renderAttachmentTray();

  // New: Cluely-style pickers
  bindAgentPicker();
  bindModelPicker();
  bindLayoutPicker();
  bindLayoutHotkeys();

  // Reuse global shortcut for chat dictation (speech-to-text)
  window.cue.onListen(() => toggleDictation());

  pollOllama();
  setInterval(pollOllama, 10000);

  // Render initial state
  renderChatList();
  loadChat(window.chatStore.getActiveId());
}

// ── Window ───────────────────────────────────────────────────
function bindWindow() {
  E.btnGhost.addEventListener('click', async () => {
    const op = await window.cue.win.ghost();
    E.btnGhost.classList.toggle('active', op < 0.1);
  });
  E.btnMin.addEventListener('click', () => window.cue.win.minimize());
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      if (S.popoverOpen) { closePopover(); return; }
      window.cue.win.hide();
    }
  });
  document.addEventListener('click', ev => {
    if (S.popoverOpen && !E.settingsPopover.contains(ev.target) && ev.target !== E.btnChatSettings) {
      closePopover();
    }
    if (E.ctxMenu.style.display !== 'none' && !E.ctxMenu.contains(ev.target)) {
      E.ctxMenu.style.display = 'none';
    }
  });
}

// ── Sidebar ───────────────────────────────────────────────────
function bindSidebar() {
  E.btnToggleSidebar.addEventListener('click', () => {
    E.sidebar.classList.toggle('open');
    E.btnToggleSidebar.classList.toggle('active', E.sidebar.classList.contains('open'));
  });
  E.btnNewChat.addEventListener('click', () => {
    const id = window.chatStore.createChat('New Chat');
    window.chatStore.setActive(id);
    renderChatList();
    loadChat(id);
  });
}

function renderChatList() {
  const chats = window.chatStore.getAllChats();
  const active = window.chatStore.getActiveId();
  E.chatList.innerHTML = '';
  chats.forEach(chat => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === active ? ' active' : '');
    item.dataset.id = chat.id;
    const age = timeAgo(chat.updated);
    item.innerHTML = `
      <span class="chat-item-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
      <span class="chat-item-name" title="${x(chat.name)}">${x(chat.name)}</span>
      <span class="chat-item-time">${age}</span>`;
    item.addEventListener('click', () => {
      window.chatStore.setActive(chat.id);
      renderChatList();
      loadChat(chat.id);
    });
    item.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      S.ctxMenu.targetId = chat.id;
      E.ctxMenu.style.display = 'block';
      E.ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - 170) + 'px';
      E.ctxMenu.style.top  = Math.min(ev.clientY, window.innerHeight - 120) + 'px';
    });
    E.chatList.appendChild(item);
  });
}

function loadChat(id) {
  const chat = window.chatStore.getChat(id);
  if (!chat) return;

  E.chatTitle.textContent = chat.name;
  E.agentSel.value = chat.settings.agent || 'auto';
  E.brainSel.value = chat.settings.brain || 'balanced';

  // Render all messages
  E.messages.innerHTML = '';
  if (chat.messages.length === 0) {
    showWelcome();
  } else {
    // Show summary divider if memory was compressed
    if (chat.summary) {
      const div = document.createElement('div');
      div.className = 'memory-divider';
      div.textContent = '↑ summarized memory';
      E.messages.appendChild(div);
    }
    chat.messages.forEach(m => {
      appendBubble(m.role, m.content, m.agentName || null, false);
    });
  }
  E.messages.scrollTop = E.messages.scrollHeight;
  setTimeout(renderMermaid, 50);
  updateMemoryBar(id);
}

function showWelcome() {
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = `
    <span class="msg-agent">Cue</span>
    <div class="msg-body">
      Ready. Ask anything — I'll route to the right agent automatically.<br><br>
      <strong>Agents:</strong> Aria (theory) &nbsp;·&nbsp; Atlas (system design) &nbsp;·&nbsp; Axel (DSA) &nbsp;·&nbsp; Sage (AI / ML &amp; LLMs) &nbsp;·&nbsp; Nova (resume)<br><br>
      Use the settings button (gear icon) above to set tone, context, or lock an agent for this chat.
    </div>`;
  E.messages.appendChild(div);
}

function updateMemoryBar(id) {
  const info = window.chatStore.getMemoryInfo(id);
  if (!info || info.total === 0) { E.memoryBar.style.display = 'none'; return; }
  E.memoryBar.style.display = 'block';
  let txt = `${info.inWindow} of ${info.total} messages in context`;
  if (info.hasSummary) txt += ` · summary active (${info.summaryLength} chars)`;
  E.memoryBarText.textContent = txt;
}

// ── Context menu ──────────────────────────────────────────────
function bindCtxMenu() {
  E.ctxRename.addEventListener('click', () => {
    E.ctxMenu.style.display = 'none';
    const id   = S.ctxMenu.targetId;
    const chat = window.chatStore.getChat(id);
    if (!chat) return;
    const name = prompt('Rename chat:', chat.name);
    if (name !== null) {
      window.chatStore.renameChat(id, name);
      renderChatList();
      if (id === window.chatStore.getActiveId()) E.chatTitle.textContent = name.trim() || 'Chat';
    }
  });
  E.ctxClear.addEventListener('click', () => {
    E.ctxMenu.style.display = 'none';
    if (!confirm('Clear all messages?')) return;
    const id = S.ctxMenu.targetId;
    window.chatStore.clearMessages(id);
    if (id === window.chatStore.getActiveId()) loadChat(id);
    renderChatList();
  });
  E.ctxDelete.addEventListener('click', () => {
    E.ctxMenu.style.display = 'none';
    const id = S.ctxMenu.targetId;
    const chat = window.chatStore.getChat(id);
    if (!confirm('Delete "' + (chat?.name || 'chat') + '"?')) return;
    const newActive = window.chatStore.deleteChat(id);
    renderChatList();
    loadChat(newActive);
  });
}

// ── Per-chat settings popover ─────────────────────────────────
function bindSettings() {
  E.btnChatSettings.addEventListener('click', () => {
    if (S.popoverOpen) { closePopover(); return; }
    openPopover();
  });
  E.btnSettingsSave.addEventListener('click', () => {
    const id   = window.chatStore.getActiveId();
    const name = E.settingsChatName.value.trim();
    window.chatStore.saveSettings(id, {
      agent:   E.agentSel.value,
      tone:    E.settingsTone.value,
      context: E.settingsContext.value.trim()
    });
    if (name) {
      window.chatStore.renameChat(id, name);
      E.chatTitle.textContent = name;
      renderChatList();
    }
    closePopover();
    toast('Settings saved', 'ok');
  });
  E.btnSettingsCancel.addEventListener('click', closePopover);
  E.btnClearMemory.addEventListener('click', () => {
    const id = window.chatStore.getActiveId();
    window.chatStore.clearMessages(id);
    loadChat(id);
    updatePopoverMemInfo(id);
    toast('Memory cleared', 'ok');
  });
}

function openPopover() {
  const id   = window.chatStore.getActiveId();
  const chat = window.chatStore.getChat(id);
  if (!chat) return;
  E.settingsChatName.value    = chat.name === 'New Chat' ? '' : chat.name;
  E.settingsTone.value        = chat.settings.tone    || 'interview';
  E.settingsContext.value     = chat.settings.context || '';
  E.agentSel.value            = chat.settings.agent   || 'auto';
  updatePopoverMemInfo(id);
  E.settingsPopover.style.display = 'block';
  S.popoverOpen = true;
  E.btnChatSettings.classList.add('active');
}

function closePopover() {
  E.settingsPopover.style.display = 'none';
  S.popoverOpen = false;
  E.btnChatSettings.classList.remove('active');
}

function updatePopoverMemInfo(id) {
  const info = window.chatStore.getMemoryInfo(id);
  if (!info) { E.settingsMemInfo.textContent = 'No messages'; return; }
  let t = `${info.total} messages`;
  if (info.total > 0) t += ` · ${info.inWindow} in active context`;
  if (info.hasSummary) t += ` · compressed summary`;
  E.settingsMemInfo.textContent = t;
}

// ── Ollama ───────────────────────────────────────────────────
async function pollOllama() {
  const ok = await window.ollama.refresh();
  E.statusBadge.textContent = ok ? 'Online' : 'Offline';
  E.statusBadge.className   = 'status-badge ' + (ok ? 'online' : 'offline');
  if (ok) {
    const cur = window.ollama.getModel();
    E.modelSel.innerHTML = '<option value="">Model...</option>' +
      window.ollama.models.map(m => {
        const sz = m.size ? ' (' + (m.size/1e9).toFixed(1) + 'GB)' : '';
        const tags = Array.isArray(m.tags) && m.tags.length ? ' [' + m.tags.slice(0, 3).join(', ') + ']' : '';
        const fileCap = m.supports_file_analysis ? ' [files]' : '';
        return `<option value="${m.name}"${m.name===cur?' selected':''}>${m.name}${tags}${fileCap}${sz}</option>`;
      }).join('');
  }
  if (S.sidePane === 'models') renderModels();
}

// ── Chat ─────────────────────────────────────────────────────
function bindChat() {
  E.btnSend.addEventListener('click', () => sendMsg());
  E.btnAttach && E.btnAttach.addEventListener('click', () => E.chatAttachInput && E.chatAttachInput.click());
  E.chatAttachInput && E.chatAttachInput.addEventListener('change', async ev => {
    const files = [...(ev.target.files || [])];
    if (!files.length) return;
    await addAttachments(files);
    ev.target.value = '';
  });
  E.chatInput.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendMsg(); }
  });
  E.chatInput.addEventListener('input', () => {
    E.chatInput.style.height = 'auto';
    E.chatInput.style.height = Math.min(E.chatInput.scrollHeight, 100) + 'px';
  });
  E.agentSel.addEventListener('change', ev => {
    const id = window.chatStore.getActiveId();
    window.chatStore.saveSettings(id, { agent: ev.target.value });
    if (ev.target.value === 'auto') E.agentTag.style.display = 'none';
    else setTag(ev.target.value);
  });
  E.modelSel.addEventListener('change', ev => {
    if (!ev.target.value) return;
    window.ollama.setModel(ev.target.value);
    const sel = window.ollama.models.find(m => m.name === ev.target.value);
    if (sel) {
      const gb = sel.size / 1e9;
      if (gb > RAM_TIGHT_GB) toast(sel.name + ' (' + gb.toFixed(1) + 'GB) — may cause hangs on 16GB', 'err');
      else if (gb > RAM_SAFE_GB) toast(sel.name + ' (' + gb.toFixed(1) + 'GB) — close other apps', 'warn');
    }
  });
  E.brainSel.addEventListener('change', ev => {
    const id = window.chatStore.getActiveId();
    const mode = ev.target.value === 'deep' ? 'deep' : 'balanced';
    window.chatStore.saveSettings(id, { brain: mode });
    toast(mode === 'deep' ? 'Brain mode: Deep Think' : 'Brain mode: Balanced', 'ok');
  });

  E.btnClearChat.addEventListener('click', () => {
    const id = window.chatStore.getActiveId();
    if (!id) return;
    if (!confirm('Clear all messages in this chat?')) return;
    window.chatStore.clearMessages(id);
    loadChat(id);
    renderChatList();
    toast('Chat cleared', 'ok');
  });

  E.btnDeleteChat.addEventListener('click', () => {
    const id = window.chatStore.getActiveId();
    const chat = window.chatStore.getChat(id);
    if (!id || !chat) return;
    if (!confirm('Delete "' + chat.name + '"?')) return;
    const newActive = window.chatStore.deleteChat(id);
    renderChatList();
    loadChat(newActive);
    toast('Chat deleted', 'ok');
  });
}

function renderAttachmentTray() {
  if (!E.attachmentTray) return;
  if (!S.attachments.length) {
    E.attachmentTray.style.display = 'none';
    E.attachmentTray.innerHTML = '';
    return;
  }
  E.attachmentTray.style.display = 'flex';
  E.attachmentTray.innerHTML = S.attachments.map((a, i) =>
    `<span class="attachment-chip" title="${x(a.name)}"><span>${a.kind === 'image' ? 'IMG' : 'FILE'}</span><span class="chip-name">${x(a.name)}</span><button class="chip-x" data-idx="${i}" aria-label="Remove attachment">x</button></span>`
  ).join('');
  E.attachmentTray.querySelectorAll('.chip-x').forEach(btn => btn.addEventListener('click', () => {
    const idx = Number(btn.dataset.idx);
    if (Number.isInteger(idx) && idx >= 0) S.attachments.splice(idx, 1);
    renderAttachmentTray();
  }));
}

function toBase64FromArrayBuffer(ab) {
  const bytes = new Uint8Array(ab);
  const CHUNK = 0x7fff;
  let binary  = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}

async function addAttachments(files) {
  for (const file of files) {
    if (S.attachments.length >= 6) { toast('Max 6 attachments per message', 'warn'); break; }
    try {
      const ab = await file.arrayBuffer();
      const b64 = toBase64FromArrayBuffer(ab);
      const parsed = await window.cue.parseAttachment({ base64: b64, fileName: file.name, mimeType: file.type });
      if (!parsed.ok) { toast(parsed.error || ('Could not parse ' + file.name), 'warn'); continue; }
      if (parsed.kind === 'image') {
        S.attachments.push({ name: file.name, kind: 'image', dataUrl: parsed.dataUrl });
      } else {
        const trimmed = (parsed.text || '').trim();
        if (!trimmed) { toast('No text extracted from ' + file.name, 'warn'); continue; }
        S.attachments.push({ name: file.name, kind: 'file', text: trimmed.slice(0, 6000) });
      }
    } catch (e) {
      toast('Attachment failed: ' + file.name, 'err');
    }
  }
  renderAttachmentTray();
}

async function sendMsg(overrideText) {
  if (S.busy) return;
  const text = (overrideText || E.chatInput.value).trim();
  const attachments = S.attachments.slice();
  if (!text && attachments.length === 0) return;
  if (!window.ollama.connected)  { toast('No model providers online', 'err');  return; }
  if (!window.ollama.getModel()) { toast('Select a model', 'warn'); return; }

  E.chatInput.value = '';
  E.chatInput.style.height = 'auto';
  S.attachments = [];
  renderAttachmentTray();

  const chatId   = window.chatStore.getActiveId();
  const chat     = window.chatStore.getChat(chatId);
  const agentKey = (chat.settings.agent !== 'auto' ? chat.settings.agent : null)
                || window.Agents.detect(text, S.resume.hasResume());
  const agent    = window.Agents[agentKey];
  setTag(agentKey);

  const attachmentSummary = attachments.length
    ? '\n\nAttachments:\n' + attachments.map(a => `- ${a.kind === 'image' ? '[image]' : '[file]'} ${a.name}`).join('\n')
    : '';
  const userDisplayText = text || 'Attached files';
  window.chatStore.addMessage(chatId, 'user', userDisplayText + attachmentSummary);
  appendBubble('user', userDisplayText + attachmentSummary, null, true);

  // ── RAG: query knowledge base for relevant context ──
  let ragContext = '';
  if (window.kbStore && window.kbStore.hasFiles()) {
    ragContext = await window.kbStore.query(text);
  }

  // Tone modifier
  const tone = chat.settings.tone || 'interview';
  const toneNote = {
    interview: '',
    concise:   '\n\n[Respond in concise bullet points only. Minimal prose.]',
    detailed:  '\n\n[Give a thorough, detailed explanation with examples.]',
    casual:    '\n\n[Be conversational and informal, like talking to a friend.]',
    socratic:  '\n\n[After answering, ask the user one follow-up question to deepen understanding.]'
  }[tone] || '';

  // Build system prompt with tone + custom context
  const basePrompt = (agentKey === 'nova' ? agent.getSystemPrompt(S.resume.getText()) : agent.getSystemPrompt()) + toneNote;
  let fullPrompt = basePrompt;
  if (chat.settings.context) {
    fullPrompt += '\n\n[User-provided interview context]: ' + chat.settings.context;
  }
  if (ragContext) {
    fullPrompt += '\n\n[Relevant knowledge base context — use this to inform your answer]:\n' + ragContext;
  }

  // Build memory-aware message array
  const msgs = window.chatStore.buildContext(chatId, fullPrompt);
  const modelName = window.ollama.getModel() || '';
  const isOpenRouter = modelName.startsWith('openrouter/');
  if (attachments.length) {
    const last = msgs[msgs.length - 1];
    const fileText = attachments.filter(a => a.kind === 'file').map(a => `\n[File: ${a.name}]\n${a.text}`).join('\n');
    const mergedText = (text || 'Please analyze the attached content.') + (fileText ? '\n\nAttached file extracts:\n' + fileText : '');
    if (isOpenRouter) {
      const content = [{ type: 'text', text: mergedText }];
      attachments.filter(a => a.kind === 'image' && a.dataUrl).forEach(a => {
        content.push({ type: 'image_url', image_url: { url: a.dataUrl } });
      });
      last.content = content;
    } else {
      // Non-OpenRouter providers get extracted text context only.
      last.content = mergedText + (attachments.some(a => a.kind === 'image') ? '\n\n[Images were attached but this provider may not support image vision.]' : '');
    }
  }
  const brainMode = chat.settings.brain || 'balanced';

  S.busy = true;
  E.btnSend.disabled = true;

  const bubble = appendBubble('ai', null, agent.name, true);
  const body   = bubble.querySelector('.msg-body');
  if (ragContext) {
    // Show RAG badge above typing indicator
    const badge = document.createElement('div');
    badge.className = 'rag-badge';
    badge.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg> Knowledge base context applied';
    bubble.insertBefore(badge, body);
  }
  body.innerHTML = dots();

  let full = '', first = true;

  await window.ollama.chat(
    msgs,
    chunk => {
      if (first) { body.innerHTML = ''; first = false; }
      full += chunk;
      body.innerHTML = render(full, true);
      E.messages.scrollTop = E.messages.scrollHeight;
    },
    async () => {
      body.innerHTML = render(full, false);
      E.messages.scrollTop = E.messages.scrollHeight;
      S.busy = false;
      E.btnSend.disabled = false;
      setTimeout(renderMermaid, 50);

      // Persist AI response
      window.chatStore.addMessage(chatId, 'assistant', full, agentKey);
      renderChatList(); // refresh timestamps

      // Update chat title if it was auto-named
      const updatedChat = window.chatStore.getChat(chatId);
      E.chatTitle.textContent = updatedChat.name;

      updateMemoryBar(chatId);

      // Trigger background summarization if needed
      if (window.chatStore.shouldSummarize(chatId)) {
        summarizeInBackground(chatId);
      }
    },
    err => {
      S.busy = false;
      E.btnSend.disabled = false;
      body.innerHTML = `<span style="color:var(--red)">Error: ${x(err)}</span>`;
    },
    { brain: brainMode }
  );
}

async function summarizeInBackground(chatId) {
  const msgs = window.chatStore.buildSummaryMessages(chatId);
  if (!msgs) return;

  let summary = '';
  await window.ollama.chat(
    msgs,
    chunk => { summary += chunk; },
    () => {
      if (summary.trim()) {
        window.chatStore.applySummary(chatId, summary.trim());
        updateMemoryBar(chatId);
        updatePopoverMemInfo(chatId);
      }
    },
    () => {} // silent fail — not critical
  );
}

function appendBubble(role, text, agentName, scroll) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : 'ai');

  if (role === 'ai') {
    const lbl = document.createElement('span');
    lbl.className   = 'msg-agent';
    lbl.textContent = agentName || 'Cue';
    div.appendChild(lbl);
  }

  const body = document.createElement('div');
  body.className = 'msg-body';
  if (text !== null) {
    body.innerHTML = render(text, false);
  }
  div.appendChild(body);
  E.messages.appendChild(div);
  if (scroll) E.messages.scrollTop = E.messages.scrollHeight;
  return div;
}

function setTag(key) {
  const n = { aria:'Aria', atlas:'Atlas', axel:'Axel', sage:'Sage', nova:'Nova' };
  E.agentTag.textContent   = n[key] || key;
  E.agentTag.style.display = 'inline-block';
}

// ── Side panels ───────────────────────────────────────────────
function bindSide() {
  const items = [
    { btn:E.btnNotes,  key:'notes',  el:$('pane-notes')  },
    { btn:E.btnModels, key:'models', el:$('pane-models') },
    { btn:E.btnResume, key:'resume', el:$('pane-resume') },
    { btn:E.btnKB,     key:'kb',     el:$('pane-kb')     }
  ];
  items.forEach(({ btn, key, el }) => {
    btn.addEventListener('click', () => {
      if (S.sidePane === key) {
        E.sideCol.classList.remove('open'); el.style.display='none'; btn.classList.remove('active'); S.sidePane=null; return;
      }
      items.forEach(i => { i.el.style.display='none'; i.btn.classList.remove('active'); });
      el.style.display='flex'; btn.classList.add('active'); E.sideCol.classList.add('open'); S.sidePane=key;
      if (key==='models') renderModels();
    });
  });
}

// ── Knowledge Base ────────────────────────────────────────────
function bindKB() {
  // Add files button
  $('btn-kb-add').addEventListener('click', () => pickAndAddFiles());

  // Drop zone
  const dz = $('kb-drop-zone');
  dz.addEventListener('click', () => pickAndAddFiles());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', async e => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    const paths = [...e.dataTransfer.files].map(f => f.path).filter(Boolean);
    if (paths.length) await ingestFiles(paths);
  });

  // Enable toggle
  $('kb-enabled-toggle').checked = window.kbStore.enabled;
  $('kb-enabled-toggle').addEventListener('change', e => {
    window.kbStore.setEnabled(e.target.checked);
    renderKBPanel();
    toast('KB ' + (e.target.checked ? 'enabled' : 'disabled'), 'ok');
  });
}

async function pickAndAddFiles() {
  // Auto-open KB panel if closed
  if (S.sidePane !== 'kb') {
    const paneEl = $('pane-kb');
    const kbBtn  = E.btnKB;
    ['pane-notes','pane-models','pane-resume','pane-kb'].forEach(id => { const el=$(id); if(el) el.style.display='none'; });
    [E.btnNotes, E.btnModels, E.btnResume, E.btnKB].forEach(b => { if(b) b.classList.remove('active'); });
    if (paneEl) paneEl.style.display = 'flex';
    if (kbBtn)  kbBtn.classList.add('active');
    E.sideCol.classList.add('open');
    S.sidePane = 'kb';
  }

  const r = await window.cue.kb.pickFiles();
  if (r.canceled || !r.filePaths.length) return;
  await ingestFiles(r.filePaths);
}

// Per-session KB upload errors. Persisted in panel until user dismisses.
window._kbErrors = window._kbErrors || [];
const SUPPORTED_KB_EXT = ['.pdf','.docx','.txt','.md','.csv','.xlsx','.xls','.png','.jpg','.jpeg','.webp','.gif'];
const MAX_KB_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

async function ingestFiles(filePaths) {
  const wrap = $('kb-progress-wrap');
  const bar  = $('kb-progress-bar');
  const txt  = $('kb-progress-text');

  if (!wrap) { toast('Open the Knowledge Base panel first', 'warn'); return; }

  // Pre-flight validation: catch unsupported types and oversized files BEFORE upload
  const valid = [];
  for (const fp of filePaths) {
    const name = path.basename(fp).toLowerCase();
    const ext = '.' + (name.split('.').pop() || '');
    if (!SUPPORTED_KB_EXT.includes(ext)) {
      window._kbErrors.push({ name, error: `Unsupported type: ${ext}. Try PDF / DOCX / TXT / XLSX / image.`, ts: Date.now() });
      continue;
    }
    valid.push(fp);
  }

  if (window._kbErrors.length) renderKBPanel();
  if (valid.length === 0) {
    toast('No supported files', 'err');
    return;
  }

  wrap.style.display = 'flex';
  bar.style.width    = '0%';
  txt.textContent    = 'Preparing…';
  renderKBPanel();

  let okCount = 0, failCount = 0;
  for (const fp of valid) {
    const name = path.basename(fp);
    bar.style.width  = '5%';
    txt.textContent  = 'Starting: ' + name;

    const result = await new Promise(resolve => {
      window.cue.kb.clearListeners();
      window.cue.kb.onProgress(d => {
        if (d.filePath !== fp) return;
        const pct = d.pct || 0;
        bar.style.width  = Math.max(5, pct) + '%';
        txt.textContent  = name + ': ' + (d.status || '…');
      });
      window.cue.kb.addFile('default', fp).then(r => {
        window.cue.kb.clearListeners();
        resolve(r);
      });
    });

    if (!result.ok) {
      failCount++;
      const reason = (result.error || 'unknown error').replace(/^Error:\s*/i, '');
      window._kbErrors.push({ name, path: fp, error: reason, ts: Date.now() });
      // Refresh panel so the error row shows up between files
      renderKBPanel();
    } else {
      okCount++;
    }
  }

  bar.style.width = '100%';
  txt.textContent = okCount > 0
    ? `${okCount} ok` + (failCount ? ` · ${failCount} failed (see list)` : '')
    : `${failCount} failed (see list)`;

  await window.kbStore.refresh();
  renderKBPanel();

  setTimeout(() => { wrap.style.display = 'none'; }, 2400);
  if (okCount > 0 && failCount === 0) toast('Knowledge base updated', 'ok');
  else if (okCount === 0)              toast('All uploads failed', 'err');
  else                                 toast(`${okCount} indexed · ${failCount} failed`, 'warn');
}

function renderKBPanel() {
  const stats = $('kb-status-text');
  const list  = $('kb-file-list');
  if (!stats || !list) return;

  const files   = window.kbStore.files;
  const enabled = window.kbStore.enabled;
  const errors  = window._kbErrors || [];

  // Status bar
  if (files.length === 0) {
    stats.textContent = errors.length
      ? `No files indexed · ${errors.length} failed`
      : 'No files indexed';
  } else {
    const chunks = files.reduce((s, f) => s + f.chunks, 0);
    const errSuffix = errors.length ? ` · ${errors.length} failed` : '';
    stats.textContent = files.length + ' file' + (files.length>1?'s':'') + ' · ' + chunks + ' chunks' + (!enabled ? ' (disabled)' : '') + errSuffix;
  }

  // Error rows pinned at the top of the file list
  let errorHtml = '';
  if (errors.length) {
    errorHtml = errors.map((e, i) => `
      <div class="kb-file-item kb-error-row" data-err-idx="${i}">
        <span class="kb-file-icon" style="color:var(--danger)">⚠</span>
        <div class="kb-file-info" style="min-width:0;flex:1">
          <div class="kb-file-name" style="color:var(--danger)" title="${x(e.name)}">${x(e.name)}</div>
          <div class="kb-file-meta" style="color:var(--text-dim);white-space:normal;line-height:1.4">${x(e.error)}</div>
        </div>
        ${e.path ? `<button type="button" class="kb-file-retry" data-path="${x(e.path)}" data-err-idx="${i}" title="Retry">↻</button>` : ''}
        <button type="button" class="kb-file-dismiss" data-err-idx="${i}" title="Dismiss">×</button>
      </div>
    `).join('');
  }

  // File list
  if (files.length === 0 && !errors.length) {
    list.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--text-mute);text-align:center">Drop files above to build your knowledge base</div>';
    return;
  }
  if (files.length === 0) {
    list.innerHTML = errorHtml;
    bindKBErrorRows();
    return;
  }
  // fall through to render files (errorHtml prepended below)

  list.innerHTML = errorHtml + files.map(f => {
    const name    = f.source || f.file.split('/').pop();
    const icon    = window.kbStore.getIcon(name);
    const isIdxing= window.kbStore.indexing.has(f.file);
    const date    = new Date(f.addedAt).toLocaleDateString();
    return `<div class="kb-file-item ${isIdxing?'indexing':''}">
        <span class="kb-file-icon kb-file-ext">${x(icon)}</span>
      <div class="kb-file-info">
        <div class="kb-file-name" title="${x(f.file)}">${x(name)}</div>
        <div class="kb-file-meta">${f.chunks} chunks · ${date}</div>
      </div>
      <button type="button" class="kb-file-del" data-path="${x(f.file)}" title="Remove" aria-label="Remove file"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
    </div>`;
  }).join('');

  bindKBErrorRows();

  list.querySelectorAll('.kb-file-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const r = await window.kbStore.removeFile(btn.dataset.path);
      if (r.ok) { toast('Removed', 'ok'); renderKBPanel(); }
      else toast('Remove failed', 'err');
    });
  });
}


// ── Notes ─────────────────────────────────────────────────────
function bindNotes() {
  E.notesArea.addEventListener('input', () => localStorage.setItem('cue-notes', E.notesArea.value));
  $('btn-copy-notes').addEventListener('click', () => { navigator.clipboard.writeText(E.notesArea.value); toast('Copied','ok'); });
  $('btn-clear-notes').addEventListener('click', () => { E.notesArea.value=''; localStorage.setItem('cue-notes',''); });
}

// ── Models ────────────────────────────────────────────────────
function memLabel(gb) {
  if (!gb || gb <= 0) return { text: 'Remote', cls: 'mem-ok' };
  if (gb <= RAM_SAFE_GB)  return { text: gb.toFixed(1) + ' GB', cls: 'mem-ok'   };
  if (gb <= RAM_TIGHT_GB) return { text: gb.toFixed(1) + ' GB · high RAM', cls: 'mem-warn' };
  return                         { text: gb.toFixed(1) + ' GB · risk', cls: 'mem-bad'  };
}
function bindModels() {
  E.btnPull.addEventListener('click', () => doPull(E.pullInput.value.trim()));
  E.pullInput.addEventListener('keydown', ev => { if(ev.key==='Enter') doPull(E.pullInput.value.trim()); });
  document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { E.pullInput.value=c.dataset.model; doPull(c.dataset.model); }));
  E.btnUnload && E.btnUnload.addEventListener('click', async () => {
    const m = window.ollama.getModel(); if(!m){toast('No model loaded','warn');return;}
    const sel = window.ollama.models.find(x => x.name === m);
    if (sel && (sel.provider || 'ollama') !== 'ollama') { toast('Unload works only for local Ollama models', 'warn'); return; }
    await window.cue.ollama.unload(m); toast('Unloaded '+m+' from RAM','ok');
  });
}
async function renderModels() {
  await window.ollama.refresh();
  const models = window.ollama.models, cur = window.ollama.getModel();
  if (E.memWarning) {
    const sel = models.find(m=>m.name===cur);
    if (sel && (sel.provider || 'ollama') === 'ollama' && sel.size > 0) {
      const gb=sel.size/1e9, lbl=memLabel(gb);
      if(lbl.cls!=='mem-ok'){ E.memWarningText.textContent=lbl.cls==='mem-warn'?`${sel.name} — close other apps for stability`:`${sel.name} — too large, may hang`; E.memWarning.style.display='block'; E.memWarning.className='mem-warning '+lbl.cls; }
      else E.memWarning.style.display='none';
    } else E.memWarning.style.display='none';
  }
  E.modelsList.innerHTML = models.length
    ? models.map(m=>{const provider=(m.provider||'ollama');const gb=m.size?m.size/1e9:0,lbl=memLabel(gb),c=m.name===cur?' model-current':'';const canDelete=provider==='ollama';const tag=provider==='openrouter'?' <span class="agent-tag" style="display:inline-block;margin-left:6px;vertical-align:middle">OpenRouter</span>':'';const tags=Array.isArray(m.tags)&&m.tags.length?` <span class="agent-tag" style="display:inline-block;margin-left:6px;vertical-align:middle">${x(m.tags.slice(0,4).join(' · '))}</span>`:'';const files=m.supports_file_analysis?` <span class="agent-tag" style="display:inline-block;margin-left:6px;vertical-align:middle">files</span>`:'';return`<div class="model-row${c}"><span class="model-row-name">${x(m.name)}${tag}${tags}${files}</span><span class="model-row-size ${lbl.cls}">${lbl.text}</span>${canDelete?`<button class="model-del" data-name="${x(m.name)}">del</button>`:''}</div>`;}).join('')
    : '<div style="padding:8px;font-size:11px;color:var(--fg3)">No models downloaded</div>';
  E.modelsList.querySelectorAll('.model-del').forEach(btn=>btn.addEventListener('click',async()=>{const r=await window.cue.ollama.delete(btn.dataset.name);if(r.ok){toast('Deleted','ok');pollOllama();}else toast('Failed','err');}));
}
async function doPull(name) {
  if(!name)return;
  E.pullProg.style.display='flex'; E.pullBar.style.width='0%'; E.pullText.textContent='Starting...'; E.btnPull.disabled=true;
  window.cue.ollama.clearListeners();
  window.cue.ollama.onPullProgress(d=>{ const p=d.total>0?Math.round(d.completed/d.total*100):0; E.pullBar.style.width=p+'%'; E.pullText.textContent=(d.status||'Downloading')+(p?' '+p+'%':''); });
  window.cue.ollama.onPullDone(()=>{ E.pullBar.style.width='100%'; E.pullText.textContent='Done!'; E.btnPull.disabled=false; toast(name+' ready','ok'); pollOllama(); window.cue.ollama.clearListeners(); setTimeout(()=>{E.pullProg.style.display='none';},3000); });
  const r=await window.cue.ollama.pull(name); E.btnPull.disabled=false;
  if(!r.ok){ E.pullText.textContent='Error: '+r.error; toast('Pull failed','err'); }
}

// ── Listening ─────────────────────────────────────────────────
function bindListen() {
  if (E.listenPill) E.listenPill.addEventListener('click', () => toggleListen());
  if (E.bannerStop) E.bannerStop.addEventListener('click', () => stopListen());
}
async function toggleListen() {
  if (S.listening) { stopListen(); return; }
  stopDictation();
  await startListen();
}

/**
 * For meeting / system audio: try tab/screen share first, then Electron desktop loopback, then mic.
 * macOS needs Microphone + Screen Recording for full loopback; main process pre-prompts mic.
 */
async function acquireMeetingAudioStream() {
  const plat = await window.cue.getPlatform();
  const prep = await window.cue.audio.prepare();
  if (prep.mic === 'denied') {
    toast('Microphone access denied. Allow the app in System Settings → Microphone.', 'err');
    await window.cue.audio.openPrivacy('mic');
    return null;
  }
  if (plat === 'darwin' && prep.screen === 'denied') {
    toast('Screen Recording is off — allow this app to capture system/meeting audio.', 'warn');
    if (confirm('Open Screen Recording settings?')) await window.cue.audio.openPrivacy('screen');
  }

  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    s.getVideoTracks().forEach(t => t.stop());
    if (s.getAudioTracks().length) return s;
    s.getTracks().forEach(t => t.stop());
  } catch (e) {
    console.warn('[audio] getDisplayMedia', e.message);
  }

  try {
    const r = await window.cue.audio.sources();
    if (!r.ok || !r.sources.length) throw new Error(r.error || 'no desktop sources');
    const src = r.sources.find(x => String(x.id).startsWith('screen:')) || r.sources[0];
    if (!src.id) throw new Error('no source id');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id } },
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id } }
    });
    stream.getVideoTracks().forEach(t => t.stop());
    if (stream.getAudioTracks().length) return stream;
    stream.getTracks().forEach(t => t.stop());
  } catch (e) {
    console.warn('[audio] desktop loopback', e.message);
  }

  try {
    toast('Using microphone only (not system audio).', 'warn');
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    toast('Audio unavailable: ' + e.message, 'err');
    return null;
  }
}

async function startListen() {
  const stream = await acquireMeetingAudioStream();
  if (!stream) return;

  S.stream = stream;
  S.listening = true;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onresult = ev => {
      let interim = '', final = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        ev.results[i].isFinal ? (final += t) : (interim += t);
      }
      const d = (final || interim).trim();
      if (d && E.liveText) E.liveText.textContent = d;
      if (final.trim()) {
        const ch = window.chatStore.getActive();
        if (ch) (ch.meetingContext = ch.meetingContext || []).push(final.trim());
        if (isQ(final)) sendMsg('[Voice] ' + final.trim());
      }
    };
    rec.onerror = ev => { if (!['no-speech', 'aborted'].includes(ev.error)) console.warn('SR:', ev.error); };
    rec.onend = () => { if (S.listening) { try { rec.start(); } catch (_) {} } };
    rec.start();
    S.recog = rec;
  } else {
    toast('Speech recognition unavailable in this environment', 'warn');
  }
  if (E.listenPill) E.listenPill.classList.add('active');
  if (E.listenLabel) E.listenLabel.textContent = 'Listening...';
  if (E.listenBanner) E.listenBanner.style.display = 'flex';
  if (E.liveText) E.liveText.textContent = 'Waiting for speech...';
  toast('Listening', 'ok');
}
function stopListen() {
  S.listening = false;
  if (S.recog) { try { S.recog.stop(); } catch (_) {} S.recog = null; }
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
  if (E.listenPill) E.listenPill.classList.remove('active');
  if (E.listenLabel) E.listenLabel.textContent = 'Start Listening';
  if (E.listenBanner) E.listenBanner.style.display = 'none';
  toast('Stopped', 'warn');
}
function isQ(t) {
  const s = t.trim().toLowerCase();
  return s.endsWith('?') || ['what ', 'how ', 'why ', 'when ', 'where ', 'who ', 'which ', 'can you', 'could you', 'tell me', 'explain ', 'describe ', 'define ', 'compare ', 'walk me', 'design '].some(p => s.startsWith(p));
}

// ── Dictation (type message by voice) — uses mic; separate from meeting Listen
function bindDictation() {
  if (!E.btnDictate) return;
  E.btnDictate.addEventListener('click', () => toggleDictation());
}
async function toggleDictation() {
  if (S.dictating) { stopDictation(); return; }
  if (S.listening) stopListen();
  const prep = await window.cue.audio.prepare();
  if (prep.mic === 'denied') {
    toast('Microphone denied. Allow the app in System Settings → Microphone.', 'err');
    await window.cue.audio.openPrivacy('mic');
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Speech-to-text is unavailable in this runtime. Try restarting app and re-allowing Microphone permission.', 'err'); return; }
  S.dictationBase = E.chatInput.value;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';
  rec.onresult = ev => {
    if (!S.dictating) return;
    let line = '';
    for (let i = 0; i < ev.results.length; i++) line += ev.results[i][0].transcript;
    const base = S.dictationBase;
    const sep = base && !base.endsWith(' ') && line.length ? ' ' : '';
    E.chatInput.value = base + sep + line;
    E.chatInput.dispatchEvent(new Event('input'));
  };
  rec.onerror = ev => {
    if (!['no-speech', 'aborted'].includes(ev.error)) {
      console.warn('Dictation:', ev.error);
      if (ev.error === 'not-allowed') {
        toast('Dictation blocked — allow microphone', 'err');
        stopDictation();
      }
    }
  };
  rec.onend = () => {
    if (!S.dictating) return;
    S.dictationBase = E.chatInput.value;
    try { rec.start(); } catch (_) {}
  };
  S.dictating = true;
  S.dictateRec = rec;
  E.btnDictate.classList.add('active');
  try { rec.start(); } catch (e) {
    S.dictating = false;
    S.dictateRec = null;
    E.btnDictate.classList.remove('active');
    toast('Dictation failed: ' + e.message, 'err');
    return;
  }
  toast('Dictation on — speak to type', 'ok');
}
function stopDictation() {
  if (!S.dictating && !S.dictateRec) return;
  S.dictating = false;
  if (S.dictateRec) { try { S.dictateRec.stop(); } catch (_) {} S.dictateRec = null; }
  if (E.btnDictate) E.btnDictate.classList.remove('active');
}

// ── Markdown ──────────────────────────────────────────────────
const LANG_META = {
  javascript: { label: 'JavaScript', icon: 'JS', cls: 'lang-javascript' },
  js:         { label: 'JavaScript', icon: 'JS', cls: 'lang-javascript' },
  python:     { label: 'Python', icon: 'PY', cls: 'lang-python' },
  py:         { label: 'Python', icon: 'PY', cls: 'lang-python' },
  sql:        { label: 'SQL', icon: 'SQL', cls: 'lang-sql' },
  mysql:      { label: 'SQL', icon: 'SQL', cls: 'lang-sql' },
  postgresql: { label: 'SQL', icon: 'SQL', cls: 'lang-sql' },
  postgres:   { label: 'SQL', icon: 'SQL', cls: 'lang-sql' },
  mongodb:    { label: 'MongoDB', icon: 'MG', cls: 'lang-mongodb' },
  mongo:      { label: 'MongoDB', icon: 'MG', cls: 'lang-mongodb' },
  bson:       { label: 'MongoDB', icon: 'MG', cls: 'lang-mongodb' },
  mermaid:    { label: 'Mermaid', icon: 'MM', cls: 'lang-mermaid' },
  typescript: { label: 'TypeScript', icon: 'TS', cls: 'lang-typescript' },
  ts:         { label: 'TypeScript', icon: 'TS', cls: 'lang-typescript' },
  java:       { label: 'Java', icon: 'JV', cls: 'lang-java' },
};

function getLangMeta(lang) {
  return LANG_META[lang] || { label: lang || 'Code', icon: '◈', cls: 'lang-default' };
}

let _copyTimer = null;
function copyCode(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'copied';
    btn.classList.add('copied');
    clearTimeout(_copyTimer);
    _copyTimer = setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1800);
  }).catch(() => {});
}

function inlineMd(text) {
  const codeSpans = [];
  const tokenized = String(text).replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = codeSpans.length;
    codeSpans.push(code);
    return '\x00I' + idx + '\x00';
  });

  let out = x(tokenized);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  out = out.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  out = out.replace(/\x00I(\d+)\x00/g, (_, i) => `<code>${x(codeSpans[parseInt(i, 10)])}</code>`);
  return out;
}

function render(text, isStreaming) {
  if (!text) return '';
  const blocks = [];
  let out = text.replace(/```(\w*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = blocks.length;
    blocks.push({ lang: lang.trim().toLowerCase(), code: code.trim() });
    return '\x00B'+idx+'\x00';
  });
  const lines = out.split(/\r?\n/);
  const html = [];
  let para = [];
  let listType = null; // 'ul' | 'ol'
  let listItems = [];
  let quoteLines = [];
  let tableRows = [];

  const flushPara = () => {
    if (!para.length) return;
    html.push('<p>' + inlineMd(para.join('<br>')) + '</p>');
    para = [];
  };
  const flushList = () => {
    if (!listType || !listItems.length) return;
    html.push('<' + listType + '>' + listItems.map(item => '<li>' + inlineMd(item) + '</li>').join('') + '</' + listType + '>');
    listType = null;
    listItems = [];
  };
  const flushQuote = () => {
    if (!quoteLines.length) return;
    html.push('<blockquote><p>' + inlineMd(quoteLines.join('<br>')) + '</p></blockquote>');
    quoteLines = [];
  };
  const flushTable = () => {
    if (!tableRows.length) return;
    const rows = tableRows.map(r => r.trim()).filter(Boolean);
    if (rows.length < 2) { rows.forEach(r => html.push('<p>' + inlineMd(r) + '</p>')); tableRows = []; return; }
    const sep = rows[1].replace(/\|/g, '').trim();
    if (!/^:?-{3,}:?(?:\s*:?-{3,}:?)*$/.test(sep.replace(/\s+/g, ' '))) {
      rows.forEach(r => html.push('<p>' + inlineMd(r) + '</p>'));
      tableRows = [];
      return;
    }
    const cells = row => row.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const head = cells(rows[0]);
    const bodyRows = rows.slice(2).map(cells);
    let t = '<table><thead><tr>' + head.map(c => '<th>' + inlineMd(c) + '</th>').join('') + '</tr></thead><tbody>';
    t += bodyRows.map(r => '<tr>' + r.map(c => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>').join('');
    t += '</tbody></table>';
    html.push(t);
    tableRows = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const blockOnly = line.match(/^\x00B(\d+)\x00$/);
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    const hr = line.match(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/);
    const tableLike = /^\s*\|.*\|\s*$/.test(line);

    if (blockOnly) {
      flushPara();
      flushList();
      flushQuote();
      flushTable();
      html.push(line);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      flushQuote();
      flushTable();
      continue;
    }
    if (tableLike) {
      flushPara();
      flushList();
      flushQuote();
      tableRows.push(line);
      continue;
    }
    flushTable();
    if (hr) {
      flushPara();
      flushList();
      flushQuote();
      html.push('<hr>');
      continue;
    }
    if (quote) {
      flushPara();
      flushList();
      quoteLines.push(quote[1]);
      continue;
    }
    flushQuote();
    if (h) {
      flushPara();
      flushList();
      const level = Math.min(6, h[1].length);
      html.push('<h' + level + '>' + inlineMd(h[2]) + '</h' + level + '>');
      continue;
    }
    if (ul || ol) {
      flushPara();
      const nextType = ul ? 'ul' : 'ol';
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((ul || ol)[1]);
      continue;
    }
    flushList();
    para.push(line.trim());
  }

  flushPara();
  flushList();
  flushQuote();
  flushTable();
  out = html.join('');
  out = out.replace(/\x00B(\d+)\x00/g, (_,i) => {
    const b = blocks[parseInt(i)];
    const meta = getLangMeta(b.lang);
    const safeCode = x(b.code);
    const copyId = 'cp-' + Math.random().toString(36).slice(2,9);
    if (b.lang === 'mermaid') {
      const canvasId = 'mm-' + Math.random().toString(36).slice(2,9);
      // Always wrap in mermaid container; renderMermaid() will try to render it
      return `<div class="code-block ${meta.cls}"><div class="code-header"><span class="lang-label"><span class="lang-icon">${meta.icon}</span>${meta.label}</span><div class="code-actions"><button type="button" class="copy-btn" id="${copyId}" data-code="${safeCode.replace(/"/g,'&quot;')}">copy</button></div></div><div class="mermaid-wrap"><div class="mermaid-toolbar"><button type="button" class="diagram-btn" data-diagram-canvas="${canvasId}" data-diagram-delta="-0.1">−</button><span class="diagram-zoom" data-zoom-for="${canvasId}">100%</span><button type="button" class="diagram-btn" data-diagram-canvas="${canvasId}" data-diagram-delta="0.1">+</button><button type="button" class="diagram-btn" data-diagram-canvas="${canvasId}" data-diagram-action="reset">reset</button></div><div class="mermaid-canvas" id="${canvasId}" data-zoom="1"><div class="mermaid">${b.code}</div></div></div></div>`;
    }
    return `<div class="code-block ${meta.cls}"><div class="code-header"><span class="lang-label"><span class="lang-icon">${meta.icon}</span>${meta.label}</span><button type="button" class="copy-btn" id="${copyId}" data-code="${safeCode.replace(/"/g,'&quot;')}">copy</button></div><pre><code>${safeCode}</code></pre></div>`;
  });
  return out;
}

function x(s) { const d=document.createElement('div'); d.textContent=String(s); return d.innerHTML; }
function dots(){ return '<div class="typing-dots"><span></span><span></span><span></span></div>'; }

function clampDiagramZoom(v) {
  return Math.min(2.5, Math.max(0.5, v));
}

function setDiagramZoom(canvasId, zoom) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const next = clampDiagramZoom(Number(zoom) || 1);
  canvas.dataset.zoom = String(next);
  const svg = canvas.querySelector('svg');
  if (svg) svg.style.transform = `scale(${next})`;
  const lbl = document.querySelector(`.diagram-zoom[data-zoom-for="${canvasId}"]`);
  if (lbl) lbl.textContent = Math.round(next * 100) + '%';
}

function zoomDiagram(canvasId, delta) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const cur = Number(canvas.dataset.zoom || '1');
  setDiagramZoom(canvasId, cur + delta);
}

window.setDiagramZoom = setDiagramZoom;
window.zoomDiagram = zoomDiagram;

/** Code copy + mermaid zoom buttons (no inline onclick — works under CSP) */
function bindMessageBubbleActions() {
  if (!E.messages) return;
  E.messages.addEventListener('click', ev => {
    const copyBtn = ev.target.closest('.copy-btn');
    if (copyBtn && copyBtn.hasAttribute('data-code')) {
      ev.preventDefault();
      const raw = copyBtn.getAttribute('data-code') || '';
      copyCode(copyBtn, raw.replace(/&quot;/g, '"'));
      return;
    }
    const dBtn = ev.target.closest('.diagram-btn');
    if (dBtn && dBtn.dataset.diagramCanvas) {
      ev.preventDefault();
      const cid = dBtn.dataset.diagramCanvas;
      if (dBtn.dataset.diagramAction === 'reset') setDiagramZoom(cid, 1);
      else if (dBtn.dataset.diagramDelta !== undefined) zoomDiagram(cid, parseFloat(dBtn.dataset.diagramDelta));
    }
  });
}

function bindDiagramControls(container) {
  const canvas = container.querySelector('.mermaid-canvas');
  if (!canvas || canvas.dataset.bound) return;
  canvas.dataset.bound = '1';
  canvas.addEventListener('wheel', ev => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    const d = ev.deltaY > 0 ? -0.06 : 0.06;
    zoomDiagram(canvas.id, d);
  }, { passive: false });
}

function renderMermaid() {
  document.querySelectorAll('.mermaid:not([data-rendered])').forEach((el,i)=>{
    const def=el.textContent.trim(); if(!def) return;
    el.dataset.rendered='1';
    el.innerHTML=''; el.style.minHeight='60px';
    mermaid.render('mg'+Date.now()+i, def)
      .then(({svg})=>{
        el.innerHTML=svg; el.style.minHeight='';
        const s=el.querySelector('svg');
        if(s){
          s.removeAttribute('height');
          s.style.maxWidth='none';
          s.style.transformOrigin='top left';
        }
        const wrap = el.closest('.mermaid-wrap');
        if (wrap) bindDiagramControls(wrap);
        const canvas = el.closest('.mermaid-canvas');
        if (canvas) setDiagramZoom(canvas.id, Number(canvas.dataset.zoom || '1'));
      })
      .catch(err=>{
        // If streaming, just leave blank (will retry next frame)
        if (S.busy) { delete el.dataset.rendered; return; }
        el.innerHTML=`<pre style="font-size:10px;color:var(--red);white-space:pre-wrap">Diagram error:\n${x(err.message)}\n\n${x(def)}</pre>`;
        el.style.minHeight='';
      });
  });
}

// ── Toast ─────────────────────────────────────────────────────
function toast(msg, type) {
  const el=document.createElement('div');
  const c={ok:'var(--green)',err:'var(--red)',warn:'var(--accent)'}[type]||'var(--fg3)';
  el.style.cssText=`position:fixed;bottom:14px;right:14px;background:var(--bg2);border:1px solid var(--border2);border-left:3px solid ${c};border-radius:8px;padding:8px 14px;font-size:11px;color:var(--fg);z-index:9999;pointer-events:none;max-width:280px;`;
  el.textContent=msg; document.body.appendChild(el); setTimeout(()=>el.remove(),2800);
}
window.showToast = toast;

// ── Helpers ───────────────────────────────────────────────────
function timeAgo(ts) {
  const s = Math.floor((Date.now()-ts)/1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s/60)+'m';
  if (s < 86400) return Math.floor(s/3600)+'h';
  return Math.floor(s/86400)+'d';
}

// ═══════════════════════════════════════════════════════════════════
// KB error row bindings (retry + dismiss)
// ═══════════════════════════════════════════════════════════════════
function bindKBErrorRows() {
  document.querySelectorAll('.kb-file-dismiss').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const idx = parseInt(btn.dataset.errIdx, 10);
      if (Number.isInteger(idx)) {
        window._kbErrors.splice(idx, 1);
        renderKBPanel();
      }
    });
  });
  document.querySelectorAll('.kb-file-retry').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const fp = btn.dataset.path;
      const idx = parseInt(btn.dataset.errIdx, 10);
      if (!fp) return;
      // Remove this error and retry the single file
      if (Number.isInteger(idx)) window._kbErrors.splice(idx, 1);
      renderKBPanel();
      await ingestFiles([fp]);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// Cluely-style pickers — agent, model, layout
// ═══════════════════════════════════════════════════════════════════

const AGENT_TEMPLATES = [
  { slug: 'auto',      icon: '⌨', name: 'Auto',       desc: 'Smart-detect from screen + audio context. Branches into the right specialist.', model: 'claude-3.5-sonnet', hotkey: '⌘1' },
  { slug: 'coding',    icon: '⌘', name: 'Coding',     desc: 'Technical problems. Code first, no preamble. Comments on every non-trivial line.', model: 'claude-3.5-sonnet', hotkey: '⌘2' },
  { slug: 'meeting',   icon: '○', name: 'Meeting',    desc: 'Meeting co-pilot. Real-time suggestions, follow-ups, recaps.', model: 'gpt-4o', hotkey: '⌘3' },
  { slug: 'interview', icon: '▴', name: 'Interview',  desc: 'Live interview co-pilot. Behavioral, coding, system-design — answers in the right shape.', model: 'claude-3.5-sonnet', hotkey: '⌘4' },
  { slug: 'sales',     icon: '$', name: 'Sales',      desc: 'MEDDPICC nudges, next questions, what not to say.', model: 'gpt-4o-mini', hotkey: '⌘5' },
  { slug: 'email',     icon: '✉', name: 'Email',      desc: 'Draft messages. Returns ready-to-send content in a code block.', model: 'gpt-4o-mini', hotkey: '⌘6' },
  { slug: 'writing',   icon: '✎', name: 'Writing',    desc: 'Longer-form content: blog posts, docs, proposals.', model: 'claude-3.5-sonnet', hotkey: '⌘7' },
  { slug: 'research',  icon: '⌕', name: 'Research',   desc: 'Explore a topic, summarize sources, surface what matters.', model: 'claude-3.5-sonnet', hotkey: '⌘8' },
  { slug: 'math',      icon: '∑', name: 'Math',       desc: 'Step-by-step. LaTeX rendering. Confident answer first.', model: 'claude-3.5-sonnet', hotkey: '⌘9' },
  { slug: 'custom',    icon: '+', name: 'Custom',     desc: 'Blank starting template. Edit the system prompt to make it yours.', model: 'gpt-4o-mini', hotkey: '' },
];

const $$ = (id) => document.getElementById(id);

// Generic popover machinery — close on outside click, close on Esc
function _openPopover(id, anchor) {
  document.querySelectorAll('.popover').forEach(p => { if (p.id !== id) p.style.display = 'none'; });
  document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  const el = $$(id);
  if (!el) return;
  el.style.display = 'flex';
  if (anchor) anchor.classList.add('active');

  const onDoc = (ev) => {
    if (!el.contains(ev.target) && !(anchor && anchor.contains(ev.target))) {
      el.style.display = 'none';
      if (anchor) anchor.classList.remove('active');
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    }
  };
  const onEsc = (ev) => {
    if (ev.key === 'Escape') {
      el.style.display = 'none';
      if (anchor) anchor.classList.remove('active');
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    }
  };
  // Defer registration so the click that opens it doesn't immediately close
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
  }, 0);
}

function _closePopovers() {
  document.querySelectorAll('.popover').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
}

// ── Agent picker ───────────────────────────────────────────────
function bindAgentPicker() {
  const pill = $$('agent-pill');
  const picker = $$('agent-picker');
  const list = $$('agent-list');
  if (!pill || !picker || !list) return;

  function renderList() {
    const current = E.agentSel.value || 'auto';
    list.innerHTML = AGENT_TEMPLATES.map(a => `
      <div class="agent-row ${a.slug === current ? 'selected' : ''}" data-agent="${a.slug}">
        <span class="agent-glyph">${a.icon}</span>
        <span class="agent-info">
          <span class="agent-name">${a.name}</span>
          <span class="agent-desc">${a.desc}</span>
        </span>
        <span class="agent-meta">
          ${a.model.split('/').pop()}
          ${a.hotkey ? `<br><span class="agent-key">${a.hotkey}</span>` : ''}
        </span>
      </div>
    `).join('');
    list.querySelectorAll('.agent-row').forEach(row => {
      row.addEventListener('click', () => {
        const slug = row.dataset.agent;
        selectAgent(slug);
        _closePopovers();
      });
    });
  }

  function syncPill() {
    const current = E.agentSel.value || 'auto';
    const a = AGENT_TEMPLATES.find(x => x.slug === current) || AGENT_TEMPLATES[0];
    $$('agent-pill-icon').textContent = a.icon;
    $$('agent-pill-text').textContent = a.name;
  }

  function selectAgent(slug) {
    E.agentSel.value = slug;
    E.agentSel.dispatchEvent(new Event('change'));
    syncPill();
  }

  pill.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (picker.style.display === 'flex') {
      _closePopovers();
    } else {
      renderList();
      _openPopover('agent-picker', pill);
    }
  });

  // Keep pill in sync if agent changes elsewhere (loadChat, settings save)
  E.agentSel.addEventListener('change', syncPill);
  syncPill();

  // Hotkeys ⌘1..⌘9 for first 9 agents
  document.addEventListener('keydown', (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.shiftKey || ev.altKey) return;
    const n = parseInt(ev.key, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      const target = AGENT_TEMPLATES[n - 1];
      if (target) {
        ev.preventDefault();
        selectAgent(target.slug);
        showToast(`Template → ${target.name}`);
      }
    }
  });
}

// ── Model picker ───────────────────────────────────────────────
const POPULAR_OPENROUTER_MODELS = [
  { id: 'anthropic/claude-3.5-sonnet', tag: 'flagship' },
  { id: 'anthropic/claude-3.5-haiku',  tag: 'fast' },
  { id: 'openai/gpt-4o',                tag: 'flagship' },
  { id: 'openai/gpt-4o-mini',           tag: 'cheap' },
  { id: 'openai/o1-mini',               tag: 'reasoning' },
  { id: 'google/gemini-2.0-flash-001',  tag: 'fast' },
  { id: 'meta-llama/llama-3.1-8b-instruct:free',   tag: 'free' },
  { id: 'mistralai/mistral-7b-instruct:free',      tag: 'free' },
  { id: 'qwen/qwen-2.5-coder-32b-instruct',        tag: 'coding' },
  { id: 'deepseek/deepseek-chat',                  tag: 'cheap' },
];

function bindModelPicker() {
  const pill = $$('model-pill');
  const picker = $$('model-picker');
  if (!pill || !picker) return;

  const orList = $$('openrouter-list');
  const olList = $$('ollama-list');
  const orCount = $$('or-count');
  const olCount = $$('ol-count');
  const search = $$('model-search');

  let cachedOR = POPULAR_OPENROUTER_MODELS;
  let cachedOL = [];

  // Strip the `openrouter/` routing prefix for display only
  function _displayName(value) {
    if (!value) return 'no model';
    const stripped = value.replace(/^openrouter\//, '');
    // For namespaced ids, show the last segment for compactness
    return stripped.length > 28 ? stripped.split('/').pop() : stripped;
  }

  function syncPill() {
    const m = window.ollama.getModel() || E.modelSel.value;
    const text = $$('model-pill-text');
    if (m) {
      text.textContent = _displayName(m);
      pill.classList.add('online');
    } else {
      const def = AGENT_TEMPLATES.find(a => a.slug === (E.agentSel.value || 'auto'));
      text.textContent = def ? def.model : 'no model';
      pill.classList.remove('online');
    }
  }

  // For OpenRouter models we MUST prefix `openrouter/` so main.js routes the
  // chat to OpenRouter (see main.js: `model.startsWith('openrouter/')`).
  // For Ollama models the raw tag is used as-is.
  function pickModel(rawId, source) {
    const finalId = source === 'openrouter' ? `openrouter/${rawId}` : rawId;
    // Update both the hidden compat <select> AND the canonical client state
    E.modelSel.value = finalId;
    if (window.ollama && window.ollama.setModel) window.ollama.setModel(finalId);
    E.modelSel.dispatchEvent(new Event('change'));
    syncPill();
    _closePopovers();
    showToast(`Model → ${_displayName(finalId)}`);
  }

  function render(filter = '') {
    const f = filter.toLowerCase();
    const cur = window.ollama.getModel() || E.modelSel.value;

    const orItems = cachedOR.filter(m => m.id.toLowerCase().includes(f));
    orCount.textContent = orItems.length;
    orList.innerHTML = orItems.length === 0
      ? `<div class="model-row empty">no matches</div>`
      : orItems.map(m => `
        <div class="model-row ${`openrouter/${m.id}` === cur ? 'selected' : ''}" data-model="${m.id}" data-source="openrouter">
          <span class="model-name">${m.id}</span>
          <span class="model-tag ${m.tag === 'free' ? 'model-free' : ''}">${m.tag}</span>
        </div>`).join('');

    const olItems = cachedOL.filter(m => m.toLowerCase().includes(f));
    olCount.textContent = olItems.length;
    if (olItems.length === 0 && cachedOL.length === 0) {
      olList.innerHTML = `<div class="model-row empty">ollama not running · run \`ollama serve\`</div>`;
    } else if (olItems.length === 0) {
      olList.innerHTML = `<div class="model-row empty">no matches</div>`;
    } else {
      olList.innerHTML = olItems.map(m => `
        <div class="model-row ${m === cur ? 'selected' : ''}" data-model="${m}" data-source="ollama">
          <span class="model-name">${m}</span>
          <span class="model-tag">local</span>
        </div>`).join('');
    }

    [...orList.querySelectorAll('.model-row[data-model]'),
     ...olList.querySelectorAll('.model-row[data-model]')].forEach(row => {
      row.addEventListener('click', () => pickModel(row.dataset.model, row.dataset.source));
    });
  }

  // Pull live Ollama tags + add any openrouter:free models main.js already enumerates
  async function refreshLists() {
    try {
      const r = await window.cue.ollama.models();
      if (r && r.ok && Array.isArray(r.models)) {
        // Local Ollama (no `openrouter/` prefix)
        cachedOL = r.models
          .filter(m => !String(m.name || '').startsWith('openrouter/'))
          .map(m => m.name);
        // Free OpenRouter routes already enumerated by main.js — strip prefix and merge
        // with the popular hardcoded list, dedupe by id
        const fromMain = r.models
          .filter(m => String(m.name || '').startsWith('openrouter/'))
          .map(m => ({ id: m.name.replace(/^openrouter\//, ''), tag: 'free' }));
        const merged = [...POPULAR_OPENROUTER_MODELS];
        for (const x of fromMain) {
          if (!merged.find(y => y.id === x.id)) merged.push(x);
        }
        cachedOR = merged;
      }
    } catch (_) { /* keep cached defaults */ }
  }

  pill.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (picker.style.display === 'flex') {
      _closePopovers();
    } else {
      await refreshLists();
      render(search.value || '');
      _openPopover('model-picker', pill);
      setTimeout(() => search.focus(), 30);
    }
  });

  search.addEventListener('input', () => render(search.value));
  search.addEventListener('click', (ev) => ev.stopPropagation());

  // Sync pill when other code changes the model
  E.modelSel.addEventListener('change', syncPill);
  E.agentSel.addEventListener('change', syncPill);
  syncPill();
}

// ── Layout picker ──────────────────────────────────────────────
const LAYOUTS = {
  compact:  { width: 420, height: 540 },
  standard: { width: 620, height: 680 },
  expanded: { width: 920, height: 720 },
};

function applyLayout(layout) {
  const dims = LAYOUTS[layout] || LAYOUTS.compact;
  if (window.cue.win.resize) {
    window.cue.win.resize(dims.width, dims.height);
  }
  localStorage.setItem('cue-layout', layout);
  document.documentElement.dataset.layout = layout;
  // Auto-open sidebar in standard/expanded
  if (layout !== 'compact' && E.sidebar && !E.sidebar.classList.contains('open')) {
    E.sidebar.classList.add('open');
  }
  // Close sidebar in compact
  if (layout === 'compact' && E.sidebar) {
    E.sidebar.classList.remove('open');
  }
  // Mark active option
  document.querySelectorAll('.layout-option').forEach(b => {
    b.classList.toggle('active', b.dataset.layout === layout);
  });
  showToast(`Layout → ${layout}`);
}

function bindLayoutPicker() {
  const btn = $$('btn-layout');
  const picker = $$('layout-picker');
  if (!btn || !picker) return;
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (picker.style.display === 'flex') {
      _closePopovers();
    } else {
      const cur = localStorage.getItem('cue-layout') || 'compact';
      document.querySelectorAll('.layout-option').forEach(b => {
        b.classList.toggle('active', b.dataset.layout === cur);
      });
      _openPopover('layout-picker', btn);
    }
  });
  picker.querySelectorAll('.layout-option').forEach(opt => {
    opt.addEventListener('click', () => {
      applyLayout(opt.dataset.layout);
      _closePopovers();
    });
  });
  // Restore saved layout
  const saved = localStorage.getItem('cue-layout');
  if (saved && saved !== 'compact') applyLayout(saved);
}

function bindLayoutHotkeys() {
  document.addEventListener('keydown', (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.shiftKey || ev.altKey) return;
    if (ev.key === '0') { ev.preventDefault(); applyLayout('compact'); }
    if (ev.key === '9') { ev.preventDefault(); applyLayout('standard'); }
    if (ev.key === '8') { ev.preventDefault(); applyLayout('expanded'); }
  });
}

// ── Toast helper ───────────────────────────────────────────────
let _toastTimer;
function showToast(text, type = '') {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = text;
  document.body.appendChild(el);
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.remove(), 2400);
}

// ═══════════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════════
if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
else init();
