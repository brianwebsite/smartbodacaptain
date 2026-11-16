import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/db.js';
import { s3Client, restoreIfMissing, startBackups } from '../src/backup.js';

function fakeBucket() {
  const objects = new Map();
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, method: opts.method, headers: opts.headers });
    const key = new URL(url).pathname;
    if (opts.method === 'PUT') {
      objects.set(key, Buffer.from(opts.body));
      return { ok: true, status: 200 };
    }
    const o = objects.get(key);
    return o ? { ok: true, status: 200, arrayBuffer: async () => o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength) } : { ok: false, status: 404 };
  };
  return { objects, seen, fetchImpl };
}

test('a signed upload with the standard AWS test vector headers shape', async () => {
  const b = fakeBucket();
  const client = s3Client({
    endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'bk', accessKeyId: 'AKID', secretAccessKey: 'SECRET',
    fetchImpl: b.fetchImpl, now: () => new Date('2026-11-16T18:00:00Z'),
  });
  await client.put('smartboda.db', Buffer.from('hello'));
  const h = b.seen[0].headers;
  assert.equal(h['x-amz-date'], '20261116T180000Z');
  assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/20261116\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(h['x-amz-content-sha256'], '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'); // sha256("hello")
  assert.equal((await client.get('smartboda.db')).toString(), 'hello');
  assert.equal(await client.get('missing'), null);
  assert.ok(!JSON.stringify(b.seen).includes('SECRET')); // the secret never travels
});

test('accounts and sign-ins survive a wiped disk', async () => {
  const b = fakeBucket();
  const client = s3Client({ endpoint: 'https://s3.example.com', bucket: 'bk', accessKeyId: 'a', secretAccessKey: 's', fetchImpl: b.fetchImpl });
  const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  const path = join(dir, 'smartboda.db');

  assert.equal(await restoreIfMissing({ client, key: 'smartboda.db' }, path), 'nothing-to-restore');
  const db = openDb(path);
  db.prepare('INSERT INTO users (id, role, name, phone, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('u1', 'passenger', 'Amina', '+256700000001', 'x', 'active', '2026-11-16T10:00:00Z');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run('tok', 'u1', '2026-11-16T10:00:00Z', '2027-11-16T10:00:00Z');
  const backups = startBackups({ db, client, key: 'smartboda.db', intervalMs: 3600000 });
  assert.equal(await backups.snapshot(), true);
  assert.equal(await backups.snapshot(), false); // unchanged: nothing uploaded again
  db.close();
  await backups.flush();

  // A redeploy: the disk is empty again.
  const fresh = join(mkdtempSync(join(tmpdir(), 'bk-')), 'smartboda.db');
  assert.equal(await restoreIfMissing({ client, key: 'smartboda.db' }, fresh), 'restored');
  const back = openDb(fresh);
  assert.equal(back.prepare('SELECT name FROM users WHERE id = ?').get('u1').name, 'Amina');
  assert.equal(back.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get('tok').user_id, 'u1');
  back.close();

  // An existing database is never overwritten by a backup.
  assert.equal(await restoreIfMissing({ client, key: 'smartboda.db' }, fresh), 'kept');
  assert.ok(existsSync(fresh) && readFileSync(fresh).length > 0);
});
