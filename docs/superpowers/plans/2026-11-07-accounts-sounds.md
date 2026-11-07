# Accounts, Saved Sounds, Plugin Browser, Resizable Panes, Storage Savings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional username/password accounts with "My songs" and saved sounds, a searchable plugin browser over the WAM Community catalog, draggable pane sizes, and smaller on-disk recordings.

**Architecture:** Server gains a SQLite store (`node:sqlite`, file in `DATA_DIR`) behind small focused modules (`db`, `accounts`, `api`), wired into the existing `http.createServer` router and WebSocket `hello`. Takes are re-encoded to FLAC by a background queue and unreferenced takes are collected when a room empties. The client adds an account module, lobby/top-bar UI, a Browse Sounds panel, and a generic split-pane handle.

**Tech Stack:** Node 22 (`node:sqlite`, `node:crypto`, `node:child_process`), `ws`, Yjs, React 19, Vite, `flac` CLI (Debian package) in the Docker image, node:test.

**Spec:** `docs/superpowers/specs/2026-11-07-accounts-sounds-design.md`

## Global Constraints

- No new npm dependencies. SQLite via `node:sqlite` (`DatabaseSync`); run node with `--no-warnings` is NOT required — just tolerate the ExperimentalWarning.
- All persistent state lives under `DATA_DIR` (`wemake.db`, `backups/`, `rooms/`, `audio/`).
- Username `^[a-z0-9_-]{3,32}$` (input lower-cased); password length 8–128.
- scrypt: `N=32768, r=8, p=1, keylen=64`, `maxmem: 64 * 1024 * 1024`, 16-byte random salt.
- Session cookie `wm_session`: 32 random bytes base64url; DB stores `sha256` hex; `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`; `Secure` unless request host is `localhost`/`127.0.0.1`. Sliding refresh at most once per 24 h.
- Sign-up requires `SIGNUP_CODE` env; unset ⇒ sign-up returns 403 `{"error":"Sign-up is closed"}`.
- Login error copy is exactly `Wrong username or password`.
- Auth rate limit: 10 failures per 15 min per IP and per username ⇒ 429 `{"error":"Too many attempts. Try again in 15 minutes."}`.
- Mutating `/api/auth/*` and `/api/me/*` require `content-type: application/json` (except DELETE) and an `Origin` whose host equals the `Host` header or is in `ALLOWED_ORIGINS`; else 403.
- All `/api/auth/*` and `/api/me*` responses: `cache-control: no-store`.
- Sounds: ≤ 500 per user, name 1–64 chars, `params_json` ≤ 16384 bytes, `kind ∈ {fx, instrument}`.
- `MIN_FREE_GB` default 5; upload refused with 507 `{"error":"The server is almost out of space"}`.
- GC grace: takes younger than 1 h are never deleted.
- Catalog: `https://www.webaudiomodules.com/community/plugins.json`, plugin base `https://www.webaudiomodules.com/community/plugins/`, client cache 24 h in `localStorage` key `wemake.catalog`.
- Layout persisted in `localStorage` key `wemake.layout`; mins: timeline 120 px, bottom 120 px, people 200–480 px, keyboard 60–260 px. No handles below 820 px width.
- Every `localStorage` access wrapped in try/catch (existing pattern in `Lobby.tsx`).

## Review Focus

- **Concurrent writes to SQLite while a room saves** — WAL + `busy_timeout=5000`; Task 1 test opens two `Db` instances on one file and writes from both.
- **Expired or deleted user's cookie on WS join** — joins as guest, no crash, no `user_rooms` row; Task 3 test.
- **Plugin URL tricks against the trusted prefix** (`..`, `%2e%2e`, other host, query string) — Task 7 unit test of `isCatalogUrl`.
- **FLAC encoder missing or failing** (local dev, broken image) — WAV is kept and still served; Task 5 test with `FLAC_BIN=/nonexistent`.
- **GC racing a fresh upload whose clip isn't in the doc yet** — 1 h grace; Task 5 test with a just-written unreferenced file.

---

### Task 1: SQLite store and account core

