import * as db from './db.js';
import {
  readSubtitleFile, tokenize, cueIndexAt, activeCueAt, compareDictation, formatTime, words,
  detectLanguage, keepLanguageOnly,
} from './subtitles.js';
import { translate, overrideTranslation, googleTranslateLink } from './translate.js';
import * as autosub from './autosub.js';
import {
  speak, setOrientation, setSystemBarsHidden, VoiceRecorder,
} from './media.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SPEEDS = [0.5, 0.6, 0.75, 0.85, 1, 1.25, 1.5];
const SUB_MODES = ['en', 'en+uz', 'hidden', 'off'];
const LANG_CODE = { en: 'EN', ru: 'RU' };
const LANG_NAME = { en: 'inglizcha', ru: 'ruscha' };
// 'en' va 'en+uz' — "asl til" va "asl til + o'zbekcha" rejimlari (til videoga qarab)
function subLabel(m) {
  const code = LANG_CODE[S.lang] || 'EN';
  return { en: code, 'en+uz': code + '+UZ', hidden: 'Yashirin', off: 'Oʻchiq' }[m];
}

const S = {
  settings: null,
  videos: [],
  playlists: [],
  libTab: 'videos',
  openPlaylistId: null, // ochiq playlist sahifasi
  pl: null, // pleyerda ijro etilayotgan playlist: { id, index }
  returnView: 'library',
  vocab: [],
  savedWords: new Set(),
  view: 'library',
  // pleyer holati
  cur: null,
  objectUrl: null,
  cues: [],
  lang: 'en', // joriy video subtitri tili
  offset: 0,
  mode: 'watch',
  subMode: 'en',
  loop: false,
  activeIdx: -1,
  playIdx: -1,
  endFired: false,
  revealed: new Set(),
  lastSave: 0,
  userScrollAt: 0,
  // shadowing
  sh: { idx: -1, reps: 0, timer: null, waiting: false, until: 0 },
  // so'z oynasi
  word: null,
};

const video = $('#video');
const recorder = new VoiceRecorder();

// ================= Yordamchi funksiyalar =================

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normWord(w) {
  return w.toLowerCase().replace(/’/g, "'");
}

function cueHTML(cue) {
  let wi = 0;
  return tokenize(cue.text).map((tok) => {
    if (!tok.w) return esc(tok.t);
    const cls = S.savedWords.has(normWord(tok.t)) ? 'w saved' : 'w';
    return `<span class="${cls}" data-ci="${cue.i}" data-wi="${wi++}">${esc(tok.t)}</span>`;
  }).join('');
}

function openModal(id) {
  $(id).classList.remove('hidden');
}

function closeModal(el) {
  const m = el.closest ? el.closest('.modal') : el;
  if (!m) return;
  m.classList.add('hidden');
  if (m.id === 'sheet') onSheetClosed();
}

function topModal() {
  return $$('.modal').filter((m) => !m.classList.contains('hidden')).pop();
}

// ================= Navigatsiya =================

function showView(name) {
  S.view = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  const navName = name === 'playlist' ? 'library' : name;
  $$('.bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === navName));
  document.body.classList.toggle('in-player', name === 'player');
  if (name === 'library') renderLibrary();
  if (name === 'playlist') renderPlaylistPage();
  if (name === 'vocab') renderVocab();
  if (name === 'settings') renderSettings();
}

$$('.bottom-nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) { closeModal(close); return; }
  if (e.target.classList.contains('modal')) closeModal(e.target);
});

function handleBack() {
  const m = topModal();
  if (m) { closeModal(m); return true; }
  if (document.body.classList.contains('fs')) { setFullscreen(false); return true; }
  if (S.view === 'player') { closePlayer(); return true; }
  if (S.view !== 'library') { showView('library'); return true; }
  if (S.libTab !== 'videos') { setLibTab('videos'); return true; }
  return false;
}

// ================= Kutubxona =================

async function loadVideos() {
  S.videos = (await db.getAll('videos')).sort((a, b) => (b.openedAt || b.createdAt) - (a.openedAt || a.createdAt));
}

function renderLibrary() {
  const onVideos = S.libTab === 'videos';
  $$('#lib-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.libTab));
  $('#library-list').classList.toggle('hidden', !onVideos);
  $('#playlist-list').classList.toggle('hidden', onVideos);
  if (!onVideos) {
    $('#library-empty').classList.add('hidden');
    renderPlaylists();
    return;
  }
  const list = $('#library-list');
  $('#library-empty').classList.toggle('hidden', S.videos.length > 0);
  list.innerHTML = S.videos.map((v) => {
    const pct = v.duration ? Math.min(100, Math.round(((v.lastTime || 0) / v.duration) * 100)) : 0;
    const thumb = v.thumb ? `style="background-image:url('${v.thumb}')"` : '';
    return `
      <div class="vcard" data-id="${v.id}">
        <div class="thumb" ${thumb}>${v.thumb ? '' : '<svg><use href="#i-film"/></svg>'}</div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="info">
          <div style="flex:1">
            <div class="title">${esc(v.title)}</div>
            <div class="meta">
              ${v.duration ? `<span class="badge">${formatTime(v.duration)}</span>` : ''}
              ${v.subEn ? `<span class="badge">${LANG_CODE[v.lang || 'en']} ${v.subEn.length} gap${v.subAuto ? ' · avto' : ''}</span>` : '<span class="badge" style="color:var(--warn)">Subtitr yoʻq</span>'}
              ${pct ? `<span class="badge">${pct}%</span>` : ''}
            </div>
          </div>
          <button class="icon-btn del" data-topl="${v.id}" title="Playlistga qoʻshish"><svg><use href="#i-list-plus"/></svg></button>
          <button class="icon-btn del" data-del="${v.id}" title="Oʻchirish"><svg><use href="#i-trash"/></svg></button>
        </div>
      </div>`;
  }).join('');
}

$('#library-list').addEventListener('click', async (e) => {
  const topl = e.target.closest('[data-topl]');
  if (topl) { e.stopPropagation(); openToPlaylist(topl.dataset.topl); return; }
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const v = S.videos.find((x) => x.id === del.dataset.del);
    if (v && confirm(`“${v.title}” oʻchirilsinmi?`)) {
      await db.deleteVideo(v.id);
      await Promise.all([loadVideos(), loadPlaylists()]);
      renderLibrary();
      toast('Video oʻchirildi');
    }
    return;
  }
  const card = e.target.closest('.vcard');
  if (card) openPlayer(card.dataset.id);
});

// ================= Playlistlar =================

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

async function loadPlaylists() {
  S.playlists = (await db.getAll('playlists')).sort((a, b) => b.createdAt - a.createdAt);
}

function videoById(id) {
  return S.videos.find((v) => v.id === id);
}

// Playlistdagi mavjud videolar (o'chirilganlari tashlab ketiladi)
function plVideos(pl) {
  return pl ? pl.items.map(videoById).filter(Boolean) : [];
}

function isFinished(v) {
  return v.duration && (v.lastTime || 0) >= v.duration - 10;
}

function setLibTab(tab) {
  S.libTab = tab;
  renderLibrary();
}
$$('#lib-tabs button').forEach((b) => b.addEventListener('click', () => setLibTab(b.dataset.tab)));

