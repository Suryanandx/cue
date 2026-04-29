'use strict';

/**
 * Shared text extraction helpers (main + kb-engine).
 * Normalizes control chars; detects legacy .doc (OLE) vs .docx (zip) to avoid
 * mis-parsing with mammoth and producing garbled "corrupt" text.
 */

function normalizeExtractedText(raw) {
  if (raw == null) return '';
  let s = String(raw);
  s = s.replace(/\0/g, '');
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(/\u00A0|\u200B|\uFEFF/g, ' ');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function isZipSignature(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
}

function isOleSignature(buf) {
  return buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
}

/** @returns {ArrayBuffer} */
function bufferToArrayBuffer(buf) {
  const u8 = new Uint8Array(buf);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

const LEGACY_DOC =
  'Legacy Word (.doc) is not supported. In Word, use Save As → .docx or export as PDF, then try again.';

module.exports = {
  normalizeExtractedText,
  isZipSignature,
  isOleSignature,
  bufferToArrayBuffer,
  LEGACY_DOC
};
