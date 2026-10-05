'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6V5Zm8 0h4v14h-4V5Z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2V6ZM6 18l8.5-6L6 6v12Z"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21 4.5 13.5a5 5 0 0 1 7.1-7.1l.4.4.4-.4a5 5 0 0 1 7.1 7.1L12 21Z"/></svg>',
  heartO: '<svg viewBox="0 0 24 24"><path d="M12 21 4.5 13.5a5 5 0 0 1 7.1-7.1l.4.4.4-.4a5 5 0 0 1 7.1 7.1L12 21Zm0-2.8 6.1-6.1a3 3 0 0 0-4.3-4.3L12 9.6l-1.8-1.8a3 3 0 0 0-4.3 4.3l6.1 6.1Z"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8L4 17.2ZM17.7 9.1a1 1 0 0 0 0-1.4l-1.4-1.4a1 1 0 0 0-1.4 0l-1.2 1.2 2.8 2.8 1.2-1.2Z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="m14 18-6-6 6-6 1.4 1.4-4.6 4.6 4.6 4.6L14 18Z"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.2-.2-.4-.3Z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6l-2.3-2.3-3.3 3.3-1.4-1.4 3.3-3.3L14 4ZM4 18.6 16.3 6.3l1.4 1.4L5.4 20 4 18.6ZM14.6 13.2l1.4-1.4 1.7 1.7L20 11.2V17h-6l2.3-2.3-1.7-1.5ZM4 5.4 5.4 4l5.2 5.2-1.4 1.4L4 5.4Z"/></svg>',
};

const S = {
  me: null, songs: [], cats: [], byId: new Map(),
  tab: 'songs', sub: null, query: '',
  queue: [], qi: -1,
  shuffle: store.get('mb.shuffle', false), repeat: store.get('mb.repeat', 'off'), // off | all | one
};

// ---------- api ----------
async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const res = await fetch(`/api${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error(data.error || 'Please sign in'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600);
}

// Colourful placeholder "cover" from the artist name - no cover images to download.
function artStyle(name) {
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = h % 360, b = (a + 40) % 360;
  return `background:linear-gradient(135deg,hsl(${a} 65% 52%),hsl(${b} 70% 38%))`;
}
const initial = (s) => String(s).replace(/[^\p{L}\s]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '♪';
const credit = () => `<div class="footer-credit">${$('#creditTpl').innerHTML}</div>`;

// ---------- screens ----------
function show(id) { for (const s of ['login', 'pwd', 'app']) $(`#${s}`).hidden = s !== id; }
function showLogin() { show('login'); audio.pause(); $('#player').hidden = true; }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#loginError').textContent = '';
  try {
    S.me = await api('/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    e.target.reset();
    afterLogin();
  } catch (err) { $('#loginError').textContent = err.message; }
});

function showPwd(forced) {
  show('pwd');
  $('#pwdHint').textContent = forced ? 'First sign-in: please replace the one-time password with your own (at least 8 characters).' : 'Choose a new password (at least 8 characters).';
  $('#pwdCancel').hidden = forced;
}
$('#pwdCancel').onclick = () => show('app');
$('#pwdForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#pwdError').textContent = '';
  try {
    await api('/me/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } });
    e.target.reset(); S.me.mustChangePassword = false; toast('Password saved'); afterLogin();
  } catch (err) { $('#pwdError').textContent = err.message; }
});

async function afterLogin() {
  if (S.me.mustChangePassword) return showPwd(true);
  show('app');
  await loadLibrary();
  render();
  if (S.me.isGuest && !S.me.name && !store.get('mb.askedName', false)) askName();
}

// Optional and skippable: just so the dashboard shows "Ramesh" instead of "Buddy-x7Kq2".
function askName() {
  store.set('mb.askedName', true);
  const el = openSheet(`<h3>Welcome to the Musicbox 🎵</h3>
    <p class="muted" style="margin:0">What should we call you? (optional)</p>
    <input class="field" name="n" placeholder="Your name" autocomplete="name" maxlength="40">
    <div class="actions"><button class="btn ghost" data-close>Skip</button><button class="btn primary" data-ok>Start listening</button></div>`);
  $('[data-ok]', el).onclick = async () => { await saveName($('[name=n]', el).value); closeSheet(); };
}
async function saveName(name) {
  if (!name.trim()) return;
  try { S.me.name = (await api('/me/name', { method: 'PUT', body: { name } })).name; toast(`Hi ${S.me.name}!`); } catch (err) { toast(err.message); }
}