function renderPlaylists() {
  const cards = S.playlists.map((pl) => {
    const vids = plVideos(pl);
    const total = vids.reduce((sum, v) => sum + (v.duration || 0), 0);
    const done = vids.filter(isFinished).length;
    const first = vids.find((v) => v.thumb);
    const thumb = first ? `style="background-image:url('${first.thumb}')"` : '';
    return `
      <div class="vcard plcard" data-pl="${pl.id}">
        <div class="thumb" ${thumb}>
          ${first ? '' : '<svg><use href="#i-list"/></svg>'}
          <span class="pl-count"><svg><use href="#i-list"/></svg>${vids.length}</span>
        </div>
        <div class="progress"><i style="width:${vids.length ? Math.round((done / vids.length) * 100) : 0}%"></i></div>
        <div class="info">
          <div style="flex:1">
            <div class="title">${esc(pl.name)}</div>
            <div class="meta">
              <span class="badge">${vids.length} ta video</span>
              ${total ? `<span class="badge">${formatTime(total)}</span>` : ''}
              ${done ? `<span class="badge">${done} tasi koʻrildi</span>` : ''}
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
  $('#playlist-list').innerHTML = `
    <button class="vcard newpl" id="pl-new">
      <svg><use href="#i-plus"/></svg>
      <span>Yangi playlist</span>
      <small class="muted">Masalan: “Castlevania 1-mavsum”</small>
    </button>` + cards;
}

async function createPlaylistPrompt(items = []) {
  const name = (prompt('Playlist nomi:', '') || '').trim();
  if (!name) return null;
  const pl = await db.createPlaylist(name, items);
  await loadPlaylists();
  return pl;
}

$('#playlist-list').addEventListener('click', async (e) => {
  if (e.target.closest('#pl-new')) {
    const pl = await createPlaylistPrompt();
    if (pl) openPlaylistPage(pl.id);
    return;
  }
  const card = e.target.closest('[data-pl]');
  if (card) openPlaylistPage(card.dataset.pl);
});

// ---- Playlist sahifasi ----

function openPlaylistPage(id) {
  S.openPlaylistId = id;
  showView('playlist');
}

function currentPagePl() {
  return S.playlists.find((p) => p.id === S.openPlaylistId);
}

function renderPlaylistPage() {
  const pl = currentPagePl();
  if (!pl) { showView('library'); return; }
  const vids = plVideos(pl);
  const total = vids.reduce((sum, v) => sum + (v.duration || 0), 0);
  $('#pl-title').textContent = pl.name;
  $('#pl-info').textContent = vids.length
    ? `${vids.length} ta video · ${formatTime(total)} · ${vids.filter(isFinished).length} tasi koʻrildi`
    : 'Playlist boʻsh. “Video qoʻshish” tugmasi orqali kutubxonadagi videolarni qoʻshing.';
  $('#pl-play').disabled = !vids.length;
  $('#pl-items').innerHTML = vids.map((v, i) => {
    const pct = v.duration ? Math.min(100, Math.round(((v.lastTime || 0) / v.duration) * 100)) : 0;
    const thumb = v.thumb ? `style="background-image:url('${v.thumb}')"` : '';
    return `
      <div class="pl-item" data-idx="${i}">
        <span class="pl-num">${isFinished(v) ? '<svg><use href="#i-check"/></svg>' : i + 1}</span>
        <div class="pl-thumb" ${thumb}><i style="width:${pct}%"></i></div>
        <div class="pl-meta">
          <div class="pl-t">${esc(v.title)}</div>
          <div class="muted small">${v.duration ? formatTime(v.duration) : ''}${pct ? ` · ${pct}%` : ''}${v.subEn ? '' : ' · subtitr yoʻq'}</div>
        </div>
        <div class="pl-btns">
          <button class="icon-btn" data-move="-1" title="Yuqoriga" ${i === 0 ? 'disabled' : ''}><svg><use href="#i-up"/></svg></button>
          <button class="icon-btn" data-move="1" title="Pastga" ${i === vids.length - 1 ? 'disabled' : ''}><svg><use href="#i-down"/></svg></button>
          <button class="icon-btn" data-rm title="Playlistdan olib tashlash"><svg><use href="#i-close"/></svg></button>
        </div>
      </div>`;
  }).join('');
}

async function savePlItems(pl, ids) {
  pl.items = ids;
  await db.updatePlaylist(pl.id, { items: ids });
}

$('#pl-items').addEventListener('click', async (e) => {
  const pl = currentPagePl();
  const row = e.target.closest('.pl-item');
  if (!pl || !row) return;
  const ids = plVideos(pl).map((v) => v.id);
  const i = +row.dataset.idx;
  const move = e.target.closest('[data-move]');
  if (move) {
    const j = i + +move.dataset.move;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await savePlItems(pl, ids);
    renderPlaylistPage();
    return;
  }
  if (e.target.closest('[data-rm]')) {
    ids.splice(i, 1);
    await savePlItems(pl, ids);
    renderPlaylistPage();
    toast('Video playlistdan olib tashlandi (kutubxonada qoldi)');
    return;
  }
  playPlaylist(pl.id, i);
});

$('#pl-back').addEventListener('click', () => { S.libTab = 'playlists'; showView('library'); });

$('#pl-play').addEventListener('click', () => {
  const pl = currentPagePl();
  const vids = plVideos(pl);
  if (!vids.length) return;
  // birinchi oxirigacha ko'rilmagan videodan boshlaymiz
  const i = vids.findIndex((v) => !isFinished(v));
  playPlaylist(pl.id, i === -1 ? 0 : i);
});

$('#pl-rename').addEventListener('click', async () => {
  const pl = currentPagePl();
  if (!pl) return;
  const name = (prompt('Yangi nom:', pl.name) || '').trim();
  if (!name) return;
  await db.updatePlaylist(pl.id, { name });
  await loadPlaylists();
  renderPlaylistPage();
});

$('#pl-delete').addEventListener('click', async () => {
  const pl = currentPagePl();
  if (!pl || !confirm(`“${pl.name}” playlisti oʻchirilsinmi?\nVideolar kutubxonada qoladi.`)) return;
  await db.del('playlists', pl.id);
  await loadPlaylists();
  S.libTab = 'playlists';
  showView('library');
  toast('Playlist oʻchirildi');
});

// Playlistga kutubxonadan videolar tanlash
$('#pl-add').addEventListener('click', () => {
  const pl = currentPagePl();
  if (!pl) return;
  if (!S.videos.length) { toast('Kutubxonada hali video yoʻq'); return; }
  const inPl = new Set(pl.items);
  const sorted = [...S.videos].sort((a, b) => natural(a.title, b.title));
  $('#plpick-list').innerHTML = sorted.map((v) => `
    <label class="check-row">
      <input type="checkbox" value="${v.id}" ${inPl.has(v.id) ? 'checked' : ''}>
      <span>${esc(v.title)}</span>
      ${v.duration ? `<small class="muted">${formatTime(v.duration)}</small>` : ''}
    </label>`).join('');
  openModal('#modal-plpick');
});

$('#plpick-save').addEventListener('click', async () => {
  const pl = currentPagePl();
  if (!pl) return;
  const checked = new Set($$('#plpick-list input:checked').map((c) => c.value));
  const kept = pl.items.filter((id) => checked.has(id));
  const added = S.videos.filter((v) => checked.has(v.id) && !pl.items.includes(v.id))
    .sort((a, b) => natural(a.title, b.title))
    .map((v) => v.id);
  await savePlItems(pl, [...kept, ...added]);
  closeModal($('#modal-plpick'));
  renderPlaylistPage();
});

// ---- Videoni playlistga qo'shish (kutubxonadan) ----

let toplVideoId = null;

function renderToPlaylist() {
  const v = videoById(toplVideoId);
  $('#topl-video').textContent = v ? v.title : '';
  $('#topl-list').innerHTML = S.playlists.length
    ? S.playlists.map((pl) => `
      <label class="check-row">
        <input type="checkbox" value="${pl.id}" ${pl.items.includes(toplVideoId) ? 'checked' : ''}>
        <span>${esc(pl.name)}</span>
        <small class="muted">${plVideos(pl).length} ta</small>
      </label>`).join('')
    : '<p class="muted small">Hali playlist yoʻq — pastda yangisini yarating.</p>';
}

function openToPlaylist(videoId) {
  toplVideoId = videoId;
  $('#topl-new').value = '';
  renderToPlaylist();
  openModal('#modal-topl');
}

$('#topl-list').addEventListener('change', async (e) => {
  const pl = S.playlists.find((p) => p.id === e.target.value);
  if (!pl) return;
  const items = e.target.checked
    ? [...pl.items.filter((id) => id !== toplVideoId), toplVideoId]
    : pl.items.filter((id) => id !== toplVideoId);
  await savePlItems(pl, items);
  toast(e.target.checked ? `“${pl.name}” ga qoʻshildi` : `“${pl.name}” dan olib tashlandi`, 1600);
});

$('#topl-create').addEventListener('click', async () => {
  const name = $('#topl-new').value.trim();
  if (!name) { $('#topl-new').focus(); return; }
  await db.createPlaylist(name, [toplVideoId]);
  await loadPlaylists();
  $('#topl-new').value = '';
  renderToPlaylist();
  toast(`“${name}” playlisti yaratildi`);
});

// ---- Video qo'shish oynasidagi playlist tanlovi ----

function fillPlaylistSelect() {
  const sel = $('#add-playlist');
  sel.innerHTML = '<option value="">— Qoʻshilmasin —</option>'
    + S.playlists.map((pl) => `<option value="${pl.id}">${esc(pl.name)}</option>`).join('')
    + '<option value="__new">+ Yangi playlist…</option>';
  // oxirgi marta tanlangan playlistni eslab qolamiz — qismlarni ketma-ket qo'shish qulay bo'lsin
  if (S.lastPlaylistId && S.playlists.some((p) => p.id === S.lastPlaylistId)) sel.value = S.lastPlaylistId;
  $('#add-playlist-new').classList.toggle('hidden', sel.value !== '__new');
}
$('#add-playlist').addEventListener('change', (e) => {
  $('#add-playlist-new').classList.toggle('hidden', e.target.value !== '__new');
  if (e.target.value === '__new') $('#add-playlist-new').focus();
});

// ---- Pleyerda playlist ----

function playPlaylist(plId, index, autoplay = false) {
  const pl = S.playlists.find((p) => p.id === plId);
  const vids = plVideos(pl);
  if (!vids[index]) return;
  const v = vids[index];
  // qayta ko'rilayotgan (oxirigacha ko'rilgan) video boshidan boshlanadi
  openPlayer(v.id, isFinished(v) ? 0 : null, { playlist: { id: plId, index }, autoplay });
}

function renderPlBar() {
  const bar = $('#pl-bar');
  const pl = S.pl && S.playlists.find((p) => p.id === S.pl.id);
  bar.classList.toggle('hidden', !pl);
  if (!pl) return;
  const n = plVideos(pl).length;
  $('#plb-text').textContent = `${pl.name} · ${S.pl.index + 1}/${n}`;
  $('#plb-prev').disabled = S.pl.index <= 0;
  $('#plb-next').disabled = S.pl.index >= n - 1;
}

$('#plb-prev').addEventListener('click', () => {
  if (S.pl && S.pl.index > 0) playPlaylist(S.pl.id, S.pl.index - 1, true);
});
$('#plb-next').addEventListener('click', () => {
  if (S.pl) playPlaylist(S.pl.id, S.pl.index + 1, true);
});

$('#plb-open').addEventListener('click', () => {
  const pl = S.pl && S.playlists.find((p) => p.id === S.pl.id);
  if (!pl) return;
  $('#plnow-title').textContent = pl.name;
  $('#plnow-list').innerHTML = plVideos(pl).map((v, i) => `
    <div class="pl-item${i === S.pl.index ? ' current' : ''}" data-idx="${i}">
      <span class="pl-num">${i === S.pl.index ? '<svg><use href="#i-play"/></svg>' : isFinished(v) ? '<svg><use href="#i-check"/></svg>' : i + 1}</span>
      <div class="pl-meta">
        <div class="pl-t">${esc(v.title)}</div>
        <div class="muted small">${v.duration ? formatTime(v.duration) : ''}</div>
      </div>
    </div>`).join('');
  openModal('#modal-plnow');
});

$('#plnow-list').addEventListener('click', (e) => {
  const row = e.target.closest('.pl-item');
  if (!row || !S.pl) return;
  closeModal($('#modal-plnow'));
  const i = +row.dataset.idx;
  if (i !== S.pl.index) playPlaylist(S.pl.id, i, true);
});

// Video tugagach — 5 soniyadan keyin keyingisi (ustiga bosib bekor qilish mumkin)
let nextTimer = null;

function cancelAutoNext() {
  if (!nextTimer) return;
  clearInterval(nextTimer);
  nextTimer = null;
  clearStatus();
}

function scheduleAutoNext() {
  const pl = S.playlists.find((p) => p.id === S.pl.id);
  const vids = plVideos(pl);
  const nextIdx = S.pl.index + 1;
  if (nextIdx >= vids.length) { toast('Playlist tugadi 🎉'); return; }
  let left = 5;
  const tickNext = () => {
    if (left <= 0) {
      cancelAutoNext();
      playPlaylist(pl.id, nextIdx, true);
      return;
    }
    setStatus(`<svg><use href="#i-next"/></svg>Keyingi: ${esc(vids[nextIdx].title)} · ${left} <u>Bekor qilish</u>`, 0);
    left--;
  };
  cancelAutoNext();
  tickNext();
  nextTimer = setInterval(tickNext, 1000);
}

$('#stage-status').addEventListener('click', (e) => {
  if (!nextTimer) return;
  e.stopPropagation();
  cancelAutoNext();
  toast('Keyingi videoga oʻtish bekor qilindi', 1600);
});
video.addEventListener('play', cancelAutoNext);

// ---- Video qo'shish ----

const addForm = { video: null, en: null, lang: 'en', subFile: null };

function resetAddForm() {
  addForm.video = addForm.en = addForm.subFile = null;
  addForm.lang = 'en';
  $('#add-lang').value = 'auto';
  ['#add-video', '#add-sub-en'].forEach((s) => { $(s).value = ''; });
  $('#add-video-name').textContent = 'Tanlanmagan';
  $('#add-sub-en-name').textContent = 'Tanlanmagan';
  $('#add-title').value = '';
  $('#add-status').textContent = '';
  fillPlaylistSelect();
  $('#add-save').disabled = false;
}

function openAdd() {
  resetAddForm();
  openModal('#modal-add');
}

$('#btn-add').addEventListener('click', openAdd);
$('[data-action="add"]').addEventListener('click', openAdd);

$('#add-video').addEventListener('change', (e) => {
  const f = e.target.files[0];
  addForm.video = f || null;
  $('#add-video-name').textContent = f ? `${f.name} (${(f.size / 1048576).toFixed(1)} MB)` : 'Tanlanmagan';
  if (f && !$('#add-title').value) $('#add-title').value = f.name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim();
});

async function pickSub(input, nameEl, key) {
  const f = input.files[0] || addForm.subFile;
  if (!f) return;
  try {
    const cues = await readSubtitleFile(f);
    const choice = $('#add-lang').value;
    const lang = choice === 'auto' ? detectLanguage(cues) : choice;
    keepLanguageOnly(cues, lang); // ostidagi o'zbekcha tarjima qatorlarini olib tashlash
    addForm[key] = cues;
    addForm.lang = lang;
    addForm.subFile = f;
    $(nameEl).textContent = `${f.name} — ${cues.length} ta gap (${LANG_NAME[lang]})`;
  } catch (err) {
    addForm[key] = null;
    input.value = '';
    $(nameEl).textContent = 'Tanlanmagan';
    toast(err.message, 4000);
  }
}
$('#add-sub-en').addEventListener('change', (e) => { addForm.subFile = null; pickSub(e.target, '#add-sub-en-name', 'en'); });
// Tilni qo'lda o'zgartirsa — tanlangan faylni qayta o'qiymiz
$('#add-lang').addEventListener('change', () => { if (addForm.subFile) pickSub($('#add-sub-en'), '#add-sub-en-name', 'en'); });

function makeThumbnail(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      v.load();
      resolve(res);
    };
    setTimeout(() => finish({}), 8000);
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(Math.max(1, v.duration * 0.1), 30);
    };
    v.onseeked = () => {
      try {
        const c = document.createElement('canvas');
        const w = 320;
        const h = Math.round((v.videoHeight / v.videoWidth) * w) || 180;
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        finish({ thumb: c.toDataURL('image/jpeg', 0.7), duration: v.duration });
      } catch (_) {
        finish({ duration: v.duration });
      }
    };
    v.onerror = () => finish({});
    v.src = url;
  });
}

$('#add-save').addEventListener('click', async () => {
  if (!addForm.video) { toast('Avval video faylni tanlang'); return; }
  const btn = $('#add-save');
  btn.disabled = true;
  $('#add-status').textContent = 'Video ilovaga saqlanmoqda… (katta fayllarda biroz vaqt oladi)';
  try {
    const { thumb, duration } = await makeThumbnail(addForm.video);
    const meta = {
      id: db.uid(),
      title: $('#add-title').value.trim() || addForm.video.name,
      fileName: addForm.video.name,
      size: addForm.video.size,
      type: addForm.video.type,
      thumb: thumb || null,
      duration: duration || 0,
      subEn: addForm.en,
      lang: addForm.en ? addForm.lang : 'en',
      offset: 0,
      lastTime: 0,
      createdAt: Date.now(),
    };
    await db.addVideo(meta, addForm.video);
    const plChoice = $('#add-playlist').value;
    if (plChoice === '__new') {
      const name = $('#add-playlist-new').value.trim() || 'Yangi playlist';
      const pl = await db.createPlaylist(name, [meta.id]);
      S.lastPlaylistId = pl.id;
    } else if (plChoice) {
      const pl = S.playlists.find((p) => p.id === plChoice);
      if (pl) await db.updatePlaylist(pl.id, { items: [...pl.items, meta.id] });
      S.lastPlaylistId = plChoice;
    }
    await Promise.all([loadVideos(), loadPlaylists()]);
    closeModal($('#modal-add'));
    renderLibrary();
    toast(meta.subEn ? 'Video saqlandi' : 'Video saqlandi. Subtitrni keyinroq pleyerdagi ⋮ menyusidan qoʻshish yoki avtomatik yaratish mumkin', 3500);
  } catch (err) {
    console.error(err);
    $('#add-status').textContent = 'Saqlab boʻlmadi: ' + (err && err.message ? err.message : err)
      + '. Qurilmada joy yetarli ekanini tekshiring.';
    btn.disabled = false;
  }
});

// ================= Pleyer =================

// opts.playlist — { id, index }: playlist ichidan ochilganda; opts.autoplay — darhol ijro
async function openPlayer(id, atTime, opts = {}) {
  cancelAutoNext();
  if (S.cur && S.cur.id !== id) await saveProgress(true);
  if (S.view !== 'player') S.returnView = S.view;
  S.pl = opts.playlist || null;
  const meta = await db.get('videos', id);
  if (!meta) { toast('Video topilmadi'); return; }
  const blob = await db.get('blobs', id);
  if (!blob) { toast('Video fayli topilmadi'); return; }

  if (S.objectUrl) URL.revokeObjectURL(S.objectUrl);
  S.objectUrl = URL.createObjectURL(blob);
  S.cur = meta;
  S.cues = meta.subEn || [];
  S.lang = meta.lang || 'en';
  // Subtitrda o'zbekcha tarjima qatorlari bo'lsa — faqat asl tildagisini qoldiramiz
  if (keepLanguageOnly(S.cues, S.lang)) db.updateVideo(id, { subEn: S.cues });
  S.offset = meta.offset || 0;
  S.activeIdx = -1;
  S.playIdx = -1;
  S.endFired = false;
  S.loop = false;
  S.revealed = new Set();
  resetShadow();

  renderOverlay();
  $('#player-title').textContent = meta.title;
  video.src = S.objectUrl;
  video.playbackRate = S.settings.defaultSpeed;
  video.defaultPlaybackRate = S.settings.defaultSpeed;
  updateSpeedBtn();

  const start = atTime != null ? atTime : (meta.lastTime && meta.duration && meta.lastTime < meta.duration - 5 ? meta.lastTime : 0);
  video.addEventListener('loadedmetadata', function once() {
    video.removeEventListener('loadedmetadata', once);
    if (start) video.currentTime = start;
    tick(true);
    if (opts.autoplay) video.play().catch(() => {});
  });

  db.updateVideo(id, { openedAt: Date.now() });
  setMode('watch');
  renderTranscript();
  updateLoopBtn();
  renderPlBar();
  showView('player');
  updatePlayBtn();
}

async function closePlayer() {
  cancelAutoNext();
  video.pause();
  await saveProgress(true);
  setFullscreen(false, { leavingPlayer: true });
  resetShadow();
  if (recorder.recording) await recorder.stop();
  recorder.release();
  video.removeAttribute('src');
  video.load();
  if (S.objectUrl) { URL.revokeObjectURL(S.objectUrl); S.objectUrl = null; }
  S.cur = null;
  S.pl = null;
  await loadVideos();
  showView(S.returnView === 'player' ? 'library' : S.returnView || 'library');
}

$('#btn-back').addEventListener('click', closePlayer);

async function saveProgress(force) {
  if (!S.cur) return;
  const now = Date.now();
  if (!force && now - S.lastSave < 4000) return;
  S.lastSave = now;
  const patch = { lastTime: video.currentTime || 0 };
  if (isFinite(video.duration) && video.duration) patch.duration = video.duration;
  await db.updateVideo(S.cur.id, patch).catch(() => {});
}

// ---- Vaqtni kuzatish ----

let rafId = 0;
function loop() {
  tick();
  rafId = video.paused ? 0 : requestAnimationFrame(loop);
}

function subTime() {
  return video.currentTime - S.offset;
}

function tick(force) {
  const t = subTime();
  const cues = S.cues;
  const idx = activeCueAt(cues, t);
  if (idx !== S.activeIdx || force) {
    S.activeIdx = idx;
    renderOverlay();
    highlightTranscript();
  }
  const pi = cueIndexAt(cues, t);
  if (pi !== S.playIdx) {
    S.playIdx = pi;
    S.endFired = false;
    if (S.mode === 'shadow') renderShadowLine();
  }
  if (pi >= 0 && !S.endFired && !video.paused && t >= cues[pi].end - 0.05) {
    S.endFired = true;
    onCueEnd(pi);
  }
  updateTime();
}

function updateTime() {
  const d = video.duration || 0;
  $('#time-cur').textContent = formatTime(video.currentTime);
  $('#time-dur').textContent = formatTime(d);
  if (!seeking) $('#seek').value = d ? Math.round((video.currentTime / d) * 1000) : 0;
}

video.addEventListener('play', () => {
  if (!rafId) rafId = requestAnimationFrame(loop);
  updatePlayBtn();
  armIdle();
});
video.addEventListener('pause', () => { updatePlayBtn(); saveProgress(true); showControls(); });
video.addEventListener('timeupdate', () => { if (video.paused) tick(); saveProgress(false); });
video.addEventListener('seeked', () => tick());
video.addEventListener('durationchange', updateTime);
video.addEventListener('ended', () => {
  updatePlayBtn();
  saveProgress(true);
  if (S.pl && S.settings.autoplayNext) scheduleAutoNext();
});
video.addEventListener('error', () => {
  if (!S.cur) return;
  toast('Bu videoni qurilma oʻynata olmadi. MP4 (H.264/AAC) formatidagi video tavsiya etiladi.', 6000);
});

function updatePlayBtn() {
  const playing = !video.paused;
  $('#c-play use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#big-play').classList.toggle('hidden', playing || !S.cur || S.sh.waiting);
}

function play() {
  if (S.sh.waiting) { shadowContinue(); return; }
  video.play().catch(() => {});
}

function togglePlay() {
  if (video.paused) play();
  else { video.pause(); cancelShadowWait(); }
}

function seekTo(time) {
  const d = video.duration || Infinity;
  video.currentTime = Math.max(0, Math.min(time, d - 0.1));
  S.endFired = false;
}

function seekToCue(i, autoplay = true) {
  if (i < 0 || i >= S.cues.length) return;
  cancelShadowWait();
  S.endFired = false;
  video.currentTime = Math.max(0, S.cues[i].start + S.offset + 0.001);
  tick();
  if (autoplay) video.play().catch(() => {});
}

function currentLine() {
  const t = subTime();
  const i = cueIndexAt(S.cues, t);
  return i;
}

function prevLine() {
  const i = currentLine();
  if (i < 0) return seekToCue(0);
  const t = subTime();
  // gap boshidan 1 soniyadan ko'p o'tgan bo'lsa — shu gapning boshiga, aks holda oldingisiga
  seekToCue(t - S.cues[i].start > 1 ? i : Math.max(0, i - 1));
}

function nextLine() {
  const i = currentLine();
  seekToCue(Math.min(S.cues.length - 1, i + 1));
}

function replayLine() {
  const i = currentLine();
  if (i >= 0) seekToCue(i);
}

// ---- Gap tugaganda ----

function onCueEnd(i) {
  if (S.mode === 'shadow') { shadowPause(i); return; }
  if (S.loop) { seekToCue(i); return; }
  if (S.mode === 'listen' && $('#l-autopause').checked) {
    video.pause();
    setStatus('<svg><use href="#i-replay"/></svg>Qayta eshiting yoki davom eting');
  }
}

let statusTimer;
function setStatus(html, ms = 2500) {
  const el = $('#stage-status');
  el.innerHTML = html;
  el.classList.remove('hidden');
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
function clearStatus() {
  clearTimeout(statusTimer);
  $('#stage-status').classList.add('hidden');
}

// ---- Subtitr ko'rsatish ----

function renderOverlay() {
  const en = $('#sub-overlay .sub-en');
  const uz = $('#sub-overlay .sub-uz');
  const idx = S.activeIdx;
  en.classList.remove('blurred');
  if (S.subMode === 'off') {
    en.innerHTML = '';
    uz.textContent = '';
    return;
  }
  if (idx < 0) {
    en.innerHTML = '';
    uz.textContent = '';
    return;
  }
  const cue = S.cues[idx];
  en.innerHTML = cueHTML(cue);
  en.dataset.ci = idx;
  const hidden = S.subMode === 'hidden' && !S.revealed.has(idx);
  en.classList.toggle('blurred', hidden);

  uz.textContent = '';
  const wantUz = S.subMode === 'en+uz' || (S.settings.autoTranslateLine && !hidden && S.subMode === 'en');
  if (wantUz && !hidden) {
    translate(cue.text, S.lang).then((r) => {
      if (S.activeIdx === idx) uz.textContent = r.text;
    }).catch(() => {});
  }
}

function setSubMode(m) {
  S.subMode = m;
  const b = $('#c-subs');
  $('span', b).textContent = subLabel(m);
  b.classList.toggle('off', m === 'off');
  if ($('#l-hide')) $('#l-hide').checked = m === 'hidden';
  renderOverlay();
  refreshTranscriptBlur();
}

$('#c-subs').addEventListener('click', () => {
  const next = SUB_MODES[(SUB_MODES.indexOf(S.subMode) + 1) % SUB_MODES.length];
  setSubMode(next);
  toast('Subtitr: ' + subLabel(next), 1200);
});

// ---- Transcript ----

function renderTranscript() {
  const tr = $('#transcript');
  if (!S.cues.length) {
    tr.innerHTML = `<div class="empty small">Bu videoga subtitr qoʻshilmagan.<br>Yuqoridagi <b>⋮</b> menyusidan .srt yoki .vtt faylini qoʻshing<br>yoki uni avtomatik yarating.<br><br><button class="btn primary" data-gen><svg><use href="#i-magic"/></svg>Subtitrni avtomatik yaratish</button></div>`;
    return;
  }
  tr.innerHTML = S.cues.map((c) => `
    <div class="tl" data-ci="${c.i}">
      <button class="tl-time" data-seek="${c.i}">${formatTime(c.start)}</button>
      <div class="tl-text">${cueHTML(c)}</div>
      <button class="tl-tr" data-tr="${c.i}">UZ</button>
      <div class="tl-uz"></div>
    </div>`).join('');
  refreshTranscriptBlur();
  highlightTranscript(true);
}

function refreshTranscriptBlur() {
  const hide = S.subMode === 'hidden';
  $$('#transcript .tl').forEach((row) => {
    const i = +row.dataset.ci;
    row.classList.toggle('blurred', hide && !S.revealed.has(i));
  });
}

let lastHl = null;
function highlightTranscript(forceScroll) {
  const idx = S.activeIdx >= 0 ? S.activeIdx : S.playIdx;
  const row = idx >= 0 ? $(`#transcript .tl[data-ci="${idx}"]`) : null;
  if (lastHl && lastHl !== row) lastHl.classList.remove('active');
  if (!row) return;
  row.classList.add('active');
  if (lastHl !== row || forceScroll) {
    lastHl = row;
    const recentlyScrolled = Date.now() - S.userScrollAt < 4000;
    if ($('#t-autoscroll').checked && (!recentlyScrolled || forceScroll)) {
      const box = $('#transcript');
      const top = row.offsetTop - box.clientHeight / 3;
      box.scrollTo({ top, behavior: forceScroll ? 'auto' : 'smooth' });
    }
  }
}

['touchmove', 'wheel'].forEach((ev) => $('#transcript').addEventListener(ev, () => { S.userScrollAt = Date.now(); }, { passive: true }));

$('#transcript').addEventListener('click', async (e) => {
  if (e.target.closest('[data-gen]')) { openGen(); return; }
  const seek = e.target.closest('[data-seek]');
  if (seek) { seekToCue(+seek.dataset.seek); return; }

  const trBtn = e.target.closest('[data-tr]');
  if (trBtn) {
    const i = +trBtn.dataset.tr;
    const out = trBtn.parentElement.querySelector('.tl-uz');
    if (out.textContent) { out.textContent = ''; return; }
    out.textContent = 'Tarjima qilinmoqda…';
    try {
      out.textContent = (await translate(S.cues[i].text, S.lang)).text;
    } catch (err) {
      out.textContent = err.message;
    }
    return;
  }

  const row = e.target.closest('.tl');
  if (!row) return;
  const i = +row.dataset.ci;
  if (row.classList.contains('blurred')) {
    S.revealed.add(i);
    refreshTranscriptBlur();
    if (S.activeIdx === i) renderOverlay();
    return;
  }
  const w = e.target.closest('.w');
  if (w) { openWord(+w.dataset.ci, +w.dataset.wi); return; }
  seekToCue(i);
});

// ---- Subtitr ustiga bosish ----

$('#sub-overlay').addEventListener('click', (e) => {
  e.stopPropagation();
  const en = e.target.closest('.sub-en');
  if (en && en.classList.contains('blurred')) {
    S.revealed.add(+en.dataset.ci);
    renderOverlay();
    refreshTranscriptBlur();
    return;
  }
  const w = e.target.closest('.w');
  if (w) openWord(+w.dataset.ci, +w.dataset.wi);
});

// ---- Boshqaruv tugmalari ----

$('#c-play').addEventListener('click', togglePlay);
$('#c-back5').addEventListener('click', () => seekTo(video.currentTime - 5));
$('#c-fwd5').addEventListener('click', () => seekTo(video.currentTime + 5));
$('#c-prev').addEventListener('click', prevLine);
$('#c-next').addEventListener('click', nextLine);
$('#c-replay').addEventListener('click', replayLine);

function updateLoopBtn() {
  $('#c-loop').classList.toggle('on', S.loop);
}
$('#c-loop').addEventListener('click', () => {
  S.loop = !S.loop;
  updateLoopBtn();
  toast(S.loop ? 'Joriy gap takrorlanadi' : 'Takrorlash oʻchirildi', 1400);
});

function updateSpeedBtn() {
  const r = video.playbackRate;
  $('#c-speed').textContent = (Math.round(r * 100) / 100) + '×';
}
$('#c-speed').addEventListener('click', () => {
  const cur = video.playbackRate;
  const i = SPEEDS.findIndex((s) => s > cur + 0.001);
  const next = i === -1 ? SPEEDS[0] : SPEEDS[i];
  video.playbackRate = next;
  updateSpeedBtn();
});
video.addEventListener('ratechange', updateSpeedBtn);

let seeking = false;
$('#seek').addEventListener('input', (e) => {
  seeking = true;
  const d = video.duration || 0;
  $('#time-cur').textContent = formatTime((e.target.value / 1000) * d);
});
$('#seek').addEventListener('change', (e) => {
  seeking = false;
  const d = video.duration || 0;
  cancelShadowWait();
  seekTo((e.target.value / 1000) * d);
});

video.addEventListener('click', () => {
  if (document.body.classList.contains('fs') && $('#stage').classList.contains('idle')) { showControls(); return; }
  togglePlay();
});

// ---- To'liq ekran ----

// Hamma narsa sinxron bajariladi: avval interfeys, keyin tizim panellari va ekran yo'nalishi.
// (Oldin brauzer fullscreen va'dasini kutib qolib, kichraytirish ishlamay qolardi.)
function setFullscreen(on, { leavingPlayer = false } = {}) {
  const isOn = document.body.classList.contains('fs');
  if (on !== isOn) {
    document.body.classList.toggle('fs', on);
    $('#c-fs use').setAttribute('href', on ? '#i-fs-exit' : '#i-fs');
    $('#c-fs').title = on ? 'Kichik ekran' : 'Toʻliq ekran';
    $('#stage').classList.toggle('with-controls', on);
    setSystemBarsHidden(on);
  }
  // To'liq ekranda — yotiq, pleyerda — tik, pleyerdan chiqqach — erkin
  setOrientation(on ? 'landscape' : (leavingPlayer ? null : 'portrait'));
  showControls();
}
$('#c-fs').addEventListener('click', (e) => {
  e.stopPropagation();
  setFullscreen(!document.body.classList.contains('fs'));
});
// Brauzerda Esc bilan chiqilganda interfeysni ham qaytaramiz
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('fs')) setFullscreen(false);
});