**Files:**
- Create: `server/db.ts`, `server/accounts.ts`
- Test: `test/accounts.test.ts`

**Interfaces:**
- Produces (`server/db.ts`): `class Db { constructor(file: string); readonly sql: DatabaseSync; backup(dir: string, keep?: number): string; close(): void }` — opens WAL, `foreign_keys=ON`, `busy_timeout=5000`, migrates via `PRAGMA user_version` (v1 = the four tables from spec §1, `ON DELETE CASCADE` on all user FKs).
- Produces (`server/accounts.ts`):
  - `validateUsername(u: unknown): string | null` (error message or null), `validatePassword(p: unknown): string | null`
  - `class Accounts { constructor(db: Db) ; signup(username: string, password: string): {id:number,username:string} | {error:string}; login(username: string, password: string): {id:number,username:string} | null; createSession(userId: number): string /* raw token */; userForToken(token: string | undefined): {id:number,username:string} | null /* also slides expiry */; logout(token: string): void; resetPassword(username: string): string | null /* new random password */; deleteUser(username: string): boolean; listUsers(): {username:string, created_at:number}[]; sweep(): void }`
  - `class Limiter { constructor(max: number, windowMs: number); blocked(key: string): boolean; fail(key: string): void; clear(key: string): void }`

- [ ] **Step 1: Write failing tests** in `test/accounts.test.ts` (temp dir per test):
  - `signup then login works; wrong password and unknown user both return null`
  - `usernames are case-insensitive unique` — `signup('Ana', …)` then `signup('ana', …)` ⇒ `{error: 'That username is taken'}`
  - `validateUsername rejects 'ab', 'a b', 'x'.repeat(33); validatePassword rejects 'short'`
  - `session token is not stored raw` — `createSession` token not found in `SELECT token_hash FROM sessions`; `userForToken(token)` returns the user; after `logout` returns null
  - `expired session returns null` — set `expires_at` to past via SQL ⇒ null
  - `deleteUser cascades sessions, user_rooms and sounds`
  - `resetPassword returns a new password that logs in; old one fails`
  - `two Db handles on one file can both write` (Review Focus)
  - `backup writes wemake-YYYYMMDD.db and keeps only 7` — create 9 dated files first
  - `Limiter blocks after max fails and clears`
- [ ] **Step 2: Run** `node --import tsx --test test/accounts.test.ts` — Expected: FAIL (modules missing)
- [ ] **Step 3: Implement** `server/db.ts` and `server/accounts.ts`. `login` runs scrypt against a fixed dummy salt/hash when the user is missing (timing). `backup` uses `VACUUM INTO`.
- [ ] **Step 4: Run** the same command — Expected: all PASS; then `npm run typecheck`
- [ ] **Step 5: Commit** `feat(server): sqlite store and account core`

### Task 2: Account HTTP API with cookie, origin check, rate limits

**Files:**
- Create: `server/api.ts`
- Modify: `server/index.ts` (construct `Db`/`Accounts` from `DATA_DIR/wemake.db`, hourly `sweep`, daily `backup(DATA_DIR/backups)`, route `/api/auth/*` and `/api/me*` to `handleApi` before the existing `/api` branch)
- Test: `test/server.test.ts` (extend; harness passes `SIGNUP_CODE: 'letmein'`)

**Interfaces:**
- Consumes: Task 1 `Accounts`, `Limiter`; `clientIp(req)` from `server/index.ts` (pass in).
- Produces (`server/api.ts`):
  - `parseCookies(header: string | undefined): Record<string,string>`
  - `sessionCookie(token: string | null, req: http.IncomingMessage): string` (null ⇒ expiring cookie)
  - `originAllowed(req: http.IncomingMessage, allowed: string[]): boolean`
  - `readJson(req, maxBytes = 32768): Promise<unknown>`
  - `currentUser(req): {id,username} | null` (via `deps.accounts.userForToken(cookie)`)
  - `handleApi(req, res, url: URL, deps: ApiDeps): Promise<boolean>` — returns false if path not handled. `ApiDeps = { accounts: Accounts; sounds: Sounds; songs: Songs; ip: (req) => string; allowedOrigins: string[]; signupCode?: string }` (Sounds/Songs added in Tasks 3–4; until then pass stubs).
  - Endpoints: `POST /api/auth/signup {username,password,code}` ⇒ 201 `{user}` + cookie; `POST /api/auth/login` ⇒ 200 `{user}` + cookie; `POST /api/auth/logout` ⇒ 204 + expiring cookie; `GET /api/me` ⇒ `{user: {...}|null}`.