// "Install app" in one tap where the browser allows it (Android/desktop Chrome); iPhone needs Safari's Share menu.
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (S.me && S.tab === 'songs') render(); });
addEventListener('appinstalled', () => { installPrompt = null; store.set('mb.installHidden', true); if (S.me) render(); });
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
function installBanner() {
  if (standalone() || store.get('mb.installHidden', false) || S.tab !== 'songs' || S.query) return '';
  if (installPrompt) return `<div class="install"><span>📲 Add Musicbox to your home screen</span><button class="btn small primary" data-act="install">Install</button><button class="icon-btn" data-act="noinstall" aria-label="Hide">✕</button></div>`;
  if (isIos()) return `<div class="install"><span>📲 To add Musicbox to your home screen: tap Share ⎙ in Safari → <b>Add to Home Screen</b></span><button class="icon-btn" data-act="noinstall" aria-label="Hide">✕</button></div>`;
  return '';
}

async function loadLibrary() {
  const { songs, categories } = await api('/library');
  S.songs = songs; S.cats = categories; S.byId = new Map(songs.map((s) => [s.id, s]));
}

// ---------- rendering ----------
const view = $('#view');
const norm = (s) => String(s || '').toLowerCase();
const matches = (s) => !S.query || norm(`${s.title} ${s.credits || s.artist} ${s.album}`).includes(S.query);

function artistsList() {
  const m = new Map();
  for (const s of S.songs) m.set(s.artist, (m.get(s.artist) || 0) + 1);
  return [...m].sort((a, b) => a[0].localeCompare(b[0]));
}

function songRows(list) {
  if (!list.length) return `<p class="empty">${S.query ? 'No songs match your search.' : 'Nothing here yet.'}</p>`;
  const cur = S.queue[S.qi];
  return `<ul class="list">${list.map((s) => `
    <li class="row${s.id === cur ? ' playing' : ''}" data-id="${s.id}">
      <span class="art" style="${artStyle(s.artist)}">${esc(initial(s.artist))}</span>
      <button class="r-main" data-act="play"><span class="r-title">${esc(s.title)}</span>
        <span class="r-sub">${esc(s.credits || s.artist)}${s.album ? ` · ${esc(s.album)}` : ''}</span></button>
      <span class="dur">${s.duration ? fmt(s.duration) : ''}</span>
      <button class="icon-btn fav${s.fav ? ' on' : ''}" data-act="fav" aria-label="Favourite">${s.fav ? ICON.heart : ICON.heartO}</button>
      ${S.me.isAdmin ? `<button class="icon-btn" data-act="edit" aria-label="Edit">${ICON.edit}</button>` : ''}
    </li>`).join('')}</ul>`;
}

function songsHead(title, list, back) {
  return `<div class="view-head">${back ? `<button class="back" data-act="back">${ICON.back}</button>` : ''}
    <h2>${esc(title)}</h2><span class="count">${list.length} song${list.length === 1 ? '' : 's'}</span></div>
    ${list.length ? `<div class="chips"><button class="chip on play-all" data-act="playall">${ICON.play} Play all</button>
    <button class="chip play-all" data-act="shuffleall">${ICON.shuffle} Shuffle</button></div>` : ''}`;
}

