/**
 * kb-engine.js — RAG Knowledge Base Engine (runs in Electron main process)
 *
 * Pipeline:
 *   File → Extract text → Chunk → Embed (nomic-embed-text) → Store (vectra)
 *   Query → Embed query → Nearest-neighbour search → Top-K chunks → inject into prompt
 *
 * File support:
 *   .txt .md        — direct read
 *   .pdf            — pdf-parse
 *   .docx .doc      — mammoth
 *   .xlsx .xls .csv — xlsx (sheet-to-text)
 *   images (.png .jpg .jpeg .webp) — moondream vision model via Ollama
 */

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const os      = require('os');
const {
  normalizeExtractedText, isZipSignature, isOleSignature, bufferToArrayBuffer, LEGACY_DOC
} = require('./extract-helpers');

// Lazy-load heavy parsers so startup stays fast
let _mammoth, _pdfParse, _xlsx, _vectra;
const mammoth  = () => (_mammoth  || (_mammoth  = require('mammoth')));
const pdfParse = () => (_pdfParse || (_pdfParse = require('pdf-parse')));
const xlsx     = () => (_xlsx     || (_xlsx     = require('xlsx')));
const Vectra   = () => {
  if (!_vectra) {
    const { LocalIndex } = require('vectra');
    _vectra = LocalIndex;
  }
  return _vectra;
};

const OLLAMA_HOST     = '127.0.0.1';
const OLLAMA_PORT     = 11434;
const EMBED_MODEL     = 'nomic-embed-text';
const VISION_MODEL    = 'moondream:latest';   // for image description
const CHUNK_SIZE      = 400;   // tokens (approx chars / 4)
const CHUNK_OVERLAP   = 80;
const TOP_K           = 5;     // chunks to retrieve per query
const KB_DIR          = path.join(os.homedir(), '.cue', 'kb');

// Ensure KB directory exists
if (!fs.existsSync(KB_DIR)) fs.mkdirSync(KB_DIR, { recursive: true });

// ── Ollama helpers ───────────────────────────────────────────

function ollamaPost(apiPath, body) {
  return new Promise((resolve, reject) => {
    const str = JSON.stringify(body);
    const req = http.request({
      host: OLLAMA_HOST, port: OLLAMA_PORT, path: apiPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(str) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad JSON: ' + data.slice(0, 100))); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('embed timeout')));
    req.write(str);
    req.end();
  });
}

async function embedText(text) {
  const res = await ollamaPost('/api/embed', {
    model: EMBED_MODEL,
    input: text.slice(0, 2000)   // nomic has 8192 token limit but keep reasonable
  });
  const emb = (res.embeddings || [])[0];
  if (!emb || emb.length === 0) throw new Error('Empty embedding returned');
  return emb;
}

async function describeImage(imagePath) {
  const imgBuffer = fs.readFileSync(imagePath);
  const base64    = imgBuffer.toString('base64');
  const ext       = path.extname(imagePath).toLowerCase().replace('.', '');
  const mimeType  = { jpg:'jpeg', jpeg:'jpeg', png:'png', webp:'webp' }[ext] || 'jpeg';

  const res = await ollamaPost('/api/generate', {
    model: VISION_MODEL,
    prompt: 'Describe this image in detail. If it contains text, transcribe it. If it contains a diagram, chart, or table, explain the data shown.',
    images: [base64],
    stream: false
  });
  return res.response || '';
}

// ── Text extraction ──────────────────────────────────────────

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (['.txt', '.md', '.markdown'].includes(ext)) {
    return normalizeExtractedText(fs.readFileSync(filePath, 'utf8'));
  }

  if (ext === '.pdf') {
    const buf = fs.readFileSync(filePath);
    const pdf = await pdfParse(buf);
    return normalizeExtractedText(pdf.text);
  }

  if (['.docx', '.doc'].includes(ext)) {
    const buf = fs.readFileSync(filePath);
    if (ext === '.doc' && isOleSignature(buf)) throw new Error(LEGACY_DOC);
    if (ext === '.docx' && isOleSignature(buf)) {
      throw new Error('File looks like legacy .doc, not .docx. Re-save as .docx or PDF and add it again.');
    }
    if (ext === '.docx' && buf.length > 0 && !isZipSignature(buf)) {
      throw new Error('Invalid or corrupted .docx file.');
    }
    const m = mammoth();
    if (ext === '.doc' && isZipSignature(buf)) {
      const res = await m.extractRawText({ arrayBuffer: bufferToArrayBuffer(buf) });
      return normalizeExtractedText(res.value);
    }
    if (ext === '.docx') {
      const res = await m.extractRawText({ arrayBuffer: bufferToArrayBuffer(buf) });
      return normalizeExtractedText(res.value);
    }
    try {
      const res = await m.extractRawText({ arrayBuffer: bufferToArrayBuffer(buf) });
      const t   = normalizeExtractedText(res.value);
      if (t.length < 15) throw new Error(LEGACY_DOC);
      return t;
    } catch (e) {
      if (e.message === LEGACY_DOC) throw e;
      throw new Error(LEGACY_DOC);
    }
  }

  if (['.xlsx', '.xls', '.csv'].includes(ext)) {
    const wb = xlsx().readFile(filePath);
    return wb.SheetNames.map(name => {
      const sheet = wb.Sheets[name];
      return `=== Sheet: ${name} ===\n` + xlsx().utils.sheet_to_csv(sheet);
    }).join('\n\n');
  }

  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    return await describeImage(filePath);
  }

  throw new Error('Unsupported file type: ' + ext);
}