- [ ] **Step 1: Write failing tests** (fetch with explicit `Origin: BASE` header):
  - `signup needs the invite code` — no/wrong code ⇒ 403; right code ⇒ 201, `set-cookie` contains `wm_session=`, `HttpOnly`, `SameSite=Lax`, and no `Secure` (localhost)
  - `login, me, logout round trip`
  - `wrong login copy` — body `{error:'Wrong username or password'}`, status 401
  - `cross-origin POST is rejected` — `Origin: https://evil.example` ⇒ 403
  - `non-JSON POST is rejected` — `content-type: text/plain` ⇒ 415
  - `login is rate limited per username` — 10 wrong ⇒ 11th (even correct) ⇒ 429
  - `/api/me responses are no-store`
  - unit (in `test/accounts.test.ts`): `parseCookies('a=1; wm_session=x%3D')` ⇒ `{a:'1', wm_session:'x='}`; `sessionCookie` includes `Secure` when Host is `wemake.ben-warner.dev`
- [ ] **Step 2: Run** `npm test` — Expected: new tests FAIL
- [ ] **Step 3: Implement** `server/api.ts` and wire it in `server/index.ts`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS
- [ ] **Step 5: Commit** `feat(server): account API with secure cookies, origin check and rate limits`

### Task 3: My songs

**Files:**
- Create: `server/songs.ts`
- Modify: `server/index.ts` (in `hello`: `const user = currentUser(req)`; after `joined = true` call `songs.touch(user.id, room.id, wasFresh ? 'owner' : 'member')`; default `peer.name` to `user.username` when `msg.name` is empty; in `saveRoom` call `songs.setTitle(room.id, project name from doc)`)
- Modify: `server/api.ts` (`GET /api/me/songs`, `DELETE /api/me/songs/:room`; 401 when signed out)
- Test: `test/server.test.ts`

**Interfaces:**
- Produces: `class Songs { constructor(db: Db); touch(userId: number, room: string, role: 'owner'|'member'): void /* owner never downgraded */; setTitle(room: string, title: string): void; list(userId: number): {room:string, role:string, title:string|null, last_opened_at:number}[]; remove(userId: number, room: string): void }`
- [ ] **Step 1: Write failing tests:**
  - `joining while signed in adds the song` — sign up, open WS with `headers: {cookie}`, hello, set project name 'My Tune', close ⇒ `GET /api/me/songs` lists `{room, role:'owner', title:'My Tune'}`; a second user joining the same room gets `role:'member'`
  - `removing a song only removes it from my list` — room file still exists
  - `stale cookie joins as guest` — delete user via SQL, then WS hello with old cookie ⇒ `welcome`, no row (Review Focus)
  - `songs API requires sign-in` ⇒ 401
- [ ] **Step 2: Run** `npm test` — FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS
- [ ] **Step 5: Commit** `feat: my songs list for signed-in users`

### Task 4: Saved sounds API

**Files:**
- Create: `server/sounds.ts`
- Modify: `server/api.ts` (`GET/POST /api/me/sounds`, `PATCH/DELETE /api/me/sounds/:id`)
- Test: `test/server.test.ts`