let currentList = []; // what "Play all" / tapping a row queues up

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  let html = '';
  const q = S.query;
  if (S.tab === 'songs') {
    currentList = S.songs.filter(matches);
    html = installBanner() + songsHead(q ? 'Search results' : 'All songs', currentList) + songRows(currentList);
  } else if (S.tab === 'favourites') {
    currentList = S.songs.filter((s) => s.fav && matches(s));
    html = songsHead('Favourites', currentList) + (currentList.length || q ? songRows(currentList)
      : '<p class="empty">Tap the ♡ on any song to keep it here.</p>');
  } else if (S.tab === 'artists') {
    if (S.sub != null) {
      currentList = S.songs.filter((s) => s.artist === S.sub && matches(s));
      html = songsHead(S.sub, currentList, true) + songRows(currentList);
    } else {
      const list = artistsList().filter(([a]) => !q || norm(a).includes(q));
      html = `<div class="view-head"><h2>Artists</h2><span class="count">${list.length}</span></div>
        <div class="grid">${list.map(([a, n]) => `<button class="tile" data-act="open" data-key="${esc(a)}">
          <span class="art" style="${artStyle(a)}">${esc(initial(a))}</span><span><b>${esc(a)}</b><small>${n} song${n === 1 ? '' : 's'}</small></span></button>`).join('')}</div>`;
    }
  } else if (S.tab === 'categories') {
    if (S.sub != null) {
      const cat = S.cats.find((c) => c.id === S.sub);
      currentList = S.songs.filter((s) => (S.sub === 0 ? !s.cats.length : s.cats.includes(S.sub)) && matches(s));
      html = songsHead(cat ? cat.name : 'Not categorised yet', currentList, true) + songRows(currentList);
    } else {
      const counts = new Map(); let none = 0;
      for (const s of S.songs) { s.cats.forEach((c) => counts.set(c, (counts.get(c) || 0) + 1)); if (!s.cats.length) none++; }
      const list = S.cats.filter((c) => !q || norm(c.name).includes(q));
      html = `<div class="view-head"><h2>Categories</h2>${S.me.isAdmin ? '<button class="btn small ghost" data-act="newcat">+ New</button>' : ''}</div>
        ${!S.cats.length ? `<p class="muted">No categories yet.${S.me.isAdmin ? ' Create some (Comedy, Dance, Spiritual…) and tag songs with the ✎ button on any song.' : ''}</p>` : ''}
        <div class="grid">${list.map((c) => `<button class="tile cat" data-act="open" data-key="${c.id}">
          <span class="art" style="${artStyle(c.name)}">${esc(initial(c.name))}</span><span><b>${esc(c.name)}</b><small>${counts.get(c.id) || 0} song${counts.get(c.id) === 1 ? "" : "s"}</small></span></button>`).join('')}
          ${none && !q ? `<button class="tile cat" data-act="open" data-key="0"><span class="art" style="background:#3a3456">?</span><span><b>Not categorised</b><small>${none} song${none === 1 ? "" : "s"}</small></span></button>` : ''}</div>`;
    }
  } else if (S.tab === 'more') {
    html = moreView();
  }
  view.innerHTML = html + credit();
  if (S.tab === 'more') wireMore();
}

// ---------- list interactions ----------
view.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const act = btn.dataset.act;
  const id = Number(btn.closest('[data-id]')?.dataset.id);
  if (act === 'play') playList(currentList.map((s) => s.id), currentList.findIndex((s) => s.id === id));
  else if (act === 'playall') playList(currentList.map((s) => s.id), 0, false);
  else if (act === 'shuffleall') playList(currentList.map((s) => s.id), -1, true);
  else if (act === 'fav') toggleFav(id);
  else if (act === 'edit') editSong(id);
  else if (act === 'open') { S.sub = S.tab === 'categories' ? Number(btn.dataset.key) : btn.dataset.key; render(); scrollTo(0, 0); }
  else if (act === 'back') { S.sub = null; render(); }
  else if (act === 'newcat') newCategory();
  else if (act === 'install') { installPrompt?.prompt(); installPrompt = null; render(); }
  else if (act === 'noinstall') { store.set('mb.installHidden', true); render(); }
});

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.sub = null; S.tab = b.dataset.tab; render(); scrollTo(0, 0);
});

let searchT;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchT);
  searchT = setTimeout(() => { S.query = norm(e.target.value.trim()); if (S.tab === 'more') S.tab = 'songs'; render(); }, 120);
});

async function toggleFav(id) {
  const s = S.byId.get(id); if (!s) return;
  const r = await api(`/songs/${id}/favorite`, { method: s.fav ? 'DELETE' : 'PUT' });
  s.fav = r.fav;
  if (S.tab !== 'more') render();
  syncPlayerUi();
}

// ---------- player ----------
const audio = $('#audio');

function playList(ids, index, shuffle = S.shuffle) {
  if (!ids.length) return;
  if (shuffle) {
    const first = index >= 0 ? ids[index] : null;
    const rest = ids.filter((x) => x !== first);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    ids = first != null ? [first, ...rest] : rest; index = 0;
    if (!S.shuffle) { S.shuffle = true; store.set('mb.shuffle', true); }
  }
  S.queue = ids; S.qi = Math.max(0, index);
  load(true);
}

// ---------- usage + trouble reporting (feeds the admin dashboard) ----------
const report = (path, body) => fetch(`/api${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', keepalive: true,
}).catch(() => {});
const reportProblem = (kind, songId, detail) => report('/problems', { kind, songId, detail });

// Counts real listening time per song (seeks and pauses don't count) and reports it once the
// song has had 20s, so a quick skip doesn't count as a play.
const listen = { id: null, sec: 0, last: 0 };
function flushListen() {
  if (listen.id && listen.sec >= 20) report('/plays', { songId: listen.id, seconds: listen.sec });
  listen.id = null; listen.sec = 0;
}
function trackListen() {
  const id = S.queue[S.qi];
  if (listen.id !== id) { flushListen(); listen.id = id; listen.last = audio.currentTime; }
  const dt = audio.currentTime - listen.last;
  if (dt > 0 && dt < 2) listen.sec += dt;
  listen.last = audio.currentTime;
}
addEventListener('pagehide', flushListen);
addEventListener('error', (e) => reportProblem('js_error', null, `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));

