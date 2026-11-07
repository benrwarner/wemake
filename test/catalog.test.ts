import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CATALOG_BASE, isCatalogUrl, matchesCategory, parseCatalog, search } from '../client/src/audio/plugins/catalog.ts';

const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/wam-plugins.json', import.meta.url), 'utf8'));
const everything = new Set<string>(raw.map((p: { identifier: string }) => p.identifier));

test('parseCatalog keeps only allowlisted Effect/Instrument entries and resolves urls', () => {
  const items = parseCatalog(raw, everything);
  assert.ok(items.length > 30);
  for (const i of items) {
    assert.ok(i.type.startsWith(`wam:${CATALOG_BASE}`), i.type);
    assert.ok(i.kind === 'fx' || i.kind === 'instrument');
    if (i.thumbnail) assert.ok(i.thumbnail.startsWith(CATALOG_BASE));
  }
  const ids = new Set(items.map((i) => i.id));
  assert.ok(!ids.has('com.sequencerParty.butterChurn'), 'video excluded');
  assert.ok(!ids.has('com.sequencerParty.midiOut'), 'MIDI excluded');
  assert.ok(!ids.has('com.sequencerParty.envmod'), 'modulators excluded');
  const muff = items.find((i) => i.id === 'com.wimmics.bigmuff')!;
  assert.equal(muff.type, `wam:${CATALOG_BASE}wimmics/BigMuff/index.js`);
  assert.equal(muff.category, 'Distortion');
  assert.equal(items.find((i) => i.id === 'com.sequencerParty.synth101')?.kind, 'instrument');
  assert.equal(items.find((i) => i.id === 'com.wimmics.distomachine')?.category, 'Amp');
  assert.equal(items.find((i) => i.id === 'com.wimmics.sweetwah')?.category, 'EQ & Filter');

  const few = parseCatalog(raw, new Set(['com.wimmics.bigmuff', 'com.wimmics.livegain' /* not allowlisted category check */]));
  assert.deepEqual(few.map((i) => i.id), ['com.wimmics.bigmuff', 'com.wimmics.livegain']);
  assert.deepEqual(parseCatalog({ not: 'a list' }, everything), []);
  assert.deepEqual(parseCatalog([{ identifier: 'x', path: '../../evil.js', category: ['Effect'] }], new Set(['x'])), []);
});

test('isCatalogUrl accepts catalog plugin urls and rejects tricks', () => {
  assert.equal(isCatalogUrl(`${CATALOG_BASE}wimmics/BigMuff/index.js`), true);
  for (const bad of [
    `${CATALOG_BASE}../x.js`,
    `${CATALOG_BASE}%2e%2e/x.js`,
    `${CATALOG_BASE}a/%2E%2E/%2E%2E/x.js`,
    `${CATALOG_BASE}a/..%2fx.js`,
    'https://evil.com/community/plugins/a.js',
    'https://www.webaudiomodules.com.evil.com/community/plugins/a.js',
    'https://user@www.webaudiomodules.com/community/plugins/a.js',
    'http://www.webaudiomodules.com/community/plugins/a.js',
    'https://www.webaudiomodules.com:444/community/plugins/a.js',
    `${CATALOG_BASE}a.js?x=1`,
    `${CATALOG_BASE}a.js#x`,
    'https://www.webaudiomodules.com/community/pluginsX/a.js',
    'https://www.webaudiomodules.com/community/a.js',
    'not a url',
  ]) {
    assert.equal(isCatalogUrl(bad), false, bad);
  }
});

test('search matches all words across fields', () => {
  const items = parseCatalog(raw, everything);
  assert.deepEqual(search(items, 'muff', null).map((i) => i.name), ['Big Muff']);
  const fuzz = search(items, 'fuzz wimmics', null).map((i) => i.name);
  assert.ok(fuzz.includes('KppFuzz') && fuzz.includes('QuadraFuzz'), fuzz.join());
  assert.ok(!fuzz.includes('Simple Distortion'));
  assert.equal(search(items, '', null).length, items.length);
  assert.ok(search(items, '', 'Reverb').every((i) => i.category === 'Reverb'));
  assert.ok(search(items, '', 'Instruments').every((i) => i.kind === 'instrument'));
  assert.equal(search(items, 'MUFF', 'Delay').length, 0);
});

test('matchesCategory understands combined built-in categories', () => {
  const item = (category: string, kind: 'fx' | 'instrument' = 'fx') => ({ category, kind }) as any;
  assert.equal(matchesCategory(item('Reverb & Delay'), 'Delay'), true);
  assert.equal(matchesCategory(item('Reverb & Delay'), 'Reverb'), true);
  assert.equal(matchesCategory(item('EQ & Filter'), 'EQ & Filter'), true);
  assert.equal(matchesCategory(item('Synth', 'instrument'), 'Instruments'), true);
  assert.equal(matchesCategory(item('Dynamics'), 'Amp'), false);
  assert.equal(matchesCategory(item('Dynamics'), null), true);
  assert.equal(matchesCategory(item('Dynamics'), 'All'), true);
});
