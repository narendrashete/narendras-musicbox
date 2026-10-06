# Narendra's Musicbox

Personal music streaming app. It's a PWA, so it installs on Android ("Install app") and iPhone
(Safari → Share → "Add to Home Screen") from the same web address, with no app store involved.

- **Library** lives on the server's own disk (`C:\Musicbox\library\<Artist>\<Title>.mp3`) and is backed up to OneDrive (`Narendras musicbox`) every 15 minutes
- **Streaming**: songs play over HTTP Range requests, so the phone only buffers what it's
  about to play and nothing is saved on the phone. The app shell is cached; songs never are.
- **Favourites** per user. **Categories** (Comedy, Dance, Spiritual…) are created by the admin
  and assigned from the ✎ button on any song. Admin can also fix a song's title/artist, and
  the file moves to the matching folder.
- **Lyrics** (optional): the admin pastes them in from the ✎ button on a song. Songs that have them
  show a small *Lyrics* tag, and the full player gets a **Lyrics** button. It's off until someone taps it;
  then lyrics take the cover's place on phones (side by side on wide screens) and stay on for every song
  that has them, until tapped off. Playback isn't affected either way.
- **Upload**: any signed-in user can upload MP3s (the real file type is checked, not just the
  extension). Title/artist come from the ID3 tags and exact duplicates are detected. To allow
  more formats later, add them to `ALLOWED_TYPES` in `server/config.js`.
- **Community mentors**: uploads stay hidden from everyone until a mentor approves them (Upload →
  *Waiting for approval*). The admin is always a mentor and can make others mentors with *Make mentor*
  under *People who can use the app*. Mentors can also delete any song (🗑 on the song; the admin uses ✎ → Delete).
- **Users**: no self sign-up. The admin adds people under Upload → *People who can use the app*
  and each gets a one-time password that they must change on first sign-in. A **Send on WhatsApp**
  button (plus **Copy message**) prepares the full invite: link, username, password and install steps.
- **Buddies' invite link** (for growing the audience): the admin sets one shared code (e.g. `MyBuddies`)
  under Upload → *Invite link for buddies*. Then `https://musicbox.narendrashete.com/join/MyBuddies`
  signs anyone in with one tap: no username, no password change, and they stay signed in until
  they sign out. Typing the code as both username and password works too. Each phone becomes its
  own anonymous `Buddy-xxxx` user (with an optional name), so favourites and the dashboard still
  work per person. Buddies can listen, upload and share the link onward. Change the code to
  retire an old link; empty switches it off.

- **Usage dashboard** (admin only, `/admin.html` or Upload tab): who is active, how many are online right now, buddies joined via the invite link, most-played songs, user uploads, and a trouble log (failed sign-ins, songs that won't play, long buffering, failed uploads). Collected silently by the app; no user-facing changes.

Stack: Node 22.13+ (24 on the server) + Express + SQLite (Node's built-in `node:sqlite`, so no
native modules to compile), plain HTML/CSS/JS front end.

## Run

```bash
npm install
cp .env.example .env        # set LIBRARY_DIR and a long random JWT_SECRET
npm run create-user -- narendra --admin   # prints a one-time password
npm start                   # http://localhost:4300
```

- `npm run import -- "E:\music_legacy" "C:\path\to\more\music"` copies MP3s from any folders
  into the library, organised by artist/title (the source files are left alone). Re-running it is safe.
- MP3s dropped straight into the library folder are picked up on server start, or with
  *Rescan OneDrive folder* on the Upload tab.
- `data/musicbox.db` holds users, favourites and categories. Back it up. Don't put it inside
  OneDrive (SQLite and sync clients don't mix).

## Hosting

Live at **https://musicbox.narendrashete.com** on a Windows Server (IIS) box:
- Songs are stored in `C:\Musicbox\library` on the server, so playback never depends on OneDrive.
  Task `Musicbox-Sync` ([run-sync.ps1](deploy/windows-server/run-sync.ps1)) copies new songs to the OneDrive
  folder `Narendras musicbox` every 15 minutes (copy only, it never deletes). It uses its own rclone login,
  which can expire; if so the backup stops but playback is unaffected. The admin **Health check** page
  (`/health.html`) shows the last backup result, free disk space and any missing song files.
- Moving an existing install from the old OneDrive mount (`M:`): run
  [migrate-to-local.ps1](deploy/windows-server/migrate-to-local.ps1) once as administrator. `setup.ps1` is the
  original installer and still sets up the `M:` mount, so don't re-run it on a migrated server.
- To add songs: use the Upload tab, or copy MP3s into `C:\Musicbox\library` and press *Rescan* on the Upload tab.
- Node on `127.0.0.1:4300`, behind an IIS site (URL Rewrite + ARR) with a Let's Encrypt cert from win-acme.
- Both run as SYSTEM startup tasks `Musicbox-Mount` / `Musicbox-App`; logs in `C:\Musicbox\logs`.

**CI/CD**: every push runs [CI](.github/workflows/ci.yml) (install, syntax check, a smoke test that
boots the server, and a parse check of the PowerShell deploy scripts). On the server, the task
`Musicbox-Update` ([update.ps1](deploy/windows-server/update.ps1)) checks GitHub every 5 minutes.
When `main` has a new commit whose checks passed, it downloads it, installs it, restarts the app,
and rolls back automatically if the new version doesn't start. It's pull-based: the server only
makes outbound calls to GitHub, with no open ports and no GitHub runner on the box. The log is
`C:\Musicbox\logs\update.log`, and `C:\Musicbox\deployed.txt` holds the live commit. So to ship
a change, just push to `main`.

First install (once): extract `dist/musicbox-deploy.zip` (code + `initial-data/musicbox.db`, built
locally) into `C:\Musicbox` so you get `C:\Musicbox\app`. Then in an admin PowerShell run
`deploy\windows-server\setup.ps1 -Check` (read-only), then `setup.ps1 -Email <you>`. It's safe to
re-run, and it never overwrites the live DB in `C:\Musicbox\data`.

---
Developed by [Prime Computers](https://www.primecomputers.co.in)