function load(autoplay) {
  const s = S.byId.get(S.queue[S.qi]); if (!s) return;
  flushListen();
  audio.src = `/api/songs/${s.id}/stream`; // streamed in chunks via HTTP Range; nothing saved on the phone
  if (autoplay) audio.play().catch(() => {});
  $('#mini').hidden = false;
  syncPlayerUi();
  if (S.tab !== 'more') render();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title, artist: s.credits || s.artist, album: s.album || "Narendra's Musicbox",
      artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
}

function next(auto = false) {
  if (!S.queue.length) return;
  if (auto && S.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (S.qi < S.queue.length - 1) S.qi++;
  else if (S.repeat === 'all' || !auto) S.qi = 0;
  else return; // end of queue
  load(true);
}
function prev() {
  if (audio.currentTime > 3 || S.qi === 0) { audio.currentTime = 0; return; }
  S.qi--; load(true);
}
const togglePlay = () => (audio.paused ? audio.play().catch(() => {}) : audio.pause());

function syncPlayerUi() {
  const s = S.byId.get(S.queue[S.qi]); if (!s) return;
  const playing = !audio.paused;
  $('#miniTitle').textContent = s.title; $('#miniArtist').textContent = s.credits || s.artist;
  $('#miniArt').setAttribute('style', artStyle(s.artist)); $('#miniArt').textContent = initial(s.artist);
  $('#miniPlay').innerHTML = playing ? ICON.pause : ICON.play; $('#miniNext').innerHTML = ICON.next;
  $('#pTitle').textContent = s.title; $('#pArtist').textContent = s.credits || s.artist;
  $('#bigArt').setAttribute('style', artStyle(s.artist)); $('#bigArt').textContent = initial(s.artist);
  $('#pPlay').innerHTML = playing ? ICON.pause : ICON.play;
  $('#pFav').innerHTML = s.fav ? ICON.heart : ICON.heartO; $('#pFav').classList.toggle('on', s.fav);
  $('#pShuffle').classList.toggle('on', S.shuffle);
  $('#pRepeat').classList.toggle('on', S.repeat !== 'off'); $('#pRepeat').dataset.mode = S.repeat;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

let seeking = false;
audio.addEventListener('timeupdate', () => {
  trackListen();
  const d = audio.duration || S.byId.get(S.queue[S.qi])?.duration || 0;
  const pct = d ? (audio.currentTime / d) * 100 : 0;
  $('#miniBar').style.width = `${pct}%`;
  if (!seeking) $('#seek').value = pct;
  $('#tCur').textContent = fmt(audio.currentTime); $('#tDur').textContent = fmt(d);
  if ('mediaSession' in navigator && audio.duration) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: audio.currentTime, playbackRate: 1 }); } catch {}
  }
});
audio.addEventListener('progress', () => {
  if (!audio.duration || !audio.buffered.length) return;
  const ahead = audio.buffered.end(audio.buffered.length - 1) - audio.currentTime;
  $('#pBuffer').textContent = `Streaming · ${Math.max(0, Math.round(ahead))}s buffered ahead`;
});
let stallTimer;
audio.addEventListener('waiting', () => {
  $('#pBuffer').textContent = 'Buffering…';
  clearTimeout(stallTimer);
  const id = S.queue[S.qi];
  stallTimer = setTimeout(() => { if (audio.readyState < 3 && !audio.paused) reportProblem('stall', id, 'Buffering for over 10 seconds'); }, 10000);
});
audio.addEventListener('playing', () => clearTimeout(stallTimer));
audio.addEventListener('play', syncPlayerUi);
audio.addEventListener('pause', syncPlayerUi);
audio.addEventListener('ended', () => { flushListen(); next(true); });
let retriedId = null;
audio.addEventListener('error', () => {
  const cur = S.queue[S.qi];
  // One quiet retry first: flaky mobile networks / a slow OneDrive fetch often succeed the second time.
  if (audio.src && retriedId !== cur) { retriedId = cur; const t = audio.currentTime; audio.load(); audio.currentTime = t; audio.play().catch(() => {}); return; }
  if (audio.src) { toast("Couldn't play this song - skipping"); reportProblem('play_error', S.queue[S.qi], audio.error?.message || `media error ${audio.error?.code}`); }
  setTimeout(() => next(true), 800);
});

$('#seek').addEventListener('input', () => { seeking = true; const d = audio.duration || 0; $('#tCur').textContent = fmt((d * $('#seek').value) / 100); });
$('#seek').addEventListener('change', () => { if (audio.duration) audio.currentTime = (audio.duration * $('#seek').value) / 100; seeking = false; });