let idleTimer;
function showControls() {
  $('#stage').classList.remove('idle');
  armIdle();
}
function armIdle() {
  clearTimeout(idleTimer);
  if (!document.body.classList.contains('fs')) return;
  idleTimer = setTimeout(() => {
    if (!video.paused) $('#stage').classList.add('idle');
  }, 3000);
}
$('#controls').addEventListener('pointerdown', showControls);

// ================= Rejimlar =================

function setMode(mode) {
  const prev = S.mode;
  S.mode = mode;
  $$('.mode-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $$('#mode-panel .panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== mode));
  resetShadow();
  clearStatus();

  if (mode === 'listen') {
    $('#l-autopause').checked = S.settings.listenAutoPause;
    setSubMode(S.settings.listenHideSubs ? 'hidden' : 'en');
    $('#l-result').innerHTML = '';
  } else if (prev === 'listen' || S.subMode === 'hidden') {
    setSubMode('en');
  } else {
    setSubMode(S.subMode);
  }

  if (mode === 'shadow') {
    $('#sh-rep-sel').value = String(S.settings.shadowRepeats);
    $('#sh-factor-sel').value = String(S.settings.shadowPauseFactor);
    $('#sh-autorec').checked = S.settings.shadowAutoRecord;
    renderShadowLine();
  }
}

$$('.mode-tabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---- Listening ----

$('#l-autopause').addEventListener('change', (e) => {
  S.settings.listenAutoPause = e.target.checked;
  db.saveSettings(S.settings);
});
$('#l-hide').addEventListener('change', (e) => {
  S.settings.listenHideSubs = e.target.checked;
  db.saveSettings(S.settings);
  setSubMode(e.target.checked ? 'hidden' : 'en');
});
$('#l-replay').addEventListener('click', () => { $('#l-result').innerHTML = ''; replayLine(); });
$('#l-reveal').addEventListener('click', () => {
  const i = S.activeIdx >= 0 ? S.activeIdx : currentLine();
  if (i < 0) return;
  S.revealed.add(i);
  renderOverlay();
  refreshTranscriptBlur();
  if (S.activeIdx !== i) toast(S.cues[i].text, 4000);
});
$('#l-next').addEventListener('click', () => {
  $('#l-input').value = '';
  $('#l-result').innerHTML = '';
  clearStatus();
  const i = currentLine();
  const t = subTime();
  // gap oxirida turgan bo'lsak — keyingisiga, aks holda davom
  if (i >= 0 && t >= S.cues[i].end - 0.2) seekToCue(i + 1);
  else video.play().catch(() => {});
});
$('#l-check').addEventListener('click', () => {
  const i = currentLine();
  if (i < 0) { toast('Avval gapni tinglang'); return; }
  const typed = $('#l-input').value.trim();
  if (!typed) { toast('Eshitganingizni yozing'); return; }
  const { result, score } = compareDictation(S.cues[i].text, typed);
  const cls = score >= 90 ? 'ok' : score >= 60 ? '' : 'miss';
  $('#l-result').innerHTML = `<span class="score ${cls}">${score}%</span>` + result.map((r) => {
    if (r.extra) return `<span class="extra">${esc(r.w)}</span>`;
    return `<span class="${r.ok ? 'ok' : 'miss'}">${esc(r.w)}</span>`;
  }).join(' ');
  S.revealed.add(i);
  renderOverlay();
  refreshTranscriptBlur();
});

// ---- Shadowing ----

function resetShadow() {
  clearInterval(S.sh.timer);
  S.sh = { idx: -1, reps: 0, timer: null, waiting: false, until: 0 };
  $('#sh-count') && $('#sh-count').classList.add('hidden');
  updateShadowMeta();
}

function cancelShadowWait() {
  if (!S.sh.waiting) return;
  clearInterval(S.sh.timer);
  S.sh.waiting = false;
  $('#sh-count').classList.add('hidden');
  clearStatus();
  if (recorder.recording && $('#sh-autorec').checked) stopRecording();
  updatePlayBtn();
}

function updateShadowMeta() {
  const el = $('#sh-rep');
  if (!el) return;
  const total = S.settings ? S.settings.shadowRepeats : 1;
  el.textContent = `Takror: ${Math.min(S.sh.reps + 1, total)} / ${total}`;
}

function renderShadowLine() {
  const el = $('#sh-line');
  const i = S.playIdx >= 0 ? S.playIdx : 0;
  if (!S.cues.length) {
    el.textContent = 'Shadowing uchun subtitr kerak.';
    return;
  }
  el.classList.add('big');
  el.innerHTML = cueHTML(S.cues[i]);
  updateShadowMeta();
}

$('#sh-line').addEventListener('click', (e) => {
  const w = e.target.closest('.w');
  if (w) openWord(+w.dataset.ci, +w.dataset.wi);
});

function shadowPause(i) {
  video.pause();
  if (S.sh.idx !== i) { S.sh.idx = i; S.sh.reps = 0; }
  const cue = S.cues[i];
  const factor = +$('#sh-factor-sel').value || 1.3;
  const dur = Math.max(1.5, ((cue.end - cue.start) / (video.playbackRate || 1)) * factor);
  S.sh.waiting = true;
  S.sh.until = Date.now() + dur * 1000;
  updatePlayBtn();

  if ($('#sh-autorec').checked) startRecording();

  const countEl = $('#sh-count');
  countEl.classList.remove('hidden');
  const upd = () => {
    const left = Math.max(0, (S.sh.until - Date.now()) / 1000);
    countEl.textContent = `Sizning navbatingiz: ${left.toFixed(1)} s`;
    setStatus(`<svg><use href="#i-mic"/></svg>Takrorlang… ${Math.ceil(left)}`, 0);
    if (left <= 0) shadowContinue();
  };
  upd();
  clearInterval(S.sh.timer);
  S.sh.timer = setInterval(upd, 100);
}

async function shadowContinue() {
  const i = S.sh.idx;
  clearInterval(S.sh.timer);
  S.sh.waiting = false;
  $('#sh-count').classList.add('hidden');
  clearStatus();
  if (recorder.recording && $('#sh-autorec').checked) await stopRecording();
  const total = +$('#sh-rep-sel').value || 1;
  S.sh.reps++;
  if (S.sh.reps < total) {
    updateShadowMeta();
    seekToCue(i);
  } else {
    S.sh.reps = 0;
    S.sh.idx = -1;
    updateShadowMeta();
    if (i + 1 < S.cues.length) seekToCue(i + 1);
    else toast('Barakalla! Video oxiriga yetdingiz 🎉');
  }
}

$('#sh-orig').addEventListener('click', () => {
  const i = S.sh.idx >= 0 ? S.sh.idx : currentLine();
  if (i < 0) return;
  cancelShadowWait();
  seekToCue(i);
});

$('#sh-skip').addEventListener('click', () => {
  cancelShadowWait();
  S.sh.reps = 0;
  S.sh.idx = -1;
  const i = currentLine();
  seekToCue(Math.min(S.cues.length - 1, i + 1));
});

async function startRecording() {
  try {
    await recorder.start();
    $('#sh-rec').classList.add('on');
    $('#sh-rec span').textContent = 'Toʻxtatish';
    $('#sh-rec use').setAttribute('href', '#i-stop');
  } catch (err) {
    toast('Mikrofonga ruxsat berilmadi: ' + (err.message || err), 4000);
    $('#sh-autorec').checked = false;
  }
}

async function stopRecording() {
  await recorder.stop();
  $('#sh-rec').classList.remove('on');
  $('#sh-rec span').textContent = 'Yozish';
  $('#sh-rec use').setAttribute('href', '#i-mic');
  $('#sh-mine').disabled = !recorder.url;
}

$('#sh-rec').addEventListener('click', async () => {
  if (recorder.recording) await stopRecording();
  else {
    video.pause();
    await startRecording();
  }
});

$('#sh-mine').addEventListener('click', () => {
  video.pause();
  recorder.play();
});

$('#sh-rep-sel').addEventListener('change', (e) => {
  S.settings.shadowRepeats = +e.target.value;
  db.saveSettings(S.settings);
  updateShadowMeta();
});
$('#sh-factor-sel').addEventListener('change', (e) => {
  S.settings.shadowPauseFactor = +e.target.value;
  db.saveSettings(S.settings);
});
$('#sh-autorec').addEventListener('change', (e) => {
  S.settings.shadowAutoRecord = e.target.checked;
  db.saveSettings(S.settings);
});

// ================= So'z tarjimasi oynasi =================

let wasPlaying = false;

function openWord(ci, wi) {
  const cue = S.cues[ci];
  if (!cue) return;
  wasPlaying = !video.paused;
  cancelShadowWait();
  if (S.settings.pauseOnWordTap && wasPlaying) video.pause();
  const ws = words(cue.text);
  S.word = { ci, cue, words: ws, from: wi, to: wi, sentTr: null };
  $('#w-chips').innerHTML = ws.map((w, k) => `<button data-k="${k}">${esc(w)}</button>`).join('');
  $('#w-sent-tr').textContent = '';
  $('#w-sent-tr').classList.remove('loading');
  openModal('#sheet');
  updateSelection();
}

function selectionText() {
  const w = S.word;
  return w.words.slice(w.from, w.to + 1).join(' ');
}

let wordReq = 0;
async function updateSelection() {
  const w = S.word;
  $$('#w-chips button').forEach((b) => {
    const k = +b.dataset.k;
    b.classList.toggle('sel', k >= w.from && k <= w.to);
  });
  const text = selectionText();
  $('#w-word').textContent = text;
  $('#w-google').href = googleTranslateLink(text, S.lang);
  const trEl = $('#w-trans');
  trEl.className = 'w-trans loading';
  trEl.textContent = 'Tarjima qilinmoqda…';
  $('#w-dict').innerHTML = '';
  $('#w-edit').value = '';

  const saved = S.vocab.find((v) => normWord(v.word) === normWord(text));
  $('#w-save').innerHTML = saved
    ? '<svg><use href="#i-check"/></svg>Saqlangan'
    : '<svg><use href="#i-star"/></svg>Saqlash';

  const req = ++wordReq;
  // Bitta so'z bo'lsa kichik harf bilan so'raymiz (Google lug'at ma'nolarini shunda beradi)
  const query = w.from === w.to ? text.toLowerCase() : text;
  try {
    const r = await translate(query, S.lang);
    if (req !== wordReq) return;
    trEl.className = 'w-trans';
    trEl.textContent = r.text;
    $('#w-edit').value = saved ? saved.translation : r.text;
    $('#w-dict').innerHTML = (r.dict || []).map((d) =>
      `<div>${d.pos ? `<span class="pos">${esc(d.pos)}</span>` : ''}${d.terms.map(esc).join(', ')}</div>`).join('');
  } catch (err) {
    if (req !== wordReq) return;
    trEl.className = 'w-trans error';
    trEl.textContent = err.message;
    $('#w-edit').value = saved ? saved.translation : '';
    $('#w-edit').placeholder = 'Tarjimani oʻzingiz yozing';
  }
}

$('#w-chips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-k]');
  if (!b || !S.word) return;
  const k = +b.dataset.k;
  const w = S.word;
  if (k < w.from) w.from = k;
  else if (k > w.to) w.to = k;
  else if (w.from === w.to) return;
  else if (k === w.from) w.from++;
  else if (k === w.to) w.to--;
  else { w.from = w.to = k; }
  updateSelection();
});

