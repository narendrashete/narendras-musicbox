'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('en-IN');
const when = (t) => (t ? new Date(`${t}Z`) : null); // SQLite stores UTC without a zone marker

function ago(t) {
  const d = when(t); if (!d) return 'never';
  const s = (Date.now() - d) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  const days = Math.round(s / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
const hours = (sec) => (sec < 3600 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} hr`);
const KIND = {
  play_error: 'Song would not play', stall: 'Long buffering', upload_failed: 'Upload failed', js_error: 'App error',
  login_wrong_password: 'Wrong password', login_unknown_user: 'Unknown username',
};
const device = (ua = '') => {
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '';
  return [os, br].filter(Boolean).join(' · ') || '—';
};

// Active = listened/opened within 3 days; recent = within 14; otherwise idle. Never = hasn't signed in at all.
function status(u) {
  if (!u.last_login) return ['never', 'Never signed in'];
  const days = (Date.now() - when(u.last_seen || u.last_login)) / 864e5;
  return days <= 3 ? ['active', 'Active'] : days <= 14 ? ['recent', 'Recent'] : ['idle', 'Idle'];
}

// Plain-language reasons a person might be stuck.
function trouble(u) {
  const t = [];
  const ageDays = (Date.now() - when(u.created_at)) / 864e5;
  const other = u.problems - u.failed_logins;
  if (!u.last_login && ageDays > 1) t.push(['Hasn’t signed in since being added ' + Math.round(ageDays) + ' days ago — resend the invite', false]);
  if (u.last_login && u.must_change_password) t.push(['Signed in but still on the one-time password — may be stuck on the “Set your password” screen', false]);
  if (u.failed_logins >= 2) t.push([`${u.failed_logins} failed sign-ins — may have forgotten the password (reset it)`, true]);
  if (other > 0) t.push([`${other} playback/upload problem${other > 1 ? 's' : ''} — see list below`, true]);
  if (u.last_login && !u.plays_ever && !u.uploads) t.push(['Signed in but has never played a song', false]);
  return t;
}

function rankList(items, label, sub, count, unit) {
  if (!items.length) return '<p class="empty">Nothing yet.</p>';
  const max = Math.max(...items.map(count));
  return items.map((it, i) => `<div class="rank"><span class="n">${i + 1}</span>
    <div class="what"><div class="song-title">${esc(label(it))}</div><div class="dim">${sub(it)}</div></div>
    <span class="cnt">${num(count(it))}<small class="dim"> ${unit}</small></span>
    <div class="bar"><i style="width:${(count(it) / max) * 100}%"></i></div></div>`).join('');
}

function dailyChart(daily, days) {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const cols = [];
  const n = Math.min(days, 60); // keep bars readable on long ranges
  for (let i = n - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    cols.push({ day, ...(byDay.get(day) || { plays: 0, listeners: 0 }) });
  }
  const max = Math.max(1, ...cols.map((c) => c.plays));
  const bars = cols.map((c) => `<div style="height:${Math.max(c.plays ? 4 : 1, (c.plays / max) * 100)}%" title="${c.day}: ${c.plays} plays, ${c.listeners} listeners"></div>`).join('');
  const f = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return `<div class="chart">${bars}</div><div class="chart-axis"><span>${f(cols[0].day)}</span><span>${n < days ? `last ${n} days shown` : ''}</span><span>${f(cols.at(-1).day)}</span></div>`;
}

function render(d) {
  const active = d.users.filter((u) => status(u)[0] === 'active').length;
  const stuck = d.users.filter((u) => trouble(u).length).length;
  const probCount = d.problems.filter((p) => !p.kind.startsWith('login_')).length;

  const userRows = d.users.map((u) => {
    const [cls, label] = status(u);
    return `<tr>
      <td><b>${esc(u.username)}</b>${u.is_admin ? ' <small class="dim">admin</small>' : ''}${trouble(u).map(([m, bad]) => `<span class="flag${bad ? ' bad' : ''}">${esc(m)}</span>`).join('')}</td>
      <td><span class="pill ${cls}">${label}</span></td>
      <td>${ago(u.last_seen || u.last_login)}<br><small>${u.last_login ? `signed in ${ago(u.last_login)}` : ''}</small></td>
      <td class="num">${num(u.plays)}<br><small>${u.seconds ? hours(u.seconds) : ''}</small></td>
      <td>${u.last_song ? esc(u.last_song) : '<span class="dim">—</span>'}</td>
      <td class="num">${num(u.uploads)}</td>
      <td class="num">${num(u.favourites)}</td>
    </tr>`;
  }).join('');

  const uploadRows = d.uploads.length
    ? `<div class="tbl-wrap"><table><thead><tr><th>Song</th><th>Uploaded by</th><th>When</th></tr></thead><tbody>${d.uploads.map((s) => `<tr>
        <td><span class="song-title">${esc(s.title)}</span><br><small>${esc(s.artist)}</small></td><td>${esc(s.uploaded_by || '—')}</td><td>${ago(s.created_at)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty">Nobody has uploaded a song yet.</p>';

  const problemRows = d.problems.length
    ? `<div class="tbl-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What happened</th><th>Device</th></tr></thead><tbody>${d.problems.map((p) => `<tr>
        <td>${ago(p.created_at)}</td><td>${esc(p.username || '—')}</td>
        <td><b>${KIND[p.kind] || esc(p.kind)}</b>${p.song ? `<br><small>${esc(p.song)}</small>` : ''}${p.detail ? `<br><small>${esc(p.detail)}</small>` : ''}</td>
        <td><small>${esc(device(p.device))}</small></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty">No problems reported. 🎉</p>';

  $('#main').innerHTML = `
  <div class="kpis">
    <div class="kpi"><b>${active}<small class="dim"> / ${d.totals.users}</small></b><span>users active in last 3 days</span></div>
    <div class="kpi"><b>${num(d.totals.plays)}</b><span>songs played (${d.days} days)</span></div>
    <div class="kpi"><b>${hours(d.totals.seconds)}</b><span>listening time</span></div>
    <div class="kpi"><b>${num(d.totals.uploads)}</b><span>songs uploaded by users</span></div>
    <div class="kpi ${stuck ? 'warn' : ''}"><b>${stuck}</b><span>users who may need help</span></div>
    <div class="kpi ${probCount ? 'bad' : ''}"><b>${probCount}</b><span>playback / upload problems</span></div>
  </div>

  <section><h2>Users</h2><p class="sub">Who is using the app, and who may be stuck. A play counts after 20 seconds of listening.</p>
    <div class="tbl-wrap"><table><thead><tr><th>User</th><th>Status</th><th>Last seen</th><th class="num">Plays (${d.days}d)</th><th>Last song played</th><th class="num">Uploads</th><th class="num">Favs</th></tr></thead><tbody>${userRows}</tbody></table></div></section>

  <div class="grid2">
    <section><h2>Most listened songs</h2><p class="sub">Last ${d.days} days</p>
      ${rankList(d.topSongs, (s) => s.title, (s) => `${esc(s.artist)} · ${s.listeners} listener${s.listeners > 1 ? 's' : ''} · ${hours(s.seconds)} · last ${ago(s.last_played)}`, (s) => s.plays, 'plays')}</section>
    <div style="display:grid;gap:16px;align-content:start">
      <section><h2>Plays per day</h2>${dailyChart(d.daily, d.days)}</section>
      <section><h2>Top artists</h2>
        ${rankList(d.topArtists, (a) => a.artist, (a) => `${a.listeners} listener${a.listeners > 1 ? 's' : ''}`, (a) => a.plays, 'plays')}</section>
    </div>
  </div>

  <div class="grid2">
    <section><h2>Uploads by users</h2><p class="sub">Most recent 20</p>${uploadRows}</section>
    <section><h2>Songs that failed to play</h2><p class="sub">Last ${d.days} days — a file may be corrupt or missing</p>
      ${d.brokenSongs.length ? rankList(d.brokenSongs, (s) => s.title, (s) => `${esc(s.artist)} · ${s.people} ${s.people > 1 ? 'people' : 'person'}`, (s) => s.errors, 'errors') : '<p class="empty">None.</p>'}</section>
  </div>

  <section><h2>Trouble log</h2><p class="sub">Failed sign-ins, songs that wouldn't play, long buffering, failed uploads, app errors — latest 60</p>${problemRows}</section>`;
}

let days = 30;
async function load() {
  try {
    const res = await fetch(`/api/admin/stats?days=${days}`, { credentials: 'same-origin' });
    if (res.status === 401) { $('#main').innerHTML = '<section class="err-card"><h2>Please sign in</h2><p class="sub">Open the app, sign in as admin, then come back.</p><a class="btn primary" href="./">Go to Musicbox</a></section>'; return; }
    if (res.status === 403) { $('#main').innerHTML = '<section class="err-card"><h2>Admin only</h2><p class="sub">This page is for the admin account.</p></section>'; return; }
    if (!res.ok) throw new Error(res.status);
    render(await res.json());
  } catch { if (!$('#main .kpis')) $('#main').innerHTML = '<p class="muted">Couldn’t load the dashboard. Try again in a moment.</p>'; }
}

$('#range').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  days = Number(b.dataset.days);
  document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x === b));
  load();
});
load();
setInterval(load, 60000);
