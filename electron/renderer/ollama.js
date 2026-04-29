// Renderer-side Ollama client — all calls via IPC (Node http in main, no CORS)
class OllamaClient {
  constructor() {
    this.model     = localStorage.getItem('cue-model') || '';
    this.connected = false;
    this.models    = [];
  }

  setModel(name) {
    this.model = name;
    localStorage.setItem('cue-model', name);
  }
  getModel() { return this.model; }

  async refresh() {
    try {
      const r = await window.cue.ollama.models();
      if (!r.ok) { this.connected = false; this.models = []; return false; }
      this.connected = true;
      this.models    = r.models || [];
      const routerDefault = 'openrouter/openrouter/free';
      const hasCurrent = this.model && this.models.some(m => m.name === this.model);

      // Auto-select defaults:
      // 1) OpenRouter free router (if present)
      // 2) First available model
      if (!hasCurrent) {
        const preferred = this.models.find(m => m.name === routerDefault) || this.models[0];
        if (preferred) this.setModel(preferred.name);
      }
      return true;
    } catch (_) {
      this.connected = false;
      this.models    = [];
      return false;
    }
  }

  // Stream a chat response.
  // Returns a Promise that resolves when the stream is complete.
  chat(messages, onChunk, onDone, onError, opts = {}) {
    return new Promise(resolve => {
      // Always clear listeners before registering new ones
      window.cue.ollama.clearListeners();

      window.cue.ollama.onChunk(c => { if (onChunk) onChunk(c); });
      window.cue.ollama.onDone(() => {
        window.cue.ollama.clearListeners();
        if (onDone) onDone();
        resolve();
      });
      window.cue.ollama.onError(e => {
        window.cue.ollama.clearListeners();
        if (onError) onError(e);
        resolve();
      });

      window.cue.ollama.chat(this.model, messages, opts).then(r => {
        if (r && !r.ok && r.error) {
          window.cue.ollama.clearListeners();
          if (onError) onError(r.error);
          resolve();
        }
      });
    });
  }
}

window.ollama = new OllamaClient();
