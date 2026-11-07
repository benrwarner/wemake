// Recorded-take storage: lossless FLAC re-encoding, cleanup of takes no song uses,
// and a free-space guard so uploads can't fill the drive.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type * as Y from 'yjs';
import { snapshot } from '../shared/model.ts';

const GRACE_MS = 3600_000; // takes younger than this are never collected
const ENCODE_TIMEOUT_MS = 10 * 60_000;

export function freeBytes(dir: string): number {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export function referencedAudioIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  for (const c of Object.values(snapshot(doc).clips)) if (c.audioId) ids.add(c.audioId);
  return ids;
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore' });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), ENCODE_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

export class Storage {
  private readonly audioDir: string;
  private readonly flacBin: string;
  private readonly minFreeBytes: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: { audioDir: string; flacBin?: string; minFreeBytes: number }) {
    this.audioDir = opts.audioDir;
    this.flacBin = opts.flacBin ?? process.env.FLAC_BIN ?? 'flac';
    this.minFreeBytes = opts.minFreeBytes;
  }

  hasRoom(): boolean {
    try {
      return freeBytes(this.audioDir) >= this.minFreeBytes;
    } catch {
      return true; // can't tell; don't block recording over it
    }
  }

  /** Queue a WAV for FLAC encoding (one at a time, low priority). Keeps the WAV on any failure. */
  enqueueFlac(wavPath: string): Promise<void> {
    const job = this.queue.then(() => this.encode(wavPath));
    this.queue = job.catch(() => {});
    return job;
  }

  private async encode(wavPath: string): Promise<void> {
    const flacPath = wavPath.replace(/\.wav$/, '.flac');
    if (flacPath === wavPath || !fs.existsSync(wavPath) || fs.existsSync(flacPath)) return;
    const tmp = `${flacPath}.tmp`;
    const ok =
      (await run('nice', ['-n', '10', this.flacBin, '-8', '--silent', '-f', '-o', tmp, wavPath])) &&
      (await run('nice', ['-n', '10', this.flacBin, '-t', '--silent', tmp]));
    if (!ok) {
      fs.rmSync(tmp, { force: true });
      return;
    }
    fs.renameSync(tmp, flacPath);
    fs.rmSync(wavPath, { force: true });
  }

  resolveTake(room: string, id: string): { file: string; type: 'audio/flac' | 'audio/wav' } | null {
    const base = path.join(this.audioDir, room.toLowerCase(), id);
    if (fs.existsSync(`${base}.flac`)) return { file: `${base}.flac`, type: 'audio/flac' };
    if (fs.existsSync(`${base}.wav`)) return { file: `${base}.wav`, type: 'audio/wav' };
    return null;
  }

  /** Deletes takes in a room that no clip references and that are older than an hour. Returns deleted ids. */
  collect(room: string, referenced: Set<string>, now = Date.now()): string[] {
    const dir = path.join(this.audioDir, room.toLowerCase());
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const deleted: string[] = [];
    for (const name of names) {
      const m = /^([a-z0-9]+)\.(wav|flac)$/i.exec(name);
      if (!m || referenced.has(m[1])) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs > now - GRACE_MS) continue;
        fs.rmSync(file);
        deleted.push(m[1]);
      } catch {
        /* vanished or unreadable; skip */
      }
    }
    return deleted;
  }
}
