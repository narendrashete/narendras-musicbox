# Narendra's Musicbox

Personal music streaming app. It's a PWA, so it installs on Android ("Install app") and iPhone
(Safari → Share → "Add to Home Screen") from the same web address, with no app store involved.

- **Library** lives on the server's own disk (`/srv/musicbox/library/<Artist>/<Title>.mp3`) and is backed up to OneDrive (`Narendras musicbox`) every 15 minutes
- **Streaming**: songs play over HTTP Range requests, so the phone only buffers what it's
  about to play and nothing is saved on the phone. The app shell is cached; songs never are.
- **Favourites** per user. **Categories** (Comedy, Dance, Spiritual…) are created by the admin
  and assigned from the ✎ button on any song. Admin can also fix a song's title/artist, and
  the file moves to the matching folder.
- **Lyrics** (optional): a mentor or the admin pastes them in from the ✎ button on a song. Songs that have them
  show a small *Lyrics* tag, and the full player gets a **Lyrics** button. It's off until someone taps it;
  then lyrics take the cover's place on phones (side by side on wide screens) and stay on for every song
  that has them, until tapped off. Playback isn't affected either way.
- **Upload**: any signed-in user can upload MP3s (the real file type is checked, not just the
  extension). Title/artist come from the ID3 tags and exact duplicates are detected. To allow
  more formats later, add them to `ALLOWED_TYPES` in `server/config.js`.
- **Community mentors**: uploads stay hidden from everyone until a mentor approves them (Upload →
  *Waiting for approval*). The admin is always a mentor and can make others mentors with *Make mentor*
  under *People who can use the app*. Mentors can also delete any song and add or fix its lyrics (✎ on the song).
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

Live at **https://musicbox.narendrashete.com** on the `prime-dev` Ubuntu 24.04 VPS (moved from the old
Windows server on 2026-11-12). Everything lives in `/srv/musicbox` and runs as the `musicbox` user:

- `app/` (code + `.env`), `data/musicbox.db`, `library/` (the songs), `logs/`, `rclone.conf` (OneDrive login).
- Service `musicbox` = Node on `127.0.0.1:4300`, behind Caddy, which also gets and renews the HTTPS cert
  (site block between the `# >>> musicbox` markers in `/etc/caddy/Caddyfile`).
  Logs: `journalctl -u musicbox`. Restart: `sudo systemctl restart musicbox`.
- To add songs: use the Upload tab, or copy MP3s into `/srv/musicbox/library` (owned by `musicbox`) and press
  *Rescan* on the Upload tab.

**OneDrive backup**: timer `musicbox-backup` ([backup.sh](deploy/linux/backup.sh)) copies new songs to the
OneDrive folder `Narendras musicbox` every 15 minutes (copy only, it never deletes, so renamed or deleted
songs keep their old copy there). The admin **Health check** page (`/health.html`) shows the last backup
result, free disk space and any missing song files. If the OneDrive login expires, run
`rclone authorize "onedrive"` on a PC with a browser, then on the server
`sudo -u musicbox rclone --config /srv/musicbox/rclone.conf config reconnect musicbox:`, answer **n** to
the browser question and paste the token.

**CI/CD**: every push runs [CI](.github/workflows/ci.yml) (install, syntax check, a smoke test that boots
the server, and a syntax check of the deploy scripts). On the server, timer `musicbox-update`
([update.sh](deploy/linux/update.sh)) checks GitHub every 5 minutes. When `main` has a new commit whose
checks passed, it downloads it, installs packages, swaps it in, and rolls back automatically if the new
version doesn't start. It's pull-based: the server only makes outbound calls to GitHub, with no GitHub
runner on the box (the repo is public, so a runner there would let fork PRs run code on it). The log is
`/srv/musicbox/logs/update.log` and `/srv/musicbox/deployed.txt` holds the live commit. So to ship a
change, just push to `main`.

**New install**: `sudo bash deploy/linux/setup.sh "<hostname>"` from a clone. It installs Node 24, rclone and
the systemd units, adds the Caddy site and deploys the newest green commit. It's safe to re-run and never
touches the data, the songs or an existing `.env`. Then copy in `data/musicbox.db`, the songs and
`rclone.conf`, and set `JWT_SECRET` in `app/.env` (keeping the old one keeps everyone signed in).

---
Developed by [Prime Computers](https://www.primecomputers.co.in)