$('#w-speak').addEventListener('click', () => {
  speak(selectionText(), 0.85, S.lang).catch((err) => toast(err.message));
});
$('#w-sent-speak').addEventListener('click', () => {
  if (!S.word) return;
  speak(S.word.cue.text.replace(/\n/g, ' '), 0.85, S.lang).catch((err) => toast(err.message));
});

$('#w-sent-btn').addEventListener('click', async () => {
  if (!S.word) return;
  const el = $('#w-sent-tr');
  el.classList.add('loading');
  el.textContent = 'Tarjima qilinmoqda…';
  try {
    const r = await translate(S.word.cue.text.replace(/\n/g, ' '), S.lang);
    el.classList.remove('loading');
    el.textContent = r.text;
    S.word.sentTr = r.text;
  } catch (err) {
    el.textContent = err.message;
  }
});

$('#w-save').addEventListener('click', async () => {
  if (!S.word) return;
  const word = selectionText();
  const translation = $('#w-edit').value.trim();
  if (!translation) { toast('Tarjimani yozing'); $('#w-edit').focus(); return; }
  const existing = S.vocab.find((v) => normWord(v.word) === normWord(word));
  const cached = $('#w-trans').classList.contains('error') ? null : $('#w-trans').textContent;
  if (cached && translation !== cached) overrideTranslation(word.toLowerCase(), translation, S.lang).catch(() => {});
  const item = {
    ...(existing || {}),
    id: existing ? existing.id : db.uid(),
    word,
    translation,
    sentence: S.word.cue.text.replace(/\n/g, ' '),
    sentenceTr: S.word.sentTr || (existing && existing.sentenceTr) || '',
    videoId: S.cur ? S.cur.id : null,
    videoTitle: S.cur ? S.cur.title : '',
    time: S.word.cue.start,
    lang: S.lang,
    level: existing ? existing.level : 0,
    createdAt: existing ? existing.createdAt : Date.now(),
  };
  await db.put('vocab', item);
  await loadVocab();
  $('#w-save').innerHTML = '<svg><use href="#i-check"/></svg>Saqlangan';
  toast(existing ? 'Lugʻat yangilandi' : `“${word}” lugʻatga saqlandi`);
  renderOverlay();
  const row = $(`#transcript .tl[data-ci="${S.word.ci}"] .tl-text`);
  if (row) row.innerHTML = cueHTML(S.word.cue);
  if (S.mode === 'shadow') renderShadowLine();
});

