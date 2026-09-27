// SRT va WebVTT subtitrlarini o'qish hamda gaplarni so'zlarga ajratish.

function parseTime(str) {
  // 00:01:02,345 | 00:01:02.345 | 01:02.345
  const m = str.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
  return h * 3600 + min * 60 + s + ms / 1000;
}

function cleanText(text) {
  return text
    .replace(/\{\\[^}]*\}/g, '')          // ASS teglari: {\an8}
    .replace(/<[^>]+>/g, '')              // <i>, <b>, <font ...>, <c.color>, <00:00:01.000>
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

export function parseSubtitles(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues = [];
  const arrow = /((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)/;

  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => arrow.test(l));
    if (idx === -1) continue; // WEBVTT sarlavhasi, NOTE, STYLE va h.k.
    const m = lines[idx].match(arrow);
    const start = parseTime(m[1]);
    const end = parseTime(m[2]);
    if (isNaN(start) || isNaN(end)) continue;
    const body = cleanText(lines.slice(idx + 1).join('\n'));
    if (!body) continue;
    cues.push({ start, end: Math.max(end, start + 0.3), text: body });
  }

  cues.sort((a, b) => a.start - b.start);
  cues.forEach((c, i) => { c.i = i; });
  return cues;
}

// Fayl kodirovkasini taxmin qilish: avval UTF-8, bo'lmasa windows-1252.
export async function readSubtitleFile(file) {
  const buf = await file.arrayBuffer();
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    text = new TextDecoder('windows-1252').decode(buf);
  }
  const cues = parseSubtitles(text);
  if (!cues.length) throw new Error('Subtitr faylidan birorta ham qator topilmadi (SRT yoki VTT boʻlishi kerak).');
  return cues;
}

const WORD_RE = /[A-Za-z0-9À-ɏ]+(?:['’][A-Za-zÀ-ɏ]+)*(?:-[A-Za-z0-9À-ɏ]+)*/g;

// Matnni [{t: 'so'z', w: true}, {t: ', ', w: false}, ...] ko'rinishiga keltiradi.
export function tokenize(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(WORD_RE)) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), w: false });
    out.push({ t: m[0], w: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), w: false });
  return out;
}

export function words(text) {
  return (text.match(WORD_RE) || []);
}

// Berilgan vaqtda (yoki undan oldin) boshlangan oxirgi qator indeksi.
export function cueIndexAt(cues, t) {
  let lo = 0, hi = cues.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// Ekranda ko'rsatiladigan qator (vaqt ichida bo'lsa).
export function activeCueAt(cues, t) {
  const i = cueIndexAt(cues, t);
  if (i >= 0 && t < cues[i].end) return i;
  return -1;
}

// Diktant tekshiruvi: foydalanuvchi yozgan matnni asl gap bilan so'zma-so'z solishtirish (LCS).
export function compareDictation(original, typed) {
  const norm = (w) => w.toLowerCase().replace(/’/g, "'");
  const a = words(original);
  const b = words(typed).map(norm);
  const an = a.map(norm);
  const dp = Array.from({ length: an.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = an.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = an[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result = [];
  let i = 0, j = 0;
  while (i < an.length && j < b.length) {
    if (an[i] === b[j]) { result.push({ w: a[i], ok: true }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { result.push({ w: a[i], ok: false }); i++; }
    else { result.push({ w: words(typed)[j], extra: true }); j++; }
  }
  while (i < an.length) { result.push({ w: a[i], ok: false }); i++; }
  while (j < b.length) { result.push({ w: words(typed)[j], extra: true }); j++; }
  const correct = result.filter((r) => r.ok).length;
  return { result, score: a.length ? Math.round((correct / a.length) * 100) : 0 };
}

export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}
