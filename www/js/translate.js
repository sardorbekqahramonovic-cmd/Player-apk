// Inglizchadan o'zbekchaga tarjima. Natijalar IndexedDB'da keshlanadi,
// shuning uchun bir marta tarjima qilingan so'z keyin internetsiz ham ochiladi.

import * as db from './db.js';

const POS_UZ = {
  noun: 'ot',
  verb: 'feʼl',
  adjective: 'sifat',
  adverb: 'ravish',
  pronoun: 'olmosh',
  preposition: 'predlog',
  conjunction: 'bogʻlovchi',
  interjection: 'undov',
  article: 'artikl',
  abbreviation: 'qisqartma',
  phrase: 'ibora',
  prefix: 'old qoʻshimcha',
  suffix: 'qoʻshimcha',
  'auxiliary verb': 'yordamchi feʼl',
};

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function fetchJson(url) {
  const res = await withTimeout(fetch(url), 10000);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return typeof data === 'string' ? JSON.parse(data) : data;
}

async function viaGoogle(text) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=uz&hl=uz'
    + '&dt=t&dt=bd&dj=1&q=' + encodeURIComponent(text);
  const data = await fetchJson(url);
  const main = (data.sentences || []).map((s) => s.trans || '').join('').trim();
  if (!main) throw new Error('empty');
  const dict = (data.dict || []).map((d) => ({
    pos: POS_UZ[d.pos] || d.pos || '',
    terms: (d.terms || []).slice(0, 6),
  })).filter((d) => d.terms.length);
  return { text: main, dict, source: 'Google' };
}

async function viaMyMemory(text) {
  const url = 'https://api.mymemory.translated.net/get?langpair=en|uz&q=' + encodeURIComponent(text);
  const data = await fetchJson(url);
  const main = data && data.responseData && data.responseData.translatedText;
  if (!main || /MYMEMORY WARNING|INVALID/i.test(main)) throw new Error('empty');
  return { text: main.trim(), dict: [], source: 'MyMemory' };
}

const inflight = new Map();

export async function translate(text) {
  const src = text.trim();
  if (!src) return { text: '', dict: [] };
  const key = src.toLowerCase();

  const cached = await db.get('trcache', key).catch(() => null);
  if (cached) return { ...cached, cached: true };

  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    let lastErr;
    for (const provider of [viaGoogle, viaMyMemory]) {
      try {
        const r = await provider(src);
        db.put('trcache', r, key).catch(() => {});
        return r;
      } catch (e) {
        lastErr = e;
      }
    }
    const err = new Error('Tarjima qilib boʻlmadi. Internet aloqasini tekshiring.');
    err.cause = lastErr;
    throw err;
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

// Tarjimani qo'lda to'g'rilash (foydalanuvchi o'z variantini yozsa).
export async function overrideTranslation(text, translation) {
  const key = text.trim().toLowerCase();
  const old = (await db.get('trcache', key).catch(() => null)) || { dict: [] };
  await db.put('trcache', { ...old, text: translation, source: 'Siz' }, key);
}

export function googleTranslateLink(text) {
  return 'https://translate.google.com/?sl=en&tl=uz&op=translate&text=' + encodeURIComponent(text);
}