function onSheetClosed() {
  wordReq++;
  if (S.view === 'player' && S.settings.pauseOnWordTap && wasPlaying && S.mode === 'watch') {
    video.play().catch(() => {});
  }
  wasPlaying = false;
}

// ---- Pleyer menyusi ----

$('#btn-player-menu').addEventListener('click', () => {
  if (!S.cur) return;
  $('#menu-sub-en-name').textContent = S.cues.length ? `${S.cues.length} ta gap yuklangan (${LANG_NAME[S.lang]})` : 'Yoʻq — fayl tanlang';
  $('#menu-lang').value = S.lang;
  $('#menu-title').value = S.cur.title;
  updateOffsetLabel();
  openModal('#modal-menu');
});

function updateOffsetLabel() {
  const o = S.offset;
  $('#menu-offset').textContent = (o > 0 ? '+' : '') + o.toFixed(1) + ' s';
}

$$('#modal-menu [data-offset]').forEach((b) => b.addEventListener('click', async () => {
  S.offset = Math.round((S.offset + parseFloat(b.dataset.offset)) * 10) / 10;
  updateOffsetLabel();
  tick(true);
  await db.updateVideo(S.cur.id, { offset: S.offset });
}));

async function replaceSub(input) {
  const f = input.files[0];
  input.value = '';
  if (!f || !S.cur) return;
  try {
    const cues = await readSubtitleFile(f);
    const lang = detectLanguage(cues);
    keepLanguageOnly(cues, lang);
    await db.updateVideo(S.cur.id, { subEn: cues, lang });
    S.cues = cues;
    setLang(lang);
    S.revealed = new Set();
    renderTranscript();
    S.activeIdx = -2;
    tick(true);
    toast(`Subtitr yuklandi: ${cues.length} ta gap (${LANG_NAME[lang]})`);
    closeModal($('#modal-menu'));
  } catch (err) {
    toast(err.message, 4000);
  }
}
$('#menu-sub-en').addEventListener('change', (e) => replaceSub(e.target));