**Interfaces:**
- Produces: `interface SavedSound { id: string; name: string; kind: 'fx'|'instrument'; plugin_type: string; params: Record<string, number>; created_at: number }`; `class Sounds { constructor(db: Db); list(userId): SavedSound[]; add(userId, s: {name, kind, plugin_type, params}): SavedSound | {error:string}; rename(userId, id, name): boolean; remove(userId, id): boolean }`. Validation: name trimmed 1–64; `plugin_type` string ≤ 2048; params values finite numbers; JSON ≤ 16384 bytes; cap 500 ⇒ `{error:'You can save up to 500 sounds'}`.
- [ ] **Step 1: Write failing tests:** `sounds CRUD round trip`; `one user cannot see or delete another user's sound` (DELETE returns 404); `bad payloads rejected` (non-number param, 65-char name, 17 KB params ⇒ 400)
- [ ] **Step 2: Run** `npm test` — FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS
- [ ] **Step 5: Commit** `feat: saved sounds API`

### Task 5: Storage — FLAC, GC, free-space guard, admin CLI, image

**Files:**
- Create: `server/storage.ts`, `server/admin.ts`
- Modify: `server/index.ts` (audio GET/HEAD resolves `.flac` then `.wav`; PUT checks free space first; after rename, `storage.enqueueFlac(file)`; on last connection close after `saveRoom`, `storage.collect(room.id, referencedAudioIds(room.doc))`; PUT 409 check covers both extensions)
- Modify: `Dockerfile` (`RUN apt-get update && apt-get install -y --no-install-recommends flac && rm -rf /var/lib/apt/lists/*` before `npm ci`)
- Test: `test/storage.test.ts`

**Interfaces:**
- Produces (`server/storage.ts`):
  - `freeBytes(dir: string): number` (`fs.statfsSync`: `bavail * bsize`)
  - `class Storage { constructor(opts: { audioDir: string; flacBin?: string /* env FLAC_BIN ?? 'flac' */; minFreeBytes: number }); hasRoom(): boolean; enqueueFlac(wavPath: string): Promise<void> /* serial queue; nice -n 10; on success verify with flac -t then unlink wav; on any failure keep wav */; resolveTake(room: string, id: string): { file: string; type: 'audio/flac'|'audio/wav' } | null; collect(room: string, referenced: Set<string>, now?: number): string[] /* deleted ids; skips files with mtime < now - 3600_000 and *.part */ }`
  - `referencedAudioIds(doc: Y.Doc): Set<string>` (from `M.snapshot(doc).clips[*].audioId`)
- Produces (`server/admin.ts`): CLI `npx tsx server/admin.ts <list-users|reset-password <u>|delete-user <u>|compress-takes>` using `DATA_DIR`.
- [ ] **Step 1: Write failing tests** (`test/storage.test.ts`):
  - `resolveTake prefers flac over wav`
  - `collect deletes only old unreferenced takes` — files: referenced old, unreferenced old (mtime −2 h via `fs.utimesSync`), unreferenced new ⇒ only the 2nd deleted (Review Focus)
  - `enqueueFlac keeps the wav when the encoder is missing` — `flacBin: '/nonexistent'` (Review Focus)
  - `enqueueFlac replaces wav with flac` — `{ skip: !hasFlac }`; write a 1 s 16-bit sine WAV, encode, assert `.flac` exists, `.wav` gone
  - server test: `upload refused when disk is nearly full` — spawn with `MIN_FREE_GB: '1000000'` in a second harness or set env per test ⇒ PUT 507
- [ ] **Step 2: Run** `node --import tsx --test test/storage.test.ts` — FAIL
- [ ] **Step 3: Implement**; GET sends `content-type` from `resolveTake`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS; `docker build` not required locally (CI builds).
- [ ] **Step 5: Commit** `feat(server): flac takes, take GC, free-space guard, admin CLI`

### Task 6: Client accounts — lobby sign-in, My songs, top-bar chip

**Files:**
- Create: `client/src/net/account.ts`, `client/src/ui/Account.tsx`
- Modify: `client/src/ui/Lobby.tsx` (account corner + My songs list; name prefilled from user), `client/src/ui/TopBar.tsx` (chip with username / "Guest"), `client/src/styles.css`
- Test: manual + headless smoke in Task 8

