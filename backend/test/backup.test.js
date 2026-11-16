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

test('the admin can prove the bucket works: write, read back, check it is a database', async () => {
  const b = fakeBucket();
  const client = s3Client({ endpoint: 'https://s3.example.com', bucket: 'bk', accessKeyId: 'a', secretAccessKey: 's', fetchImpl: b.fetchImpl });
  const db = openDb(':memory:');
  const backups = startBackups({ db, client, key: 'smartboda-app/smartboda.db', intervalMs: 3600000, log: { error() {} } });
  assert.equal(backups.status().lastOkAt, null);
  const r = await backups.verify();
  assert.equal(r.ok, true);
  assert.ok(r.bytes > 1000);
  assert.ok(backups.status().lastOkAt);
  assert.equal(backups.status().lastError, null);
  await backups.flush();

  // A bucket that refuses the upload: the reason is shown, not hidden.
  const bad = s3Client({ endpoint: 'https://s3.example.com', bucket: 'bk', accessKeyId: 'a', secretAccessKey: 's', fetchImpl: async () => ({ ok: false, status: 403 }) });
  const broken = startBackups({ db, client: bad, key: 'k', intervalMs: 3600000, log: { error() {} } });
  const r2 = await broken.verify();
  assert.equal(r2.ok, false);
  assert.match(r2.error, /HTTP 403/);
  await broken.flush();
  db.close();
});

test('admin backup routes: status and back-up-now', async () => {
  const { createApp } = await import('../src/app.js');
  const { hashPassword } = await import('../src/auth.js');
  const b = fakeBucket();
  const client = s3Client({ endpoint: 'https://s3.example.com', bucket: 'bk', accessKeyId: 'a', secretAccessKey: 's', fetchImpl: b.fetchImpl });
  const db = openDb(':memory:');
  db.prepare('INSERT INTO users (id, role, name, phone, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('adm', 'admin', 'Boss', '+256700000009', hashPassword('adminpass123'), 'active', '2026-11-16T10:00:00Z');
  const backups = startBackups({ db, client, key: 'smartboda-app/smartboda.db', intervalMs: 3600000, log: { error() {} } });
  const { server } = createApp({ db, routing: {}, backups });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const token = (await call('POST', '/api/auth/login', { phone: '0700000009', password: 'adminpass123' })).body.token;
  assert.equal((await call('GET', '/api/admin/backup-status')).status, 401);
  const before = (await call('GET', '/api/admin/backup-status', undefined, token)).body;
  assert.equal(before.on, true);
  assert.equal(before.lastOkAt, null);
  const done = (await call('POST', '/api/admin/backup-now', {}, token)).body;
  assert.equal(done.result.ok, true);
  assert.ok(done.status.lastOkAt);
  assert.ok([...b.objects.keys()].some((k) => k.endsWith('/smartboda-app/smartboda.db')));
  await backups.flush();
  server.close();
  db.close();
});