$('#miniPlay').onclick = togglePlay; $('#pPlay').onclick = togglePlay;
$('#miniNext').onclick = () => next(); $('#pNext').onclick = () => next(); $('#pPrev').onclick = prev;
$('#miniOpen').onclick = () => { $('#player').hidden = false; };
$('#playerClose').onclick = () => { $('#player').hidden = true; };
$('#pFav').onclick = () => toggleFav(S.queue[S.qi]);
$('#pShuffle').onclick = () => {
  S.shuffle = !S.shuffle; store.set('mb.shuffle', S.shuffle);
  if (S.shuffle && S.queue.length) { const cur = S.queue[S.qi]; playShuffledKeep(cur); }
  syncPlayerUi();
};
function playShuffledKeep(cur) { // reshuffle what's left without interrupting the current song
  const rest = S.queue.filter((x) => x !== cur);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  S.queue = [cur, ...rest]; S.qi = 0;
}
$('#pRepeat').onclick = () => {
  S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat]; store.set('mb.repeat', S.repeat); syncPlayerUi();
  toast({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat this song' }[S.repeat]);
};

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('previoustrack', prev);
  ms.setActionHandler('nexttrack', () => next());
  try { ms.setActionHandler('seekto', (d) => { audio.currentTime = d.seekTime; }); } catch {}
}

// ---------- sheet ----------
function openSheet(html) { $('#sheetBody').innerHTML = html; $('#sheet').hidden = false; return $('#sheetBody'); }
function closeSheet() { $('#sheet').hidden = true; }
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet' || e.target.dataset.close != null) closeSheet(); });

function catChecks(selected) {
  return `<div class="checks">${S.cats.map((c) => `<label><input type="checkbox" value="${c.id}"${selected.includes(c.id) ? ' checked' : ''}><span>${esc(c.name)}</span></label>`).join('')}</div>`;
}

function editSong(id) {
  const s = S.byId.get(id);
  const el = openSheet(`<h3>Edit song</h3>
    <label>Title<input class="field" name="title" value="${esc(s.title)}"></label>
    <label>Artist (first name = folder; separate several with commas)<input class="field" name="artist" value="${esc(s.credits || s.artist)}"></label>
    <div><label>Categories</label>${S.cats.length ? catChecks(s.cats) : '<p class="muted">No categories yet.</p>'}</div>
    <div class="inline"><input class="field" name="newcat" placeholder="New category, e.g. Spiritual"><button class="btn small ghost" data-add>Add</button></div>
    <p class="muted" style="font-size:12px;margin:0">${s.uploaded_by ? `Uploaded by ${esc(s.uploaded_by)}` : 'Imported from the original collection'}</p>
    <p class="error"></p>
    <div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-save>Save</button></div>`);
  $('[data-add]', el).onclick = async () => {
    const name = $('[name=newcat]', el).value.trim(); if (!name) return;
    const cat = await api('/categories', { method: 'POST', body: { name } });
    if (!S.cats.some((c) => c.id === cat.id)) S.cats.push(cat);
    const checked = [...el.querySelectorAll('.checks input:checked')].map((i) => Number(i.value));
    const wrap = el.querySelector('.checks') || el.querySelector('.muted');
    wrap.outerHTML = catChecks([...checked, cat.id]);
    $('[name=newcat]', el).value = '';
  };
  $('[data-save]', el).onclick = async () => {
    try {
      const body = { cats: [...el.querySelectorAll('.checks input:checked')].map((i) => Number(i.value)) };
      const title = $('[name=title]', el).value.trim(), artist = $('[name=artist]', el).value.trim();
      if (title !== s.title) body.title = title;
      if (artist !== (s.credits || s.artist)) body.artist = artist;
      Object.assign(s, await api(`/songs/${id}`, { method: 'PATCH', body }));
      closeSheet(); render(); syncPlayerUi(); toast('Saved');
    } catch (err) { $('.error', el).textContent = err.message; }
  };
}

function newCategory() {
  const el = openSheet(`<h3>New category</h3><input class="field" name="n" placeholder="e.g. Comedy, Dance, Spiritual">
    <p class="error"></p><div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-ok>Create</button></div>`);
  $('[name=n]', el).focus();
  $('[data-ok]', el).onclick = async () => {
    try {
      const cat = await api('/categories', { method: 'POST', body: { name: $('[name=n]', el).value } });
      if (!S.cats.some((c) => c.id === cat.id)) S.cats.push(cat);
      S.cats.sort((a, b) => a.name.localeCompare(b.name)); closeSheet(); render();
    } catch (err) { $('.error', el).textContent = err.message; }
  };
}

