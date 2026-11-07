// Admin commands, run inside the container:
//   docker exec wemake npx tsx server/admin.ts list-users
//   docker exec wemake npx tsx server/admin.ts reset-password <username>   (prints a new password)
//   docker exec wemake npx tsx server/admin.ts delete-user <username>
//   docker exec wemake npx tsx server/admin.ts compress-takes              (WAV → FLAC for existing takes)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from './db.ts';
import { Accounts } from './accounts.ts';
import { Storage } from './storage.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'compress-takes') {
    const audio = path.join(DATA, 'audio');
    const storage = new Storage({ audioDir: audio, minFreeBytes: 0 });
    let before = 0, after = 0, n = 0, kept = 0;
    for (const room of fs.existsSync(audio) ? fs.readdirSync(audio) : []) {
      const dir = path.join(audio, room);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir).filter((f) => /^[a-z0-9]+\.wav$/i.test(f))) {
        const wav = path.join(dir, name);
        const size = fs.statSync(wav).size;
        await storage.enqueueFlac(wav);
        const flac = wav.replace(/\.wav$/, '.flac');
        if (fs.existsSync(flac) && !fs.existsSync(wav)) { before += size; after += fs.statSync(flac).size; n++; }
        else kept++;
      }
    }
    const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
    console.log(`Compressed ${n} take(s): ${mb(before)} MB → ${mb(after)} MB.${kept ? ` ${kept} left as WAV (encoder failed or missing).` : ''}`);
    return;
  }

  const db = new Db(path.join(DATA, 'wemake.db'));
  const accounts = new Accounts(db);
  try {
    switch (cmd) {
      case 'list-users':
        for (const u of accounts.listUsers()) console.log(`${u.username}\t${new Date(u.created_at).toISOString()}`);
        return;
      case 'reset-password': {
        if (!arg) fail('usage: reset-password <username>');
        const pw = accounts.resetPassword(arg);
        if (!pw) fail(`No user called ${arg}`);
        console.log(`New password for ${arg.toLowerCase()}: ${pw}`);
        return;
      }
      case 'delete-user':
        if (!arg) fail('usage: delete-user <username>');
        if (!accounts.deleteUser(arg)) fail(`No user called ${arg}`);
        console.log(`Deleted ${arg.toLowerCase()} (their songs stay; only their list and saved sounds are removed).`);
        return;
      default:
        fail('usage: admin.ts <list-users | reset-password <user> | delete-user <user> | compress-takes>');
    }
  } finally {
    db.close();
  }
}

main().catch((err) => fail(String(err?.stack ?? err)));
