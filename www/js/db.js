// IndexedDB ustidan yupqa qatlam: videolar, fayllar (Blob), lug'at, tarjima keshi va sozlamalar.

const DB_NAME = 'til-player';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('vocab')) {
        const s = db.createObjectStore('vocab', { keyPath: 'id' });
        s.createIndex('word', 'word');
      }
      if (!db.objectStoreNames.contains('trcache')) db.createObjectStore('trcache');
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(storeName, key) {
  return wrap((await store(storeName)).get(key));
}

export async function getAll(storeName) {
  return wrap((await store(storeName)).getAll());
}

export async function put(storeName, value, key) {
  const s = await store(storeName, 'readwrite');
  return wrap(key === undefined ? s.put(value) : s.put(value, key));
}

export async function del(storeName, key) {
  return wrap((await store(storeName, 'readwrite')).delete(key));
}

export async function clear(storeName) {
  return wrap((await store(storeName, 'readwrite')).clear());
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// --- Videolar ---

export async function addVideo(meta, videoBlob) {
  await put('blobs', videoBlob, meta.id);
  await put('videos', meta);
}

export async function deleteVideo(id) {
  await del('blobs', id);
  await del('videos', id);
}

export async function updateVideo(id, patch) {
  const v = await get('videos', id);
  if (!v) return null;
  Object.assign(v, patch);
  await put('videos', v);
  return v;
}

// --- Sozlamalar ---

export const DEFAULT_SETTINGS = {
  fontSize: 20,
  defaultSpeed: 1,
  pauseOnWordTap: true,
  shadowRepeats: 2,
  shadowPauseFactor: 1.3,
  shadowAutoRecord: false,
  listenAutoPause: true,
  listenHideSubs: true,
  autoTranslateLine: false,
  skipSfx: true,
  transcriptUz: false,
};

export async function loadSettings() {
  const s = await get('settings', 'main');
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function saveSettings(s) {
  await put('settings', s, 'main');
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch (_) { /* ixtiyoriy */ }
}
