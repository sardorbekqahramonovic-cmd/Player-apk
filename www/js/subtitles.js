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
  keepEnglishOnly(cues);
  return cues;
}

// ---------- Faqat inglizcha matnni qoldirish ----------
// Ba'zi subtitrlarda har bir inglizcha qator ostida o'zbekcha tarjimasi ham yozilgan:
//   My name is Lisa.
//   Mening ismim Lisa.
// Ilova faqat inglizcha subtitr bilan ishlaydi, shuning uchun o'zbekcha qatorlar olib tashlanadi.

const EN_WORDS = new Set((
  'i you he she it we they me him her us them my your his its our their mine yours the a an '
  + 'is are was were be been being am do does did done have has had will would can could should shall may might must '
  + 'not no yes to of in on at for with from by about as into onto and or but if so that this these those '
  + 'what who whom why where when how which there here all any some just now then than too very more most much many '
  + 'one only also again still ever never always up out over off down away back before after '
  + "i'm i've i'll i'd you're you've you'll it's that's there's let's don't doesn't didn't can't won't isn't aren't wasn't "
  + "haven't hasn't wouldn't couldn't shouldn't he's she's we're they're what's "
  + 'know want like get go going come see take make say said says tell think look need give let well oh yeah okay'
).split(' '));

const UZ_WORDS = new Set((
  'va men sen siz u biz ular bu shu ushbu uchun bilan emas ha ham esa edi ekan emish kerak nima nega nimaga qanday '
  + 'qayerda qayerga qachon hech endi agar ammo lekin biroq chunki deb dedi degan bir ikki meni seni sizni uni bizni '
  + 'ularni mening sening sizning uning bizning ularning menga senga sizga unga bizga ularga mendan sizdan undan '
  + 'bor yoʻq yana juda hamma hammasi barcha faqat albatta balki xoʻp mana ana iltimos rahmat kim hozir keyin oldin '
  + 'yaxshi katta kichik qil qiling qildi boʻldi boʻladi kel keling ket keting ber bering ol oling'
).split(' '));

const UZ_SUFFIX = /(?:ning|larni|larga|lardan|larda|lar|dagi|moqda|moqchi|yapti|yapman|yapsiz|ganman|gansiz|adi|aydi|ydi|dingiz|ingiz|imiz|ishim|ishingiz|mizni|dan|ga|da|ni|ligi|lik|siz|miz|man)$/;

function normApos(s) {
  // o‘ g‘ oʻ gʻ o' g' — hammasini bitta shaklga keltiramiz
  return s.toLowerCase().replace(/[‘’ʻʼ`´']/g, 'ʻ');
}

// Musbat — inglizcha, manfiy — o'zbekcha, 0 atrofida — noaniq (ism, undov va h.k.).
function langScore(line) {
  const raw = line.replace(/\[[^\]]*\]/g, ' ').replace(/<[^>]+>/g, ' ');
  let en = 0;
  let uz = 0;
  if (/[\u0400-\u04FF]/.test(raw)) uz += 3; // kirill yozuvi — o'zbekcha (kirill)
  const toks = normApos(raw).match(/[a-zʻ\u0400-\u04FF]+/g) || [];
  for (const t of toks) {
    const w = t.replace(/^ʻ+|ʻ+$/g, '');
    if (!w) continue;
    const plain = w.replace(/ʻ/g, "'");
    if (EN_WORDS.has(plain)) { en += 1; continue; }
    if (UZ_WORDS.has(w)) { uz += 1; continue; }
    // o'zbekcha o‘/g‘ harflari (inglizcha qisqartmalar — 's, 't, 'll, 'd, 've, 're, 'm — bundan mustasno)
    if (/[og]ʻ(?!(?:s|t|ll|d|ve|re|m)$)[a-z]/.test(w) || /^[og]ʻ/.test(w)) { uz += 2; continue; }
    if (/q(?!u)/.test(w)) { uz += 1; continue; }
    if (/^(?:th|wh)/.test(w) || /(?:tion|ness|ould|ight|ing|ed)$/.test(w)) { en += 0.5; continue; }
    if (w.length > 3 && UZ_SUFFIX.test(w)) uz += 0.6;
  }
  return en - uz;
}

function bestSplit(scores, enFirst) {
  const n = scores.length;
  let best = Math.ceil(n / 2);
  let bestVal = -Infinity;
  for (let k = 1; k < n; k++) {
    let v = 0;
    for (let i = 0; i < n; i++) v += (i < k ? 1 : -1) * scores[i];
    if (!enFirst) v = -v;
    const tieBetter = v === bestVal && Math.abs(k - n / 2) < Math.abs(best - n / 2);
    if (v > bestVal || tieBetter) { bestVal = v; best = k; }
  }
  return best;
}

// Fayl ikki tillimi — aniqlaydi. 'en-uz', 'uz-en' yoki null qaytaradi.
function detectBilingual(cues) {
  const multi = cues.filter((c) => c.text.includes('\n'));
  if (multi.length < 3 || multi.length < cues.length * 0.5) return null;
  let enFirst = 0;
  let uzFirst = 0;
  for (const c of multi) {
    const lines = c.text.split('\n');
    const a = langScore(lines[0]);
    const b = langScore(lines[lines.length - 1]);
    if (a > 0 && b < 0) enFirst++;
    else if (a < 0 && b > 0) uzFirst++;
  }
  const need = Math.max(3, multi.length * 0.25);
  if (enFirst >= need && enFirst > uzFirst * 3) return 'en-uz';
  if (uzFirst >= need && uzFirst > enFirst * 3) return 'uz-en';
  return null;
}

// Ikki tilli fayl bo'lsa, har bir gapdan faqat inglizcha qatorlarni qoldiradi.
// Fayl ikki tilli bo'lmasa, hech narsa o'zgarmaydi. O'zgartirilgan bo'lsa true qaytaradi.
export function keepEnglishOnly(cues) {
  const order = detectBilingual(cues);
  if (!order) return false;
  const enFirst = order === 'en-uz';
  for (const c of cues) {
    const lines = c.text.split('\n');
    if (lines.length < 2) continue;
    const k = bestSplit(lines.map(langScore), enFirst);
    c.text = (enFirst ? lines.slice(0, k) : lines.slice(k)).join('\n');
  }
  return true;
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