// ---------- upload / account / admin ----------
const uploadPanel = () => `<div class="view-head"><h2>Upload songs</h2></div>
  <div class="panel">
    <label class="drop" id="drop"><input type="file" id="files" accept=".mp3,.m4a,audio/mpeg,audio/mp4" multiple>
      <b>Tap to choose MP3 or M4A files</b><br><small>or drag them here · title &amp; artist are read from the file</small></label>
    <ul class="uploads" id="uploads"></ul>
  </div>
`;

function moreView() {
  if (S.me.isGuest) {
    return `${uploadPanel()}
    <div class="panel"><h3>Your name</h3><p class="muted" style="margin:0">So Narendra knows who's listening. Optional.</p>
      <div class="inline"><input class="field" id="myName" placeholder="Your name" maxlength="40" value="${esc(S.me.name || '')}"><button class="btn small primary" id="saveName">Save</button></div></div>
    ${sharePanel()}
    <div class="panel"><h3>Sign out</h3><p class="muted" style="margin:0">You'll need the invite link again to come back.</p>
      <button class="btn small danger" id="logout" style="align-self:flex-start">Sign out</button></div>`;
  }
  return `${uploadPanel()}
  ${S.me.isAdmin ? `
  <div class="panel"><h3>Categories</h3><div id="catAdmin"></div>
    <div class="inline"><input class="field" id="catName" placeholder="New category"><button class="btn small primary" id="catAdd">Add</button></div></div>
  <div class="panel"><h3>Invite link for buddies</h3>
    <p class="muted" style="margin:0">One link for everyone: WhatsApp status, groups, LinkedIn. Anyone who taps it is in straight away, with no username or password to set. Each phone shows up on the dashboard as its own buddy. Change the code to stop the old link from working; buddies already in stay in. Leave it empty to switch the link off.</p>
    <div class="inline"><input class="field" id="joinCode" placeholder="e.g. MyBuddies" autocapitalize="none"><button class="btn small primary" id="saveJoin">Save</button></div>
    <div id="joinShare"></div></div>
  <div class="panel"><h3>People who can use the app</h3><div id="userList" class="muted">Loading…</div>
    <div class="inline"><input class="field" id="newUser" placeholder="New username" autocapitalize="none"><button class="btn small primary" id="addUser">Add</button></div>
    <div id="newPwd"></div></div>` : sharePanel()}${S.me.isAdmin ? `
  <div class="panel"><h3>Usage dashboard</h3><p class="muted" style="margin:0">Who is active, what's being played, uploads and trouble.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn small primary" href="admin.html" style="text-decoration:none">Open dashboard</a>
    <a class="btn small ghost" href="health.html" style="text-decoration:none">Health check</a></div></div>
  <div class="panel"><h3>Library</h3><p class="muted" style="margin:0">Songs: ${S.songs.length}. If you copied MP3s straight into the OneDrive folder, rescan to pick them up.</p>
    <button class="btn small ghost" id="rescan" style="align-self:flex-start">Rescan OneDrive folder</button></div>` : ''}
  <div class="panel"><h3>Account</h3><p class="muted" style="margin:0">Signed in as <b>${esc(S.me.username)}</b>${S.me.isAdmin ? ' (admin)' : ''}</p>
    <div class="inline"><button class="btn small ghost" id="chPwd">Change password</button><button class="btn small danger" id="logout">Sign out</button></div></div>`;
}

// WhatsApp + Copy buttons for a ready-made message.
function shareButtons(msg) {
  return `<div class="inline"><a class="btn small wa" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener noreferrer">${ICON.whatsapp} Send on WhatsApp</a>
    <button class="btn small ghost" data-copy>Copy message</button></div>`;
}
async function copyText(msg) {
  try { await navigator.clipboard.writeText(msg); toast('Message copied'); return; } catch { /* older phones: fall back below */ }
  const ta = Object.assign(document.createElement('textarea'), { value: msg });
  ta.style.cssText = 'position:fixed;opacity:0'; document.body.append(ta); ta.select();
  const ok = document.execCommand('copy'); ta.remove();
  toast(ok ? 'Message copied' : "Couldn't copy - use Send on WhatsApp instead");
}

// Everyone who's in can forward the buddies' link (filled in by wireMore when a link is set).
const sharePanel = () => `<div class="panel" id="sharePanel" hidden><h3>Share with friends</h3>
  <p class="muted" style="margin:0">Know someone who'd enjoy these songs? Send them the invite link. They're in with one tap.</p><div id="shareBtns"></div></div>`;

