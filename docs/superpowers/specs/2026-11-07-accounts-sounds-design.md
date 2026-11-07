# WeMake: accounts, saved sounds, plugin browser, resizable panes, storage savings

Status: draft for approval · 2026-11-07

## Why

WeMake runs on Ben's Raspberry Pi for him and his friends (public at https://wemake.ben-warner.dev,
private at https://dietpi.taild9082b.ts.net). Today a song only lives behind a random session link:
lose the link and you lose the song. There is no way to find new sounds beyond the built-ins
without pasting a plugin URL. Recordings are big, and the box is shared with Ben's other projects.

Success: a friend signs in on any device and sees their songs and their saved sounds; they can
browse and search a catalog of extra instruments and effects and add one in a click; the
studio's panes can be resized; disk usage grows as slowly as reasonably possible.

## Goals

1. **Accounts:** username + password, light and safe. Optional: guests can still join by link.
2. **My songs:** every session a signed-in user creates or joins appears in their list.
3. **Saved sounds:** save an instrument/effect *with its current settings* ("tone") to your
   account, give it a name, and add it to any track in any song later.
4. **Plugin browser ("Browse sounds")**: searchable, filterable cards built from the public WAM
   Community catalog, plus the built-ins and the user's saved sounds.
5. **Resizable panes**: drag handles for timeline ↔ bottom panel, main ↔ People panel, and the
   on-screen piano keyboard.
6. **Use less space**: store recordings losslessly compressed and delete recordings no song uses.

## Non-goals

- Email, password-reset emails, OAuth/social login, 2FA.
- Per-user storage quotas (a server-wide safety limit is enough for a group of friends).
- Mirroring catalog plugins onto the Pi (they load from webaudiomodules.com; costs 0 bytes here).
- Sharing saved sounds between users, ratings, reviews, paid plugins.
- The "live monitoring doesn't play back" bug: tracked separately; not reproducible in Chrome
  with a fake mic, waiting on repro details from Ben.

## Anti-goals (failure even if it "works")

- Breaking existing links: anyone with a session link must still be able to join as a guest.
- Data loss on reboot, Watchtower update, or a missing drive (all state lives in `DATA_DIR`
  on the external drive; the container already refuses to start without it).
- Storing passwords or session tokens in a recoverable form.
- Letting strangers on the public internet create accounts and fill the drive.

## Constraints

- Pi: arm64, Docker, image `ghcr.io/benrwarner/wemake:latest` built by GitHub Actions, auto-
  updated by Watchtower every 5 min. `DATA_DIR=/data` is bind-mounted from `/mnt/wemake/data`
  (200 GB ext4 partition on a USB drive).
- Node 22 (`node:22-slim`). Built-in `node:sqlite` works locally (SQLite 3.51) and on the Pi
  (3.53). No native npm modules.
- Every browser renders the song locally; plugin code runs in every participant's browser
  (existing "Trust & load" model).
- Cloudflare Free caps request bodies at 100 MB; `MAX_UPLOAD_MB=95` is set on the Pi.

## Design

### 1. Data & persistence

- One SQLite file: `DATA_DIR/wemake.db`, WAL mode, `foreign_keys=ON`, schema created/migrated
  on startup with a `schema_version` pragma (`user_version`). Lives on the external drive, so it
  survives reboots and image updates; Watchtower recreates the container with the same mount.
- Tables:
  - `users(id INTEGER PK, username TEXT UNIQUE COLLATE NOCASE, pass_salt, pass_hash, created_at)`
  - `sessions(token_hash TEXT PK, user_id → users, created_at, expires_at, last_seen_at)`
  - `user_rooms(user_id → users, room TEXT, role TEXT CHECK(role IN ('owner','member')),
     title TEXT, last_opened_at, PRIMARY KEY(user_id, room))`
  - `sounds(id TEXT PK, user_id → users, name TEXT, kind TEXT CHECK(kind IN ('fx','instrument')),
     plugin_type TEXT, params_json TEXT, created_at)`
- Existing room files (`rooms/*.ybin`, `*.auth.json`) and takes (`audio/<room>/*`) stay as they are.
- Backup (my call): nightly `VACUUM INTO DATA_DIR/backups/wemake-YYYYMMDD.db`, keep 7.

