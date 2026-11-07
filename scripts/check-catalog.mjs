// Tests every WAM Community catalog Effect/Instrument inside WeMake (headless Chrome) and
// optionally rewrites client/src/audio/plugins/catalog-allow.ts with the ones that work.
// Also has a UI smoke test (sign up, browse, save a sound, resize panes).
//
// playwright-core is NOT a project dependency. Install it anywhere and point at it:
//   npm i --prefix /tmp/pw playwright-core
//   SIGNUP_CODE=devcode DATA_DIR=/tmp/wemake-dev npm run dev            # in another terminal
//   PLAYWRIGHT=/tmp/pw/node_modules/playwright-core/index.mjs node scripts/check-catalog.mjs [--write] [--smoke]
// Env: BASE (default http://localhost:5173), CHROME (default macOS Chrome path), SIGNUP_CODE (default devcode).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE ?? 'http://localhost:5173';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PW = process.env.PLAYWRIGHT ?? 'playwright-core';
const { chromium } = await import(PW.startsWith('/') ? pathToFileURL(PW).href : PW);
const args = new Set(process.argv.slice(2));
const EXCLUDE_CATEGORIES = new Set(['Visualization', 'Pedalboard']);
const EXCLUDE_IDS = new Set(['com.sequencerParty.audioInput']);

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

async function openStudio(page, room, name = 'Checker') {
  await page.goto(`${BASE}/?room=${room}`);
  const nameField = page.locator('input[placeholder="e.g. Sam"]');
  await nameField.fill(name);
  await page.locator('form.lobby-card button.primary').click();
  await page.waitForFunction(() => window.wemake?.snap?.order?.length, null, { timeout: 20000 });
}

async function curate() {
  const page = await context.newPage();
  page.on('pageerror', () => {}); // plugins throw all sorts of things; results come from the strip state
  await openStudio(page, `catalog-check-${Date.now().toString(36)}`);
  const results = await page.evaluate(async () => {
    const cat = await import('/src/audio/plugins/catalog.ts');
    const reg = await import('/src/audio/plugins/registry.ts');
    reg.trustCatalog();
    const json = await (await fetch(cat.CATALOG_URL)).json();
    const items = cat.parseCatalog(json, new Set(json.map((p) => p.identifier)));
    const s = window.wemake, e = s.engine;
    await e.ctx.resume();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const keys = Object.values(s.snap.tracks).find((t) => t.kind === 'instrument' && t.name === 'Keys') ?? Object.values(s.snap.tracks).find((t) => t.kind === 'instrument');
    const strip = () => e.strip(keys.id);
    const rms = (an) => { const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); return Math.sqrt(d.reduce((x, v) => x + v * v, 0) / d.length); };
    const measure = async (inst) => {
      let peak = 0;
      for (let i = 0; i < 3; i++) {
        inst.noteOn?.(48 + i * 7, 0.9, e.ctx.currentTime);
        for (let k = 0; k < 10; k++) { peak = Math.max(peak, rms(strip().meter)); await sleep(40); }
        inst.noteOff?.(48 + i * 7, e.ctx.currentTime);
      }
      for (let k = 0; k < 10; k++) { peak = Math.max(peak, rms(strip().meter)); await sleep(40); }
      return peak;
    };
    const out = [];
    for (const item of items) {
      const r = { id: item.id, name: item.name, kind: item.kind, category: item.category, loaded: false, passesAudio: false, error: '' };
      try {
        if (item.kind === 'instrument') {
          window.__setInstrument(keys.id, item.type);
          for (let i = 0; i < 60 && !strip().instrument?.inst && !strip().instrument?.error; i++) await sleep(200);
          const st = strip().instrument;
          if (st?.error) r.error = st.error;
          else if (st?.inst) { r.loaded = true; r.peak = await measure(st.inst); r.passesAudio = r.peak > 0.001; }
          else r.error = 'timeout';
          window.__setInstrument(keys.id, 'epiano');
          for (let i = 0; i < 30 && !strip().instrument?.inst; i++) await sleep(100);
        } else {
          const fxId = window.__addFx(keys.id, item.type);
          for (let i = 0; i < 60 && !e.pluginInstance(keys.id, fxId) && !e.pluginError(keys.id, fxId); i++) await sleep(200);
          const err = e.pluginError(keys.id, fxId);
          if (err) r.error = err;
          else if (e.pluginInstance(keys.id, fxId)) {
            r.loaded = true;
            await sleep(300);
            r.peak = await measure(strip().instrument.inst);
            r.passesAudio = r.peak > 0.001;
          } else r.error = 'timeout';
          window.__removeFx(keys.id, fxId);
          await sleep(200);
        }
      } catch (x) { r.error = String(x?.message ?? x); }
      out.push(r);
    }
    return out;
  });
  await page.close();
  return results;
}

