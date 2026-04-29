class ResumeManager {
  constructor() {
    this.text     = localStorage.getItem('cue-resume') || '';
    this.fileName = localStorage.getItem('cue-resume-name') || '';
    this.analysis = null;
    try {
      const raw = localStorage.getItem('cue-resume-analysis');
      if (raw) this.analysis = JSON.parse(raw);
    } catch (_) {}
  }

  init() {
    this._bindUpload();
    if (this.text) {
      this._showLoaded();
      if (this.analysis) this._renderAnalysis(this.analysis);
    }
  }

  _bindUpload() {
    const zone      = document.getElementById('upload-zone');
    const fileIn    = document.getElementById('resume-file');
    const removeBtn = document.getElementById('btn-remove-resume');
    const textArea  = document.getElementById('resume-text');

    zone.addEventListener('click', () => fileIn.click());
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) this._handleFile(e.dataTransfer.files[0]);
    });
    fileIn.addEventListener('change', e => {
      if (e.target.files[0]) this._handleFile(e.target.files[0]);
    });
    removeBtn.addEventListener('click', () => this._clear());
    textArea.addEventListener('input', e => {
      this.text = e.target.value;
      localStorage.setItem('cue-resume', this.text);
    });

    // Analyse button
    const analyseBtn = document.getElementById('btn-analyse-resume');
    if (analyseBtn) analyseBtn.addEventListener('click', () => this._runAnalysis());

    // Practice button
    const practiceBtn = document.getElementById('btn-practice-resume');
    if (practiceBtn) practiceBtn.addEventListener('click', () => this._startPractice());
  }

  async _handleFile(file) {
    this.fileName = file.name;
    this._showLoading();

    const name     = file.name || '';
    const extLower = (name.split('.').pop() || '').toLowerCase();
    const isPlain    = ['txt', 'md', 'markdown'].includes(extLower);
    const parse = (p) => window.cue.parseResume(p);

    if (file.path) {
      const result = await parse({ filePath: file.path });
      if (result.ok && result.text != null && result.text.trim().length > 0) {
        this._set(result.text, name);
        return;
      }
      if (result && !result.ok && result.error && window.showToast) {
        window.showToast(result.error, 'warn');
      }
    }

    if (isPlain) {
      try {
        const text = await file.text();
        if (text && text.trim().length > 0) {
          this._set(text, name);
          return;
        }
      } catch (_) {}
    } else {
      try {
        const ab    = await file.arrayBuffer();
        const bytes = new Uint8Array(ab);
        const CHUNK = 0x7fff;
        let binary  = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
          const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
          binary += String.fromCharCode.apply(null, sub);
        }
        const b64   = btoa(binary);
        const out   = await parse({ base64: b64, fileName: name });
        if (out.ok && out.text != null && out.text.trim().length > 0) {
          this._set(out.text, name);
          return;
        }
        if (out && out.error && window.showToast) window.showToast(out.error, 'warn');
      } catch (e) {
        console.error('[resume] parse from buffer', e);
      }
    }

    this._showLoaded();
    const ta = document.getElementById('resume-text');
    if (ta) {
      ta.placeholder = 'Could not extract text — paste your resume, or use Open to pick a file from disk';
    }
    if (window.showToast) {
      window.showToast('Could not read this file. Paste the text, or open the file from disk (not a browser download slot).', 'warn');
    }
  }

  _showLoading() {
    const zone = document.getElementById('upload-zone');
    if (zone) zone.innerHTML = '<div style="padding:16px;text-align:center;color:var(--fg3);font-size:11px">Parsing ' + this.fileName + '...</div>';
  }

  _set(text, name) {
    this.text     = text;
    this.fileName = name;
    localStorage.setItem('cue-resume', text);
    localStorage.setItem('cue-resume-name', name);
    this._showLoaded();
    if (window.showToast) window.showToast('Resume loaded — click Analyse to get Nova briefed', 'ok');
    // Auto-run analysis after load
    setTimeout(() => this._runAnalysis(), 300);
  }

  _showLoaded() {
    document.getElementById('upload-zone').style.display   = 'none';
    document.getElementById('resume-loaded').style.display = 'block';
    document.getElementById('resume-name').textContent     = this.fileName || 'Resume';
    document.getElementById('resume-text').value           = this.text;
  }

  async _runAnalysis() {
    if (!this.text.trim()) {
      if (window.showToast) window.showToast('Upload a resume first', 'warn');
      return;
    }
    if (!window.ollama || !window.ollama.connected) {
      if (window.showToast) window.showToast('Ollama must be running to analyse', 'warn');
      return;
    }

    const btn = document.getElementById('btn-analyse-resume');
    if (btn) { btn.disabled = true; btn.textContent = 'Analysing...'; }

    const analysisBox = document.getElementById('resume-analysis-box');
    if (analysisBox) {
      analysisBox.style.display = 'block';
      analysisBox.innerHTML = '<div class="analysis-loading"><div class="typing-dots"><span></span><span></span><span></span></div></div>';
    }

    const PROMPT = `You are a senior technical recruiter and career coach. Analyse this resume and return a JSON object with EXACTLY this structure (no extra text, just valid JSON):
{
  "score": 72,
  "name": "Candidate full name",
  "title": "Current or target role",
  "strengths": ["3-4 specific strengths with evidence from resume"],
  "gaps": ["2-3 specific gaps or weaknesses"],
  "intro": "A 3-sentence first-person intro they should say at interview start",
  "questions": [
    { "q": "Tell me about yourself", "a": "2-3 sentence answer in first person using their resume" },
    { "q": "What's your biggest achievement?", "a": "STAR format answer using their most impressive item" },
    { "q": "Why are you looking for a new role?", "a": "Professional honest answer" },
    { "q": "Walk me through your experience at [most recent company]", "a": "Specific answer about their role and impact" },
    { "q": "What are your technical strengths?", "a": "Grounded in their actual stack" }
  ]
}

Resume:
${this.text.slice(0, 3000)}`;

    let fullResponse = '';
    await window.ollama.chat(
      [{ role: 'system', content: 'You output only valid JSON. No markdown. No explanation.' },
       { role: 'user',   content: PROMPT }],
      chunk => { fullResponse += chunk; },
      () => {
        try {
          // Strip any markdown code fences the model might add
          const clean = fullResponse.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
          const data  = JSON.parse(clean);
          this.analysis = data;
          localStorage.setItem('cue-resume-analysis', JSON.stringify(data));
          this._renderAnalysis(data);
        } catch (e) {
          if (analysisBox) analysisBox.innerHTML = '<div style="font-size:11px;color:var(--red);padding:8px">Analysis failed — try again or check model</div>';
        }
        if (btn) { btn.disabled = false; btn.textContent = 'Re-analyse'; }
      },
      err => {
        if (analysisBox) analysisBox.innerHTML = '<div style="font-size:11px;color:var(--red);padding:8px">Error: ' + err + '</div>';
        if (btn) { btn.disabled = false; btn.textContent = 'Re-analyse'; }
      }
    );
  }

  _renderAnalysis(data) {
    const box = document.getElementById('resume-analysis-box');
    if (!box) return;
    box.style.display = 'block';

    const score     = data.score || '?';
    const scoreColor = score >= 75 ? 'var(--green)' : score >= 55 ? 'var(--accent)' : 'var(--red)';

    const strengthsHtml = (data.strengths || [])
      .map(s => '<li>' + esc(s) + '</li>').join('');
    const gapsHtml = (data.gaps || [])
      .map(g => '<li>' + esc(g) + '</li>').join('');

    const questionsHtml = (data.questions || []).map((item, i) =>
      `<div class="rq-item" id="rq-${i}">
        <div class="rq-q" data-rq-toggle="${i}" role="button" tabindex="0">
          <span class="rq-num">${i+1}</span>
          <span>${esc(item.q)}</span>
          <span class="rq-toggle" aria-hidden="true"><span class="rq-chevron"></span></span>
        </div>
        <div class="rq-a" id="rq-a-${i}" style="display:none">${esc(item.a)}</div>
      </div>`
    ).join('');

    box.innerHTML = `
      <div class="analysis-header">
        <div class="analysis-score" style="color:${scoreColor}">${score}<span>/100</span></div>
        <div class="analysis-name-wrap">
          <div class="analysis-name">${esc(data.name || '')}</div>
          <div class="analysis-title">${esc(data.title || '')}</div>
        </div>
        <button type="button" class="txt-btn btn-reanalyse">Re-analyse</button>
      </div>

      <div class="analysis-section">
        <div class="analysis-label">Strengths</div>
        <ul class="analysis-list strengths">${strengthsHtml}</ul>
      </div>

      <div class="analysis-section">
        <div class="analysis-label">Gaps to address</div>
        <ul class="analysis-list gaps">${gapsHtml}</ul>
      </div>

      <div class="analysis-section">
        <div class="analysis-label">Your intro — say this first</div>
        <div class="analysis-intro">${esc(data.intro || '')}</div>
        <button type="button" class="copy-intro-btn txt-btn">Copy</button>
      </div>

      <div class="analysis-section">
        <div class="analysis-label">Practice Q&A — tap to reveal answers</div>
        <div class="rq-list">${questionsHtml}</div>
      </div>
    `;

    const introText = data.intro || '';
    box.querySelectorAll('[data-rq-toggle]').forEach(el => {
      el.addEventListener('click', () => {
        const i = parseInt(el.getAttribute('data-rq-toggle'), 10);
        if (window.toggleRQ) window.toggleRQ(i);
      });
    });
    const reBtn = box.querySelector('.btn-reanalyse');
    if (reBtn) reBtn.addEventListener('click', () => this._runAnalysis());
    const copyIntro = box.querySelector('.copy-intro-btn');
    if (copyIntro) {
      copyIntro.addEventListener('click', () => {
        navigator.clipboard.writeText(introText).then(() => {
          if (window.showToast) window.showToast('Copied', 'ok');
        }).catch(() => {});
      });
    }
  }

  _startPractice() {
    if (!this.analysis) {
      if (window.showToast) window.showToast('Run analysis first', 'warn');
      return;
    }
    // Switch to Nova agent and pre-fill the chat with a practice prompt
    const agentSel = document.getElementById('agent-select');
    if (agentSel) agentSel.value = 'nova';
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
      chatInput.value = 'Start a mock interview with me. Ask me questions one at a time from my resume and give feedback on each answer.';
      chatInput.dispatchEvent(new Event('input'));
      chatInput.focus();
    }
    if (window.showToast) window.showToast('Nova is ready for mock interview', 'ok');
  }

  _clear() {
    this.text = this.fileName = '';
    this.analysis = null;
    localStorage.removeItem('cue-resume');
    localStorage.removeItem('cue-resume-name');
    localStorage.removeItem('cue-resume-analysis');
    document.getElementById('upload-zone').style.display    = 'block';
    document.getElementById('resume-loaded').style.display  = 'none';
    document.getElementById('resume-file').value = '';
    const box = document.getElementById('resume-analysis-box');
    if (box) box.style.display = 'none';
  }

  hasResume() { return this.text.trim().length > 0; }
  getText()   { return this.text; }
}

// Global toggle for Q&A accordion
window.toggleRQ = function(i) {
  const item = document.getElementById('rq-' + i);
  const a = document.getElementById('rq-a-' + i);
  if (!a || !item) return;
  const isOpen = item.classList.contains('rq-open');
  if (isOpen) {
    item.classList.remove('rq-open');
    a.style.display = 'none';
  } else {
    item.classList.add('rq-open');
    a.style.display = 'block';
  }
};

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}

window.ResumeManager = ResumeManager;
