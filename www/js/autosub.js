// Avtomatik subtitr: Android ilovadagi "Whisper" plagini (whisper.cpp) orqali
// telefonning o'zida, internetsiz nutqni matnga aylantirish.
// Internet faqat modelni birinchi marta yuklab olish uchun kerak.

export const MODELS = [
  { id: 'tiny-q5_1', label: 'Tezkor (tiny)', size: '≈31 MB', note: 'eng tez, aniqligi pastroq' },
  { id: 'base-q5_1', label: 'Muvozanatli (base)', size: '≈57 MB', note: 'tavsiya etiladi' },
  { id: 'small-q5_1', label: 'Aniq (small)', size: '≈181 MB', note: 'aniqroq, lekin 3–4 barobar sekinroq' },
];

export const DEFAULT_MODEL = 'base-q5_1';

const MODEL_URLS = (id) => [
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${id}.bin`,
  `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-${id}.bin`,
];

// 3 ga karrali — har bir bo'lakning base64 matnida oraliq "=" bo'lmaydi
const CHUNK = 3 * 1024 * 1024;

function plugin() {
  const cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.Whisper) {
    return cap.Plugins.Whisper;
  }
  return null;
}

export function isAvailable() {
  return !!plugin();
}

export async function checkSupport() {
  const p = plugin();
  if (!p) return { supported: false, reason: 'web' };
  return p.isSupported();
}

export async function isModelDownloaded(id) {
  const p = plugin();
  if (!p) return false;
  const r = await p.modelInfo({ name: id });
  return !!r.downloaded;
}

export async function deleteModel(id) {
  const p = plugin();
  if (p) await p.deleteModel({ name: id });
}

async function withListener(event, cb, fn) {
  const p = plugin();
  const handle = await p.addListener(event, cb);
  try {
    return await fn();
  } finally {
    handle.remove();
  }
}

export async function downloadModel(id, onProgress) {
  const p = plugin();
  let lastErr;
  for (const url of MODEL_URLS(id)) {
    try {
      return await withListener('download', (e) => onProgress && onProgress(e.percent), () => p.downloadModel({ name: id, url }));
    } catch (e) {
      if (e && e.code === 'CANCELLED') throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('Modelni yuklab boʻlmadi');
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Videoni (IndexedDB'dagi Blob) bo'laklab ilovaning vaqtinchalik fayliga o'tkazadi
export async function uploadVideo(blob, onProgress, isCancelled) {
  const p = plugin();
  await p.beginUpload();
  for (let off = 0; off < blob.size; off += CHUNK) {
    if (isCancelled && isCancelled()) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    const data = await blobToBase64(blob.slice(off, off + CHUNK));
    await p.appendChunk({ data });
    if (onProgress) onProgress(Math.min(100, Math.round(((off + CHUNK) / blob.size) * 100)));
  }
}

// onProgress(stage, percent): stage — 'audio' (ovoz ajratish) yoki 'asr' (nutqni tanish)
export async function transcribe({ model, language }, onProgress) {
  const p = plugin();
  const res = await withListener('progress', (e) => onProgress && onProgress(e.stage, e.percent),
    () => p.transcribe({ model, language }));
  return segmentsToCues(res.segments || []);
}

export async function cancel() {
  const p = plugin();
  if (p) await p.cancel();
}

// whisper segmentlari ({ s, e, t } — millisekundlarda) -> subtitr qatorlari
export function segmentsToCues(segments) {
  const cues = [];
  for (const seg of segments) {
    const text = String(seg.t || '').replace(/\s+/g, ' ').trim();
    if (!text || /^\[?(BLANK_AUDIO|blank_audio|silence)\]?$/i.test(text.replace(/[()]/g, ''))) continue;
    const start = Math.max(0, seg.s / 1000);
    const end = Math.max(seg.e / 1000, start + 0.3);
    const prev = cues[cues.length - 1];
    // bir xil matn ketma-ket takrorlansa (whisper ba'zan shunday qiladi) — bittaga birlashtiramiz
    if (prev && prev.text === text && start - prev.end < 1.5) {
      prev.end = Math.max(prev.end, end);
      continue;
    }
    cues.push({ start, end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  cues.forEach((c, i) => { c.i = i; });
  return cues;
}