async function smoke() {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const user = `smoke${Date.now().toString(36).slice(-6)}`;
  await page.goto(`${BASE}/`);
  await page.getByRole('button', { name: 'Create account' }).first().click();
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password', { exact: true }).fill('smoke-password-1');
  await page.getByLabel('Invite code').fill(process.env.SIGNUP_CODE ?? 'devcode');
  await page.locator('form.account-form button.primary').click();
  await page.getByText(user).first().waitFor({ timeout: 5000 });
  const nameValue = await page.locator('input[placeholder="e.g. Sam"]').inputValue();
  const room = `smoke-${Date.now().toString(36)}`;
  await page.locator('input[placeholder="session-name"]').fill(room);
  await page.locator('form.lobby-card button.primary').click();
  await page.waitForFunction(() => window.wemake?.snap?.order?.length, null, { timeout: 20000 });
  // select the Keys track and open the Instrument & FX tab
  await page.evaluate(() => { const s = window.wemake; const k = Object.values(s.snap.tracks).find((t) => t.name === 'Keys'); s.selectTrack(k.id); s.setBottom('track'); });
  const fxBefore = await page.evaluate(() => { const s = window.wemake; return Object.values(s.snap.tracks).find((t) => t.name === 'Keys').fx.length; });
  await page.getByRole('button', { name: /Browse sounds/ }).first().click();
  await page.getByRole('dialog', { name: 'Browse sounds' }).waitFor();
  await page.locator('.sound-card').first().waitFor({ timeout: 15000 }).catch(() => {});
  const communityInstruments = await page.locator('.sound-card').count();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  const communityAll = await page.locator('.sound-card').count();
  await page.getByLabel('Search sounds').fill('delay');
  const communityCards = await page.locator('.sound-card').count();
  if (communityCards) {
    await page.locator('.sound-card').first().getByRole('button', { name: 'Add to track' }).click();
    await page.getByRole('button', { name: 'Allow' }).click();
  }
  await page.getByRole('tab', { name: 'Built-in' }).click();
  await page.getByLabel('Search sounds').fill('');
  await page.getByRole('button', { name: 'Reverb', exact: true }).click();
  await page.locator('.sound-card').first().getByRole('button', { name: 'Add to track' }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  const fxCount = await page.evaluate(() => { const s = window.wemake; const k = Object.values(s.snap.tracks).find((t) => t.name === 'Keys'); return k.fx.length; });
  await page.locator('.fx-card').last().getByRole('button', { name: /Save sound/ }).click();
  await page.getByLabel('Name this sound').fill('Smoke verb');
  await page.locator('.save-sound-form button[type=submit]').click();
  await page.getByRole('button', { name: '✓ Saved' }).waitFor({ timeout: 5000 });
  // resize the bottom panel and the people panel
  const sep = page.getByRole('separator', { name: 'Resize timeline and bottom panel' });
  const before = Number(await sep.getAttribute('aria-valuenow'));
  const box = await sep.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 80, { steps: 5 });
  await page.mouse.up();
  const after = Number(await sep.getAttribute('aria-valuenow'));
  const side = page.getByRole('separator', { name: 'Resize people panel' });
  await side.focus();
  await page.keyboard.press('ArrowLeft');
  const sideAfter = Number(await side.getAttribute('aria-valuenow'));
  const kb = page.getByRole('separator', { name: 'Resize keyboard' });
  await kb.focus();
  await page.keyboard.press('ArrowUp');
  const kbAfter = Number(await kb.getAttribute('aria-valuenow'));
  const kbPx = await page.locator('.kb').evaluate((el) => el.getBoundingClientRect().height);
  await page.reload();
  // the lobby again; the account and My songs survive the reload
  await page.getByText(user).first().waitFor({ timeout: 5000 });
  const song = page.locator(`.my-songs .song-open[title="Open ${room}"]`);
  await song.waitFor({ timeout: 5000 });
  const songText = await song.textContent();
  await song.click();
  await page.waitForFunction(() => window.wemake?.snap?.order?.length, null, { timeout: 20000 });
  const persisted = Number(await page.getByRole('separator', { name: 'Resize timeline and bottom panel' }).getAttribute('aria-valuenow'));
  await page.evaluate(() => { const s = window.wemake; const k = Object.values(s.snap.tracks).find((t) => t.name === 'Keys'); s.selectTrack(k.id); s.setBottom('track'); });
  await page.getByRole('button', { name: /Browse sounds/ }).last().click();
  await page.getByRole('tab', { name: 'My sounds' }).click();
  const mySounds = await page.locator('.sound-card .sound-name').allTextContents();
  await page.screenshot({ path: process.env.SHOT ?? '/tmp/wemake-smoke.png' });
  await page.close();
  return { user, nameValue, songText, communityInstruments, communityAll, communityCards, fxBefore, fxCount, resize: { before, after, persisted, sideAfter, kbAfter, kbPx }, mySounds, errors };
}