function wireMore() {
  if ($('#sharePanel')) {
    api('/invite').then(({ code }) => {
      if (!code || !$('#sharePanel')) return;
      const msg = buddiesMessage(code);
      $('#shareBtns').innerHTML = shareButtons(msg);
      $('#shareBtns [data-copy]').onclick = () => copyText(msg);
      $('#sharePanel').hidden = false;
    }).catch(() => {});
  }
  $('#logout').onclick = async () => {
    if (S.me.isGuest && !confirm("Sign out? You'll need the invite link again to come back.")) return;
    await api('/logout', { method: 'POST' }).catch(() => {}); S.me = null; showLogin();
  };
  const input = $('#files'), drop = $('#drop');
  input.onchange = () => { uploadFiles([...input.files]); input.value = ''; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); };
  if (S.me.isGuest) {
    $('#saveName').onclick = () => saveName($('#myName').value);
    return;
  }
  $('#chPwd').onclick = () => showPwd(false);
  if (!S.me.isAdmin) return;

  const drawJoin = (code) => {
    $('#joinCode').value = code;
    if (!code) { $('#joinShare').innerHTML = '<p class="muted" style="margin:0">Invite link is off.</p>'; return; }
    const msg = buddiesMessage(code);
    $('#joinShare').innerHTML = `<div class="secret">${esc(`${location.origin}/join/${encodeURIComponent(code)}`)}</div>${shareButtons(msg)}`;
    $('#joinShare [data-copy]').onclick = () => copyText(msg);
  };
  api('/admin/join').then((r) => drawJoin(r.code)).catch(() => {});
  $('#saveJoin').onclick = async () => {
    try { drawJoin((await api('/admin/join', { method: 'PUT', body: { code: $('#joinCode').value } })).code); toast('Invite link saved'); }
    catch (err) { toast(err.message); }
  };

  const drawCats = () => {
    $('#catAdmin').innerHTML = S.cats.length ? S.cats.map((c) => `<div class="urow" data-cid="${c.id}"><span>${esc(c.name)}</span>
      <button class="btn small ghost" data-ren>Rename</button><button class="btn small danger" data-del>Delete</button></div>`).join('')
      : '<p class="muted" style="margin:0">None yet.</p>';
  };
  drawCats();
  $('#catAdd').onclick = async () => {
    const name = $('#catName').value.trim(); if (!name) return;
    const cat = await api('/categories', { method: 'POST', body: { name } });
    if (!S.cats.some((c) => c.id === cat.id)) S.cats.push(cat);
    $('#catName').value = ''; drawCats();
  };
  $('#catAdmin').onclick = async (e) => {
    const row = e.target.closest('[data-cid]'); if (!row) return;
    const id = Number(row.dataset.cid), cat = S.cats.find((c) => c.id === id);
    if (e.target.matches('[data-ren]')) {
      const name = prompt('Rename category', cat.name); if (!name?.trim()) return;
      await api(`/categories/${id}`, { method: 'PATCH', body: { name } }); cat.name = name.trim(); drawCats();
    } else if (e.target.matches('[data-del]')) {
      if (!confirm(`Delete category "${cat.name}"? Songs stay in the library.`)) return;
      await api(`/categories/${id}`, { method: 'DELETE' });
      S.cats = S.cats.filter((c) => c.id !== id); S.songs.forEach((s) => (s.cats = s.cats.filter((c) => c !== id))); drawCats();
    }
  };

  const drawUsers = async () => {
    const users = await api('/users');
    $('#userList').innerHTML = users.map((u) => `<div class="urow" data-uid="${u.id}"><span>${esc(u.username)}${u.is_admin ? ' <small class="muted">admin</small>' : ''}</span>
      <button class="btn small ghost" data-reset>Reset password</button>${u.id === S.me.id ? '' : '<button class="btn small danger" data-rm>Remove</button>'}</div>`).join('');
  };
  drawUsers();
  const showPwdOnce = (who, pwd) => {
    const msg = inviteMessage(who, pwd);
    $('#newPwd').innerHTML = `<p class="muted" style="margin:0">One-time password for <b>${esc(who)}</b> - send it to them; they'll set their own on first sign-in:</p>
      <div class="secret">${esc(pwd)}</div>${shareButtons(msg)}`;
    $('#newPwd [data-copy]').onclick = () => copyText(msg);
  };
  $('#addUser').onclick = async () => {
    try { const r = await api('/users', { method: 'POST', body: { username: $('#newUser').value } }); $('#newUser').value = ''; showPwdOnce(r.username, r.password); drawUsers(); }
    catch (err) { toast(err.message); }
  };
  $('#userList').onclick = async (e) => {
    const row = e.target.closest('[data-uid]'); if (!row) return;
    const id = row.dataset.uid, name = row.querySelector('span').firstChild.textContent;
    if (e.target.matches('[data-reset]')) { const r = await api(`/users/${id}/reset`, { method: 'POST' }); showPwdOnce(name, r.password); }
    else if (e.target.matches('[data-rm]') && confirm(`Remove ${name}? Their favourites are removed too; songs they uploaded stay.`)) { await api(`/users/${id}`, { method: 'DELETE' }); drawUsers(); }
  };
  $('#rescan').onclick = async (e) => {
    e.target.disabled = true;
    try { const r = await api('/rescan', { method: 'POST' }); await loadLibrary(); toast(`Rescan done: ${r.added} added, ${r.removed} removed`); render(); }
    finally { e.target.disabled = false; }
  };
}

