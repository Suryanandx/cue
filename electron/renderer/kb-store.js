/**
 * kb-store.js — renderer-side KB state manager
 * Manages file metadata and KB enable/disable state in the UI.
 * Actual embedding / vector search happens in main process via IPC.
 */

const KB_ID = 'default';   // single shared KB for all chats

class KBStore {
  constructor() {
    this.enabled  = localStorage.getItem('cue-kb-enabled') !== 'false';
    this.files    = [];         // populated on init from main
    this.indexing = new Set();  // file paths currently being indexed
  }

  async init(onUpdate) {
    this._onUpdate = onUpdate;
    await this.refresh();
  }

  async refresh() {
    const r = await window.cue.kb.listFiles(KB_ID);
    if (r.ok) {
      this.files = r.files || [];
      if (this._onUpdate) this._onUpdate();
    }
  }

  async addFiles(filePaths, onFileProgress) {
    for (const fp of filePaths) {
      this.indexing.add(fp);
      if (this._onUpdate) this._onUpdate();

      window.cue.kb.clearListeners();
      window.cue.kb.onProgress(d => {
        if (d.filePath === fp && onFileProgress) {
          onFileProgress(fp, d.pct, d.status);
        }
      });

      const r = await window.cue.kb.addFile(KB_ID, fp);
      this.indexing.delete(fp);
      window.cue.kb.clearListeners();

      if (!r.ok) {
        if (this._onUpdate) this._onUpdate(fp, r.error);
      }
    }
    await this.refresh();
  }

  async removeFile(filePath) {
    const r = await window.cue.kb.removeFile(KB_ID, filePath);
    if (r.ok) await this.refresh();
    return r;
  }

  async query(queryText) {
    if (!this.enabled || this.files.length === 0) return '';
    const r = await window.cue.kb.query(KB_ID, queryText, 5);
    return r.ok ? (r.context || '') : '';
  }

  setEnabled(val) {
    this.enabled = val;
    localStorage.setItem('cue-kb-enabled', val ? 'true' : 'false');
  }

  getIcon(filename) {
    const raw = (filename.split('.').pop() || '').toUpperCase();
    const label = raw === 'JPEG' ? 'JPG' : raw;
    return (label || 'FILE').slice(0, 4);
  }

  hasFiles() { return this.files.length > 0 && this.enabled; }
}

window.kbStore = new KBStore();