function setLang(lang) {
  S.lang = lang;
  if (S.cur) S.cur.lang = lang;
  setSubMode(S.subMode); // CC yorlig'i: EN / RU
}

$('#menu-lang').addEventListener('change', async (e) => {
  if (!S.cur) return;
  setLang(e.target.value);
  await db.updateVideo(S.cur.id, { lang: S.lang });
  $('#menu-sub-en-name').textContent = S.cues.length ? `${S.cues.length} ta gap yuklangan (${LANG_NAME[S.lang]})` : 'Yoʻq — fayl tanlang';
  toast(`Subtitr tili: ${LANG_NAME[S.lang]}`, 1600);
});

$('#menu-save-title').addEventListener('click', async () => {
  const t = $('#menu-title').value.trim();
  if (t && S.cur) {
    S.cur.title = t;
    await db.updateVideo(S.cur.id, { title: t });
    $('#player-title').textContent = t;
  }
  closeModal($('#modal-menu'));
});

// ================= Avtomatik subtitr (whisper.cpp, internetsiz) =================

const GEN_STAGE = {
  model: 'Model yuklab olinmoqda (bir marta)',
  upload: 'Video tayyorlanmoqda',
  audio: 'Ovoz ajratilmoqda',
  asr: 'Nutq tanilmoqda',
};