**Interfaces:**
- Produces (`client/src/net/account.ts`): `type User = {id:number; username:string}`; `me(): Promise<User|null>`; `signup(u,p,code)`, `login(u,p)` ⇒ `Promise<User>` (throw `Error(serverMessage)`); `logout(): Promise<void>`; `songs(): Promise<Song[]>`; `removeSong(room)`; `sounds(): Promise<SavedSound[]>`; `saveSound(s)`; `renameSound(id,name)`; `deleteSound(id)`; plus a tiny store `useUser(): [User|null, (u: User|null) => void]` backed by a module-level emitter.
- Copy: buttons `Sign in`, `Create account`, `Sign out`; fields `Username`, `Password`, `Invite code`; empty My songs: `Songs you start or join while signed in show up here.`
- [ ] **Step 1:** Implement `account.ts` (fetch with `credentials: 'same-origin'`, JSON headers).
- [ ] **Step 2:** Implement `Account.tsx` (`AccountCorner`, `MySongs`) and wire Lobby/TopBar. My songs: title (fallback = room id), relative "last opened", Open (sets room field + joins), Remove.
- [ ] **Step 3: Run** `npm run typecheck && npm run build` — PASS
- [ ] **Step 4: Commit** `feat(client): sign in, my songs, account chip`

### Task 7: Browse sounds — catalog, trust prefix, saved sounds UI

**Files:**
- Create: `client/src/audio/plugins/catalog.ts`, `client/src/audio/plugins/catalog-allow.ts`, `client/src/ui/BrowseSounds.tsx`
- Modify: `client/src/audio/plugins/registry.ts` (`isTrusted` also true when `isCatalogUrl(externalUrl(type)) && catalogTrusted()`; `trustCatalog()`), `client/src/ui/Inspector.tsx` ("Browse sounds" button in FxRack + InstrumentPanel; "Save sound" on instrument panel and each FX), `client/src/styles.css`
- Test: `test/catalog.test.ts`