// Expose small edit helpers to the page so curate() doesn't depend on Yjs internals.
await context.addInitScript(() => {
  const ready = () => window.wemake;
  window.__setInstrument = (trackId, type) => ready().edit((d) => window.__M.setInstrument(d, trackId, type));
  window.__addFx = (trackId, type) => { let id = ''; ready().edit((d) => { id = window.__M.addFx(d, trackId, type); }); return id; };
  window.__removeFx = (trackId, fxId) => ready().edit((d) => window.__M.removeFx(d, trackId, fxId));
});
await context.addInitScript(`window.__ROOT__ = ${JSON.stringify(ROOT)};`);
context.on('page', (p) => p.on('load', () => p.evaluate(async (root) => { window.__M = await import('/@fs' + root + '/shared/model.ts'); }, ROOT).catch(() => {})));

if (!args.has('--smoke') || args.has('--write')) {
  const results = await curate();
  console.table(results.map(({ id, kind, category, loaded, passesAudio, peak, error }) => ({ id, kind, category, loaded, passesAudio, peak: peak?.toFixed(4), error: error.slice(0, 60) })));
  const ok = results.filter((r) => r.loaded && r.passesAudio && !EXCLUDE_CATEGORIES.has(r.category) && !EXCLUDE_IDS.has(r.id)).map((r) => r.id);
  console.log(`${ok.length}/${results.length} pass`);
  if (args.has('--write')) {
    const file = path.join(ROOT, 'client/src/audio/plugins/catalog-allow.ts');
    fs.writeFileSync(file, `// WAM Community catalog entries that load and pass audio in WeMake.
// Regenerate with scripts/check-catalog.mjs (see its header for how to run it). Checked ${new Date().toISOString().slice(0, 10)}.
export const CATALOG_ALLOW = new Set<string>([
${ok.map((id) => `  '${id}',`).join('\n')}
]);
`);
    console.log(`wrote ${file}`);
  }
}
if (args.has('--smoke')) console.log(JSON.stringify(await smoke(), null, 1));
await browser.close();