let genJob = null; // { videoId, title, cancelled, stage, percent, asrStart }

function openGen() {
  if (!S.cur) return;
  if (!autosub.isAvailable()) {
    toast('Avtomatik subtitr faqat Android ilovasida ishlaydi', 3500);
    return;
  }
  if (genJob) {
    toast('Avtomatik subtitr allaqachon yaratilmoqda — tugashini kuting', 3000);
    return;
  }
  closeModal($('#modal-menu'));
  $('#gen-video').textContent = S.cur.title;
  $('#gen-lang').value = S.lang || 'en';
  $('#gen-warn').classList.toggle('hidden', !S.cues.length);
  renderGenModels();
  openModal('#modal-gen');
}

async function renderGenModels() {
  const chosen = S.settings.genModel || autosub.DEFAULT_MODEL;
  const rows = await Promise.all(autosub.MODELS.map(async (m) => {
    const have = await autosub.isModelDownloaded(m.id).catch(() => false);
    return `
      <label class="check-row">
        <input type="radio" name="gen-model" value="${m.id}" ${m.id === chosen ? 'checked' : ''}>
        <span class="model-meta"><b>${m.label}</b><small>${m.size} · ${m.note}</small></span>
        ${have ? '<span class="badge ok">✓ yuklangan</span>' : ''}
      </label>`;
  }));
  $('#gen-models').innerHTML = rows.join('');
}

async function renderModelSettings() {
  const box = $('#set-models');
  if (!autosub.isAvailable()) {
    box.innerHTML = '<p class="muted small">Faqat Android ilovasida ishlaydi.</p>';
    return;
  }
  const rows = await Promise.all(autosub.MODELS.map(async (m) => {
    const have = await autosub.isModelDownloaded(m.id).catch(() => false);
    return `
      <div class="check-row">
        <span class="model-meta"><b>${m.label}</b><small>${m.size}</small></span>
        ${have ? `<button class="btn sm" data-delmodel="${m.id}">Oʻchirish</button>` : '<small class="muted">yuklanmagan</small>'}
      </div>`;
  }));
  box.innerHTML = rows.join('');
}

$('#set-models').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-delmodel]');
  if (!b) return;
  if (genJob) { toast('Avval joriy jarayon tugasin'); return; }
  await autosub.deleteModel(b.dataset.delmodel);
  toast('Model oʻchirildi');
  renderModelSettings();
});

$('#menu-gen').addEventListener('click', openGen);

$('#gen-start').addEventListener('click', () => {
  const picked = $('#gen-models input:checked');
  const model = picked ? picked.value : autosub.DEFAULT_MODEL;
  const lang = $('#gen-lang').value;
  S.settings.genModel = model;
  db.saveSettings(S.settings);
  closeModal($('#modal-gen'));
  runGeneration(S.cur.id, S.cur.title, lang, model);
});

function showGen() {
  const bar = $('#gen-bar');
  if (!genJob) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const pct = Math.max(0, Math.min(100, genJob.percent || 0));
  let text = `${GEN_STAGE[genJob.stage] || ''}… ${pct}%`;
  // taxminiy qolgan vaqt (nutqni tanish bosqichida)
  if (genJob.stage === 'asr' && pct >= 3 && genJob.asrStart) {
    const spent = (Date.now() - genJob.asrStart) / 1000;
    const left = Math.round((spent / pct) * (100 - pct) / 60);
    text += left >= 1 ? ` · ~${left} daq qoldi` : ' · 1 daqiqadan kam qoldi';
  }
  $('#gen-text').textContent = `${text} — ${genJob.title}`;
  $('#gen-fill').style.width = pct + '%';
}

function setGenStage(stage, percent) {
  if (!genJob) return;
  if (stage === 'asr' && genJob.stage !== 'asr') genJob.asrStart = Date.now();
  genJob.stage = stage;
  genJob.percent = percent < 0 ? 0 : percent;
  showGen();
}

$('#gen-cancel').addEventListener('click', async () => {
  if (!genJob || !confirm('Avtomatik subtitr yaratish toʻxtatilsinmi?')) return;
  genJob.cancelled = true;
  $('#gen-text').textContent = 'Toʻxtatilmoqda…';
  await autosub.cancel().catch(() => {});
});

async function runGeneration(videoId, title, lang, model) {
  genJob = { videoId, title, cancelled: false, stage: 'upload', percent: 0 };
  showGen();
  const isCancelled = () => !genJob || genJob.cancelled;
  try {
    const support = await autosub.checkSupport();
    if (!support.supported) {
      throw new Error('Bu telefonda avtomatik subtitr ishlamaydi (faqat 64-bitli ARM telefonlar qoʻllab-quvvatlanadi).');
    }
    if (!(await autosub.isModelDownloaded(model))) {
      setGenStage('model', 0);
      await autosub.downloadModel(model, (p) => setGenStage('model', p));
    }
    if (isCancelled()) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });

    const blob = await db.get('blobs', videoId);
    if (!blob) throw new Error('Video fayli topilmadi');
    setGenStage('upload', 0);
    await autosub.uploadVideo(blob, (p) => setGenStage('upload', p), isCancelled);

    setGenStage('audio', 0);
    const cues = await autosub.transcribe({ model, language: lang }, (stage, p) => setGenStage(stage, p));
    if (!cues.length) throw new Error('Videoda nutq topilmadi.');

    await db.updateVideo(videoId, { subEn: cues, lang, offset: 0, subAuto: true });
    await loadVideos();
    if (S.cur && S.cur.id === videoId) {
      S.cues = cues;
      S.offset = 0;
      S.revealed = new Set();
      setLang(lang);
      renderTranscript();
      S.activeIdx = -2;
      tick(true);
    }
    if (S.view === 'library') renderLibrary();
    toast(`Subtitr tayyor: ${cues.length} ta gap — “${title}”`, 5000);
  } catch (err) {
    if (err && (err.code === 'CANCELLED' || err.message === 'cancelled')) toast('Avtomatik subtitr toʻxtatildi');
    else toast('Subtitr yaratib boʻlmadi: ' + ((err && err.message) || err), 7000);
  } finally {
    genJob = null;
    showGen();
  }
}

// ================= Lug'at =================

async function loadVocab() {
  S.vocab = (await db.getAll('vocab')).sort((a, b) => b.createdAt - a.createdAt);
  S.savedWords = new Set(S.vocab.filter((v) => !/\s/.test(v.word)).map((v) => normWord(v.word)));
}

