const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cue', {
  ollama: {
    models:   ()          => ipcRenderer.invoke('ollama:models'),
    chat:     (m, msgs, opts)   => ipcRenderer.invoke('ollama:chat', { model: m, messages: msgs, opts: opts || {} }),
    cancel:   ()          => ipcRenderer.invoke('ollama:cancel'),
    pull:     (name)      => ipcRenderer.invoke('ollama:pull', { name }),
    delete:   (name)      => ipcRenderer.invoke('ollama:delete', { name }),
    unload:   (name)      => ipcRenderer.invoke('ollama:unload', { name }),
    profile:  (name)      => ipcRenderer.invoke('ollama:profile', { name }),

    // Event subscriptions — always add, never stack
    onChunk:  (cb) => ipcRenderer.on('chat:chunk',     (_, d) => cb(d)),
    onDone:   (cb) => ipcRenderer.on('chat:done',      ()     => cb()),
    onError:  (cb) => ipcRenderer.on('chat:error',     (_, e) => cb(e)),
    onPullProgress: (cb) => ipcRenderer.on('pull:progress', (_, d) => cb(d)),
    onPullDone:     (cb) => ipcRenderer.on('pull:done',     (_, d) => cb(d)),

    // Must call before each new chat to avoid stacking listeners
    clearListeners: () => {
      ['chat:chunk','chat:done','chat:error','pull:progress','pull:done']
        .forEach(ch => ipcRenderer.removeAllListeners(ch));
    }
  },
  win: {
    minimize: ()    => ipcRenderer.invoke('win:minimize'),
    hide:     ()    => ipcRenderer.invoke('win:hide'),
    pin:      (on)  => ipcRenderer.invoke('win:pin', on),
    ghost:    ()    => ipcRenderer.invoke('win:ghost'),
    resize:   (w, h) => ipcRenderer.invoke('win:resize', { width: w, height: h })
  },
  audio: {
    sources:   () => ipcRenderer.invoke('audio:sources'),
    prepare:   () => ipcRenderer.invoke('audio:prepare'),
    openPrivacy: (tab) => ipcRenderer.invoke('audio:open-privacy', { tab })
  },
  pickResume:   ()         => ipcRenderer.invoke('pick:resume'),
  parseResume:  (p) => ipcRenderer.invoke('parse:resume', typeof p === 'string' ? { filePath: p } : p),
  parseAttachment: (p) => ipcRenderer.invoke('parse:attachment', p || {}),
  getPlatform: ()  => ipcRenderer.invoke('get:platform'),
  onListen: (cb) => ipcRenderer.on('shortcut:listen', () => cb()),

  kb: {
    pickFiles:  ()                    => ipcRenderer.invoke('kb:pick-files'),
    addFile:    (kbId, filePath)      => ipcRenderer.invoke('kb:add-file',    { kbId, filePath }),
    query:      (kbId, query, topK)   => ipcRenderer.invoke('kb:query',       { kbId, query, topK }),
    removeFile: (kbId, filePath)      => ipcRenderer.invoke('kb:remove-file', { kbId, filePath }),
    listFiles:  (kbId)                => ipcRenderer.invoke('kb:list-files',  { kbId }),
    getStats:   (kbId)                => ipcRenderer.invoke('kb:get-stats',   { kbId }),
    delete:     (kbId)                => ipcRenderer.invoke('kb:delete',      { kbId }),
    onProgress: (cb)  => ipcRenderer.on('kb:progress', (_, d) => cb(d)),
    clearListeners: () => ipcRenderer.removeAllListeners('kb:progress')
  }
});