**Interfaces:**
- Produces (`catalog.ts`): `CATALOG_URL`, `CATALOG_BASE`; `interface CatalogItem { id: string /* identifier */; name; vendor; description; keywords: string[]; kind: 'fx'|'instrument'; category: string; thumbnail?: string /* absolute */; type: string /* 'wam:'+absolute url */ }`; `parseCatalog(json: unknown, allow: Set<string>): CatalogItem[]`; `loadCatalog(): Promise<CatalogItem[]>` (24 h cache); `isCatalogUrl(url: string): boolean`; `search(items: CatalogItem[], q: string, category: string | null): CatalogItem[]` (case-insensitive over name/vendor/description/keywords; all words must match).
- Produces (`catalog-allow.ts`): `export const CATALOG_ALLOW = new Set<string>([...identifiers])` — filled by Task 8.
- Category chips (exact): `All, Instruments, Distortion, Reverb, Delay, EQ & Filter, Modulation, Pitch, Amp`. Mapping: Instrument/* ⇒ Instruments; Effect/Amp Simulator ⇒ Amp; Effect/Equalizer & Filter ⇒ EQ & Filter; others by second category.
- Browse panel: modal sheet; source filter `Built-in | Community | My sounds` (My sounds hidden when signed out); cards with lazy `<img loading="lazy">`, name, vendor, description (2-line clamp), button `Add to track` (fx ⇒ `M.addFx(d, trackId, type, params)`; instrument ⇒ `M.setInstrument`, disabled unless selected track is an instrument track). First Community add shows `Allow plugins from webaudiomodules.com? They run in your browser and in your friends' browsers.` with `Allow` / `Cancel`.
- "Save sound" prompts `Name this sound` (inline input, default = plugin name), posts `{kind, plugin_type, params}`; for WAM params read current values from the live instance's `params` + spec params.
- [ ] **Step 1: Write failing tests** (`test/catalog.test.ts`, using the fixture `test/fixtures/wam-plugins.json` = the downloaded index):
  - `parseCatalog keeps only allowlisted Effect/Instrument entries and resolves urls` — `type` starts with `wam:https://www.webaudiomodules.com/community/plugins/`
  - `isCatalogUrl accepts catalog plugin urls and rejects tricks` — rejects `…/plugins/../x.js`, `…/plugins/%2e%2e/x.js`, `https://evil.com/community/plugins/a.js`, `http://www.webaudiomodules.com/community/plugins/a.js`, `…/a.js?x=1` (Review Focus)
  - `search matches all words across fields` — `'muff'` finds Big Muff; `'fuzz wimmics'` finds KppFuzz and QuadraFuzz
- [ ] **Step 2: Run** `node --import tsx --test test/catalog.test.ts` — FAIL
- [ ] **Step 3: Implement** catalog + registry trust + UI.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build` — PASS
- [ ] **Step 5: Commit** `feat(client): browse sounds catalog and saved sounds`

### Task 8: Curate the allowlist and smoke-test in a real browser

**Files:**
- Create: `scripts/check-catalog.mjs` (headless Chrome via a scratch `playwright-core`; not a project dependency — document in header comment)
- Modify: `client/src/audio/plugins/catalog-allow.ts`

- [ ] **Step 1:** Script: start dev server, open studio, for each Effect/Instrument catalog entry add it to a track with the fake-mic/instrument signal, wait ≤ 8 s, record `loaded` (no error on strip/slot) and `passesAudio` (track meter RMS > 0.001 for fx with mic input / instrument after `noteOn`). Print a table.
- [ ] **Step 2:** Put identifiers where `loaded && passesAudio` into `CATALOG_ALLOW` (exclude Visualization and Pedalboard categories, and `com.sequencerParty.audioInput`).
- [ ] **Step 3:** Same script, smoke: sign up, Browse → add one community effect and one built-in, Save sound, reload, My sounds lists it; resize handles (Task 9) persist after reload.
- [ ] **Step 4: Commit** `chore: curated WAM catalog allowlist`

### Task 9: Resizable panes

**Files:**
- Create: `client/src/ui/Splitter.tsx`
- Modify: `client/src/ui/StudioView.tsx`, `client/src/ui/Keyboard.tsx` (height from layout), `client/src/styles.css` (`.studio` side column and `.center` rows use CSS vars `--side-w`, `--bottom-h`, `--kb-h`)

**Interfaces:**
- Produces: `useLayout(): [Layout, (patch: Partial<Layout>) => void, () => void /* reset */]` with `Layout = { bottomH: number; sideW: number; kbH: number }`, defaults `{ bottomH: 0.38 * window.innerHeight (resolved at first load), sideW: 280, kbH: (current keyboard height) }`; `<Splitter dir="row"|"col" value={px} min max onChange onReset label />` — pointer capture drag, `role="separator"`, `aria-orientation`, `aria-valuenow/min/max`, `tabIndex=0`, ArrowUp/Down/Left/Right ±16 px, double-click ⇒ reset.
- [ ] **Step 1:** Implement and wire three splitters (between Arrange and bottom; between center and People; above keyboard). Clamp against current window size on resize so the timeline never drops below 120 px.
- [ ] **Step 2: Run** `npm run typecheck && npm run build` — PASS; headless check in Task 8 Step 3.
- [ ] **Step 3: Commit** `feat(client): draggable pane sizes`

### Task 10: Ship and deploy on the Pi

- [ ] **Step 1:** `npm test && npm run typecheck && npm run build`; push `main`; wait for CI; confirm the arm64 build log contains `flac`.
- [ ] **Step 2:** On the Pi, add to `~/wemake/docker-compose.yml` env: `SIGNUP_CODE` (generate `openssl rand -base64 9`), `MIN_FREE_GB: "5"`; `docker compose pull && docker compose up -d`.
- [ ] **Step 3:** Verify: `docker exec wemake flac --version`; `/api/me` on both URLs; sign up via public URL, join a song, check My songs; `docker exec wemake npx tsx server/admin.ts compress-takes`; `ls /mnt/wemake/data` shows `wemake.db`.
- [ ] **Step 4:** Reboot the Pi; confirm the account still logs in (cookie survives) and the db is intact.
- [ ] **Step 5:** Update memory note and README (new env vars, admin CLI).