### 2. Accounts & security ("basic service security")

- **Sign-up is invite-only** (my call; overridable): the server requires `SIGNUP_CODE` (env) on
  sign-up. If `SIGNUP_CODE` is unset, sign-up is closed. Ben gives the code to friends.
- Username: 3–32 chars `[a-z0-9_-]`, case-insensitive unique. Password: 8–128 chars.
- Passwords: scrypt (N=2^15, r=8, p=1, 64-byte key) with a 16-byte random salt;
  `crypto.timingSafeEqual` for comparison. Unknown usernames still run scrypt (no user
  enumeration by timing); login errors are always "Wrong username or password".
- Sessions: 32 random bytes → cookie `wm_session`; only `sha256(token)` is stored.
  Cookie: `HttpOnly; Secure` (omitted only on plain `http://localhost`); `SameSite=Lax; Path=/`;
  30-day expiry, sliding (refreshed at most once a day). Logout deletes the row.
  Expired rows swept hourly.
- CSRF: all state-changing account/sound endpoints are `POST`/`DELETE` with
  `content-type: application/json`, and the server rejects requests whose `Origin` doesn't
  match the `Host` (or isn't in `ALLOWED_ORIGINS` when set). `SameSite=Lax` covers the rest.
- Brute force: per-IP and per-username failure limits for login and sign-up (10 per 15 min),
  reusing the proxy-aware `clientIp()`.
- Recovery without email: admin CLI inside the container:
  `docker exec wemake npx tsx server/admin.ts reset-password <username>` (prints a new random
  password), `… delete-user <username>`, `… list-users`.
- API (JSON): `POST /api/auth/signup {username,password,code}`, `POST /api/auth/login`,
  `POST /api/auth/logout`, `GET /api/me` → `{user|null}`. Responses `cache-control: no-store`.

### 3. Songs ↔ accounts

- The WebSocket upgrade carries the cookie (same origin). On a successful `hello`, if the
  socket belongs to a signed-in user, upsert `user_rooms` (`owner` if the room was fresh,
  else `member`), set `last_opened_at`, and default the display name to the username.
- `title` is refreshed from the song's project name whenever the room is saved.
- `GET /api/me/songs` → list sorted by `last_opened_at`. `DELETE /api/me/songs/:room` removes it
  from *my list only* (the song itself is shared and is not deleted).
- Room passwords still apply to signed-in users (no bypass), keeping today's model intact.

### 4. Saved sounds

- "Save sound" button on the instrument panel and on each effect in the Inspector, and a
  "Save" action on presets: prompts for a name, stores `{kind, plugin_type, params}`.
  Limit: 500 sounds/user, name ≤ 64 chars, params JSON ≤ 16 KB.
- `GET /api/me/sounds`, `POST /api/me/sounds`, `DELETE /api/me/sounds/:id`,
  `PATCH /api/me/sounds/:id {name}`.
- Applying a saved sound: instrument → replaces the selected instrument track's instrument with
  that type + params; effect → appended to the selected track's FX chain with those params.
  It's a normal shared edit, so everyone in the session hears it.
- WAM plugins: params saved are those reported by the plugin (`getParameterInfo`) — so a saved
  WAM tone restores its parameter values. (WAM state outside parameters, e.g. a loaded sample,
  is not captured; noted in the UI as "settings only".)

### 5. Plugin browser ("Browse sounds")

- Opened from a "Browse sounds" button in the Inspector (and the instrument picker).
  A panel with: search box (name, maker, description, keywords), category chips
  (Instruments, Distortion, Reverb, Delay, EQ & Filter, Modulation, Pitch, Amp), and three
  sources as tabs/filters: **Built-in**, **Community**, **My sounds** (signed-in only).
- Cards: screenshot thumbnail (lazy-loaded), name, maker, one-line description, "Add to track".
- Community catalog: the client fetches
  `https://www.webaudiomodules.com/community/plugins.json` (CORS `*`, 35 KB) and resolves
  each `path` against `https://www.webaudiomodules.com/community/plugins/`. Cached in
  `localStorage` for 24 h; built-ins + My sounds still work if the fetch fails.
- **Curated allowlist:** only catalog entries in `client/src/audio/plugins/catalog-allow.ts`
  are shown. The builder tests every Effect/Instrument entry (44 candidates) in WeMake and
  allowlists those that load and pass audio; Video/MIDI/Modulation/Utility entries are excluded.
- **Trust:** first use shows one prompt for the source ("Allow plugins from
  webaudiomodules.com/community?"); trusting stores the URL prefix, so later catalog plugins
  load without a prompt. Other pasted URLs keep the per-URL prompt. The prefix check runs on
  the *normalized* URL (`new URL(...)`: https, exact host, path starts with the prefix, no
  query/hash), because plugin URLs come from shared session data that any participant can edit.
- Space: catalog plugins are fetched by each browser (HTTP cache, `max-age=14400`), never
  stored on the Pi; the song stores only the plugin URL.

### 6. Resizable panes

- Three drag handles: timeline/bottom-panel (horizontal), main/People (vertical), and the top
  edge of the on-screen piano keyboard. Pointer-events drag, 6 px hit area, highlighted on
  hover/drag, keyboard-accessible (focus + arrow keys), double-click resets to default.
- Minimums: timeline 120 px, bottom panel 120 px, People 200–480 px, keyboard 60–260 px.
- Sizes saved per browser in `localStorage` (`wemake.layout`), never shared with others.
- Below 820 px wide the existing mobile layout is unchanged (no handles).

### 7. Space savings

- **FLAC for takes:** add the `flac` CLI to the Docker image (`apt-get install -y flac`). After a
  WAV upload completes, the server encodes it to FLAC (`flac -8`) in the background, verifies it,
  then deletes the WAV. GET serves whichever exists (`audio/flac` or `audio/wav`); all target
  browsers decode FLAC via `decodeAudioData`. Expect ~40–60% savings, lossless.
  Encoding runs one at a time (queue) with `nice` so it can't starve the realtime server.
  Existing WAVs are converted by a one-off `server/admin.ts compress-takes` command.
- **Garbage collection:** when a room's last connection closes and the room is saved, any take
  in `audio/<room>/` not referenced by a clip in the song and older than 1 hour is deleted.
  (Undo history only exists while people are connected, so nothing undoable is lost.)
- **Safety limit:** uploads are refused with a clear message when free space on `DATA_DIR`
  is below `MIN_FREE_GB` (default 5).

### 8. Lobby & UI changes

- Lobby top-right: "Sign in" / "Create account" (inline forms, invite code field on create).
  Signed in: avatar initial + username menu (Sign out), name field prefilled, and a
  "My songs" list (title, last opened, Open, Remove-from-list) under the join form.
- Studio top bar: small account chip; "Browse sounds" entry points as above.

## Deployment changes (Pi)

- New env in `~/wemake/docker-compose.yml`: `SIGNUP_CODE` (random, given to Ben),
  `MIN_FREE_GB: "5"`. Nothing else changes: same bind mount, same Watchtower flow.
- After the image with FLAC support is live, run `compress-takes` once.

## Testing

- Unit: password hashing/verification, cookie parsing, origin check, username validation,
  rate limiter, GC selection logic.
- Integration (existing spawned-server harness): signup (code required/wrong/closed), login,
  logout, `/api/me`, songs list populated by WS join with cookie, sounds CRUD and limits,
  CSRF rejection, FLAC round-trip (skipped if `flac` isn't installed locally), GC.
- Browser smoke test (headless Chrome, fake mic) for the browser panel and resize handles.
- On the Pi: reboot test and a Watchtower update with an existing account still logged in.

## Calls I made (Ben can override)

1. Invite-code sign-up (`SIGNUP_CODE`), not open sign-up.
2. Accounts are optional; guests keep working by link.
3. Room passwords still required for signed-in users.
4. No per-user quota; server-wide `MIN_FREE_GB` guard instead.
5. FLAC (lossless) rather than a lossy format.
6. Catalog plugins load from webaudiomodules.com, not mirrored on the Pi.
7. Nightly DB backup, keep 7.