const LVL_COLORS = ['var(--bad)', 'var(--warn)', '#c9d44a', 'var(--good)'];

function highlightIn(sentence, word) {
  const i = sentence.toLowerCase().indexOf(word.toLowerCase());
  if (i < 0) return esc(sentence);
  return esc(sentence.slice(0, i)) + '<b>' + esc(sentence.slice(i, i + word.length)) + '</b>' + esc(sentence.slice(i + word.length));
}

function renderVocab() {
  const q = $('#vocab-search').value.trim().toLowerCase();
  const items = S.vocab.filter((v) => !q || v.word.toLowerCase().includes(q) || v.translation.toLowerCase().includes(q));
  $('#vocab-empty').classList.toggle('hidden', S.vocab.length > 0);
  const learned = S.vocab.filter((v) => v.level >= 3).length;
  $('#vocab-stats').textContent = S.vocab.length ? `Jami: ${S.vocab.length} ta · Oʻrganilgan: ${learned} ta` : '';
  $('#vocab-list').innerHTML = items.map((v) => `
    <div class="vitem" data-id="${v.id}">
      <div class="vw"><span class="lvl" style="background:${LVL_COLORS[Math.min(3, v.level || 0)]}"></span>${esc(v.word)}${v.lang === 'ru' ? ' <span class="badge">RU</span>' : ''}</div>
      <div class="vt">${esc(v.translation)}</div>
      <div class="vbtns">
        <button class="icon-btn" data-speak="${v.id}" title="Talaffuz"><svg><use href="#i-speaker"/></svg></button>
        <button class="icon-btn" data-vdel="${v.id}" title="Oʻchirish"><svg><use href="#i-trash"/></svg></button>
      </div>
      ${v.sentence ? `<div class="vc">${highlightIn(v.sentence, v.word)}${v.sentenceTr ? `<br><span style="color:#d8c27a">${esc(v.sentenceTr)}</span>` : ''}</div>` : ''}
      ${v.videoId && S.videos.some((x) => x.id === v.videoId) ? `<button class="vsrc" data-open="${v.id}">▶ ${esc(v.videoTitle)} · ${formatTime(v.time)}</button>` : ''}
    </div>`).join('');
}

$('#vocab-search').addEventListener('input', renderVocab);

$('#vocab-list').addEventListener('click', async (e) => {
  const sp = e.target.closest('[data-speak]');
  if (sp) {
    const v = S.vocab.find((x) => x.id === sp.dataset.speak);
    if (v) speak(v.word, 0.85, v.lang || 'en').catch((err) => toast(err.message));
    return;
  }
  const del = e.target.closest('[data-vdel]');
  if (del) {
    const v = S.vocab.find((x) => x.id === del.dataset.vdel);
    if (v && confirm(`“${v.word}” lugʻatdan oʻchirilsinmi?`)) {
      await db.del('vocab', v.id);
      await loadVocab();
      renderVocab();
    }
    return;
  }
  const op = e.target.closest('[data-open]');
  if (op) {
    const v = S.vocab.find((x) => x.id === op.dataset.open);
    if (v) openPlayer(v.videoId, Math.max(0, v.time - 0.3));
  }
});

// ---- Kartochkalar ----

let deck = [];
let deckPos = 0;

$('#btn-review').addEventListener('click', () => {
  if (!S.vocab.length) { toast('Lugʻat hali boʻsh'); return; }
  // avval kam bilinadigan so'zlar, bir xil darajadagilar aralashtiriladi
  deck = [...S.vocab]
    .map((v) => ({ v, r: (v.level || 0) + Math.random() * 0.9 }))
    .sort((a, b) => a.r - b.r)
    .slice(0, 20)
    .map((x) => x.v);
  deckPos = 0;
  openModal('#modal-cards');
  showCard();
});

function showCard() {
  if (deckPos >= deck.length) {
    closeModal($('#modal-cards'));
    toast('Takrorlash tugadi! 👏');
    renderVocab();
    return;
  }
  const v = deck[deckPos];
  $('#card-progress').textContent = `${deckPos + 1} / ${deck.length}`;
  $('#card-word').textContent = v.word;
  $('#card-context').innerHTML = v.sentence ? highlightIn(v.sentence, v.word) : '';
  $('#card-answer').textContent = v.translation;
  $('#card-answer').classList.add('hidden');
  $('#card-actions-show').classList.remove('hidden');
  $('#card-actions-grade').classList.add('hidden');
}

$('#card-show').addEventListener('click', () => {
  $('#card-answer').classList.remove('hidden');
  $('#card-actions-show').classList.add('hidden');
  $('#card-actions-grade').classList.remove('hidden');
});
$('#card-speak').addEventListener('click', () => {
  const v = deck[deckPos];
  if (v) speak(v.word, 0.85, v.lang || 'en').catch((err) => toast(err.message));
});

async function grade(known) {
  const v = deck[deckPos];
  v.level = known ? Math.min(5, (v.level || 0) + 1) : 0;
  v.reviewedAt = Date.now();
  await db.put('vocab', v);
  deckPos++;
  showCard();
}
$('#card-yes').addEventListener('click', () => grade(true));
$('#card-no').addEventListener('click', () => grade(false));

// ================= Sozlamalar =================

function applySettings() {
  const root = document.documentElement.style;
  root.setProperty('--sub-base', S.settings.fontSize + 'px');
  root.setProperty('--sub-size', S.settings.fontSize + 'px');
}

async function renderSettings() {
  const s = S.settings;
  $('#set-font').value = s.fontSize;
  $('#set-font-val').textContent = s.fontSize + 'px';
  $('#set-speed').value = String(s.defaultSpeed);
  $('#set-pause-tap').checked = s.pauseOnWordTap;
  $('#set-autotr').checked = s.autoTranslateLine;
  renderModelSettings();
  $('#set-autonext').checked = s.autoplayNext;
  $('#set-listen-pause').checked = s.listenAutoPause;
  $('#set-listen-hide').checked = s.listenHideSubs;
  $('#set-sh-rep').value = String(s.shadowRepeats);
  $('#set-sh-factor').value = String(s.shadowPauseFactor);
  $('#set-sh-rec').checked = s.shadowAutoRecord;

  let info = `${S.videos.length} ta video · ${S.vocab.length} ta soʻz`;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      const mb = (x) => (x / 1048576).toFixed(0) + ' MB';
      info += ` · Band: ${mb(est.usage || 0)}` + (est.quota ? ` / ${mb(est.quota)}` : '');
    }
  } catch (_) { /* ixtiyoriy */ }
  $('#storage-info').textContent = info;
}

function bindSetting(sel, key, parse, ev = 'change') {
  $(sel).addEventListener(ev, (e) => {
    const el = e.target;
    S.settings[key] = parse(el);
    db.saveSettings(S.settings);
    applySettings();
    if (key === 'fontSize') $('#set-font-val').textContent = S.settings.fontSize + 'px';
  });
}
bindSetting('#set-font', 'fontSize', (el) => +el.value, 'input');
bindSetting('#set-speed', 'defaultSpeed', (el) => +el.value);
bindSetting('#set-pause-tap', 'pauseOnWordTap', (el) => el.checked);
bindSetting('#set-autotr', 'autoTranslateLine', (el) => el.checked);
bindSetting('#set-autonext', 'autoplayNext', (el) => el.checked);
bindSetting('#set-listen-pause', 'listenAutoPause', (el) => el.checked);
bindSetting('#set-listen-hide', 'listenHideSubs', (el) => el.checked);
bindSetting('#set-sh-rep', 'shadowRepeats', (el) => +el.value);
bindSetting('#set-sh-factor', 'shadowPauseFactor', (el) => +el.value);
bindSetting('#set-sh-rec', 'shadowAutoRecord', (el) => el.checked);

$('#btn-clear-cache').addEventListener('click', async () => {
  await db.clear('trcache');
  toast('Tarjima keshi tozalandi');
});

// ================= Klaviatura (kompyuterda) =================

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { handleBack(); return; }
  if (S.view !== 'player' || topModal()) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) seekTo(video.currentTime - 5); else prevLine(); break;
    case 'ArrowRight': e.preventDefault(); if (e.shiftKey) seekTo(video.currentTime + 5); else nextLine(); break;
    case 'r': case 'R': replayLine(); break;
    case 'l': case 'L': $('#c-loop').click(); break;
    case 's': case 'S': $('#c-subs').click(); break;
    case 'f': case 'F': $('#c-fs').click(); break;
    default:
  }
});

// ================= Ishga tushirish =================

async function init() {
  S.settings = await db.loadSettings();
  applySettings();
  db.requestPersistence();
  await Promise.all([loadVideos(), loadVocab(), loadPlaylists()]);
  showView('library');

  // Android "orqaga" tugmasi
  const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (App && window.Capacitor.isNativePlatform()) {
    App.addListener('backButton', () => {
      if (!handleBack()) App.exitApp();
    });
    App.addListener('pause', () => { if (S.cur) saveProgress(true); });
  }
  window.addEventListener('pagehide', () => { if (S.cur) saveProgress(true); });
}

init().catch((err) => {
  console.error(err);
  toast('Ilovani ishga tushirishda xato: ' + err.message, 6000);
});

// Test va nosozliklarni tuzatish uchun
window.__tilPlayer = { S, openPlayer, setMode, seekToCue };