// Ready-to-send invites, in WhatsApp's formatting (*bold*).
function inviteMessage(username, password) {
  return inviteScript([
    `Open: ${location.origin}`,
    `Username: ${username}`,
    `Password: ${password} (it will ask you to set your own the first time)`,
  ]);
}
// Kept within WhatsApp status limits: 10 lines, 700 characters.
function buddiesMessage(code) {
  return [
    "🎵 *Narendra's Musicbox*, your music collection",
    '',
    `Tap to start listening, no sign-up needed: ${location.origin}/join/${encodeURIComponent(code)}`,
    `(If asked to sign in, type *${code}* as both username and password)`,
    '',
    '*Add it like an app:* Android: Chrome ⋮ → Add to Home screen. iPhone: Safari Share ⎙ → Add to Home Screen.',
    '',
    `Songs stream from the cloud, so no phone storage used. Upload your own MP3s too!`,
    'Happy Listening !!',
  ].join('\n');
}
function inviteScript(howToOpen) {
  return [
    "🎵 *Narendra's Musicbox*, your music collection",
    '',
    ...howToOpen,
    '',
    '*Add it to your phone like an app:*',
    '• *Android (Chrome):* tap ⋮ (top right) → Install app / Add to Home screen',
    '• *iPhone:* open the link in Safari → tap Share ⎙ → Add to Home Screen',
    '',
    `Songs stream from the cloud, so they don't fill up your phone's storage. Tap ♡ to save favourites, and use the Upload tab to add your own MP3s.`,
    '',
    'Happy Listening !!',
  ].join('\n');
}

// One at a time, with progress - phones on mobile data don't like parallel big uploads.
async function uploadFiles(files) {
  const ul = $('#uploads');
  for (const file of files) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(file.name)}</span><div class="bar"><i></i></div><span class="st">Waiting…</span>`;
    ul.prepend(li);
    const st = $('.st', li), bar = $('.bar i', li);
    if (!/\.(mp3|m4a)$/i.test(file.name)) { st.textContent = 'Only MP3 or M4A files are allowed'; st.className = 'st bad'; continue; }
    try {
      const r = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest(), fd = new FormData();
        fd.append('file', file);
        xhr.open('POST', '/api/songs');
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) { bar.style.width = `${(e.loaded / e.total) * 100}%`; st.textContent = `Uploading ${Math.round((e.loaded / e.total) * 100)}%`; } };
        xhr.onload = () => { let d = {}; try { d = JSON.parse(xhr.responseText); } catch {} xhr.status < 300 ? resolve(d) : reject(new Error(d.error || `Error ${xhr.status}`)); };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(fd);
      });
      bar.style.width = '100%';
      if (r.duplicate) { st.textContent = `Already in the library as "${r.song.title}"`; st.className = 'st'; }
      else { st.textContent = `Added: ${r.song.title} - ${r.song.artist}`; st.className = 'st ok'; S.songs.push(r.song); S.byId.set(r.song.id, r.song); }
    } catch (err) { st.textContent = err.message; st.className = 'st bad'; reportProblem('upload_failed', null, `${file.name}: ${err.message}`); }
  }
  S.songs.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

// ---------- boot ----------
document.querySelectorAll('.screen > .footer-credit').forEach((el) => (el.innerHTML = $('#creditTpl').innerHTML));
(async () => {
  // Opened from the buddies' invite link (/join/<code>): sign this phone straight in.
  const join = location.pathname.match(/^\/join\/([^/]+)/);
  if (join) {
    history.replaceState(null, '', '/');
    try { S.me = await api('/join', { method: 'POST', body: { code: decodeURIComponent(join[1]) } }); afterLogin(); }
    catch (err) { showLogin(); $('#loginError').textContent = err.message; }
  } else {
    try { S.me = await api('/me'); afterLogin(); } catch { showLogin(); }
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