// ── Chunking ─────────────────────────────────────────────────

function chunkText(text, filePath) {
  const fileName = path.basename(filePath);
  // Split on paragraph / sentence boundaries first
  const paragraphs = text.split(/\n{2,}|\r\n{2,}/);
  const chunks     = [];
  let   current    = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if ((current + '\n' + trimmed).length > CHUNK_SIZE * 4) {
      if (current) {
        chunks.push({ text: current.trim(), source: fileName });
        // Overlap: keep last part of current chunk
        current = current.slice(-CHUNK_OVERLAP * 4) + '\n' + trimmed;
      } else {
        // Single paragraph too long — split by sentences
        const sentences = trimmed.match(/[^.!?]+[.!?]+/g) || [trimmed];
        let   sentBuf   = '';
        for (const s of sentences) {
          if ((sentBuf + s).length > CHUNK_SIZE * 4) {
            if (sentBuf) chunks.push({ text: sentBuf.trim(), source: fileName });
            sentBuf = s;
          } else {
            sentBuf += s;
          }
        }
        if (sentBuf) current = sentBuf;
      }
    } else {
      current += (current ? '\n\n' : '') + trimmed;
    }
  }
  if (current.trim()) chunks.push({ text: current.trim(), source: fileName });

  return chunks.filter(c => c.text.length > 30);   // discard tiny chunks
}

// ── Vectra index management ───────────────────────────────────

const _indexes = {};   // kbId → LocalIndex instance

async function getIndex(kbId) {
  if (_indexes[kbId]) return _indexes[kbId];
  const IndexClass = Vectra();
  const indexPath  = path.join(KB_DIR, kbId);
  const index      = new IndexClass(indexPath);
  if (!await index.isIndexCreated()) {
    await index.createIndex({ version: 1, distanceFunction: 'cosine' });
  }
  _indexes[kbId] = index;
  return index;
}

// ── Public API (called from IPC handlers) ────────────────────

/**
 * Add a file to a knowledge base.
 * kbId: string identifier (e.g. 'default' or a chat id)
 * onProgress: (pct, status) => void
 */
async function addFile(kbId, filePath, onProgress) {
  const fileName = path.basename(filePath);
  onProgress(0, 'Extracting text from ' + fileName + '...');

  const text = await extractText(filePath);
  if (!text || text.trim().length < 10) {
    throw new Error('Could not extract text from ' + fileName);
  }

  onProgress(10, 'Chunking...');
  const chunks = chunkText(text, filePath);
  if (chunks.length === 0) throw new Error('No content chunks found in ' + fileName);

  const index = await getIndex(kbId);
  let done = 0;

  for (const chunk of chunks) {
    onProgress(10 + Math.round((done / chunks.length) * 85), `Embedding chunk ${done + 1}/${chunks.length}...`);
    const embedding = await embedText(chunk.text);
    await index.insertItem({
      vector: embedding,
      metadata: {
        text:     chunk.text,
        source:   chunk.source,
        file:     filePath,
        addedAt:  Date.now()
      }
    });
    done++;
  }

  onProgress(100, 'Done — ' + chunks.length + ' chunks indexed');
  return { chunks: chunks.length, chars: text.length };
}

/**
 * Query the knowledge base — returns top-K relevant chunks as a string
 */
async function query(kbId, queryText, topK) {
  const index = await getIndex(kbId);
  if (!await index.isIndexCreated()) return '';

  const stats = await index.listItemsByMetadata({});
  if (stats.length === 0) return '';

  const queryEmb = await embedText(queryText);
  const results  = await index.queryItems(queryEmb, topK || TOP_K);

  if (!results || results.length === 0) return '';

  return results
    .filter(r => r.score > 0.3)   // discard irrelevant results
    .map((r, i) =>
      `[Source: ${r.item.metadata.source}]\n${r.item.metadata.text}`
    )
    .join('\n\n---\n\n');
}

/**
 * Remove all chunks from a specific file within a KB
 */
async function removeFile(kbId, filePath) {
  const index = await getIndex(kbId);
  const all   = await index.listItemsByMetadata({ file: filePath });
  for (const item of all) {
    await index.deleteItem(item.id);
  }
  return { removed: all.length };
}

/**
 * List all unique files in a KB
 */
async function listFiles(kbId) {
  const index = await getIndex(kbId);
  if (!await index.isIndexCreated()) return [];
  const all   = await index.listItemsByMetadata({});
  const seen  = new Map();
  for (const item of all) {
    const { file, source, addedAt } = item.metadata;
    if (!seen.has(file)) seen.set(file, { file, source, addedAt, chunks: 0 });
    seen.get(file).chunks++;
  }
  return [...seen.values()].sort((a, b) => b.addedAt - a.addedAt);
}

/**
 * Delete entire KB
 */
async function deleteKB(kbId) {
  const indexPath = path.join(KB_DIR, kbId);
  if (fs.existsSync(indexPath)) {
    fs.rmSync(indexPath, { recursive: true, force: true });
  }
  delete _indexes[kbId];
}

/**
 * Get stats for a KB
 */
async function getStats(kbId) {
  const index = await getIndex(kbId);
  if (!await index.isIndexCreated()) return { chunks: 0, files: 0 };
  const all   = await index.listItemsByMetadata({});
  const files = new Set(all.map(i => i.metadata.file)).size;
  return { chunks: all.length, files };
}

module.exports = { addFile, query, removeFile, listFiles, deleteKB, getStats };
