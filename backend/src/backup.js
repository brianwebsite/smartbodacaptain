// Keeps the database safe across redeploys on hosts that wipe the disk (such as Render's free plan).
// The database is copied to any S3-compatible storage (Cloudflare R2, Backblaze B2, AWS S3) and
// copied back when the server starts with no database file. Uses only Node's built-in modules.

import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const encodePath = (p) => p.split('/').map((s) => encodeURIComponent(s)).join('/');

/** A tiny S3 client: upload and download one object, signed with AWS Signature V4. */
export function s3Client({ endpoint, region = 'auto', bucket, accessKeyId, secretAccessKey, fetchImpl = fetch, now = () => new Date() }) {
  const base = new URL(endpoint);
  const sign = (method, key, body) => {
    const d = now();
    const amzDate = d.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20261116T180000Z
    const day = amzDate.slice(0, 8);
    const path = `/${encodePath(bucket)}/${encodePath(key)}`;
    const payloadHash = sha256(body ?? '');
    const headers = { host: base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const names = Object.keys(headers).sort();
    const canonical = [
      method,
      path,
      '',
      names.map((n) => `${n}:${headers[n]}\n`).join(''),
      names.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const kDate = hmac(`AWS4${secretAccessKey}`, day);
    const signature = createHmac('sha256', hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request')).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    delete headers.host;
    return { url: `${base.origin}${path}`, headers };
  };
  return {
    async put(key, body) {
      const { url, headers } = sign('PUT', key, body);
      const res = await fetchImpl(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`Backup upload failed: HTTP ${res.status}`);
    },
    /** The stored bytes, or null when nothing is stored yet. */
    async get(key) {
      const { url, headers } = sign('GET', key, '');
      const res = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(60000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Backup download failed: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

/** Reads the backup settings from environment variables. Null when backups are not set up. */
export function backupFromEnv(env = process.env) {
  const v = (k) => env[k]?.trim();
  if (!v('BACKUP_S3_ENDPOINT') || !v('BACKUP_S3_BUCKET') || !v('BACKUP_S3_KEY_ID') || !v('BACKUP_S3_SECRET')) return null;
  return {
    client: s3Client({
      endpoint: v('BACKUP_S3_ENDPOINT'),
      region: v('BACKUP_S3_REGION') || 'auto',
      bucket: v('BACKUP_S3_BUCKET'),
      accessKeyId: v('BACKUP_S3_KEY_ID'),
      secretAccessKey: v('BACKUP_S3_SECRET'),
    }),
    key: v('BACKUP_S3_OBJECT') || 'smartboda-app/smartboda.db', // its own folder, so other apps sharing the bucket are untouched
    intervalMs: Math.max(10, Number(v('BACKUP_INTERVAL_SECONDS')) || 30) * 1000,
  };
}

/** Before the database is opened: if there is no file, fetch the last backup. */
export async function restoreIfMissing({ client, key }, dbPath) {
  if (existsSync(dbPath)) return 'kept';
  const data = await client.get(key);
  if (!data) return 'nothing-to-restore';
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, data);
  return 'restored';
}

/** Copies the database to storage now and then, and whenever asked (for example on shutdown). */
export function startBackups({ db, client, key, intervalMs = 30000, log = console }) {
  let lastChanges = null;
  let busy = false;
  const snapshot = async (force = false) => {
    if (busy) return false;
    busy = true;
    const file = join(tmpdir(), `smartboda-backup-${process.pid}.db`);
    try {
      const changes = db.prepare('SELECT total_changes() AS c').get().c;
      if (!force && changes === lastChanges) return false; // nothing new
      rmSync(file, { force: true });
      db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`); // a consistent copy while the server runs
      await client.put(key, readFileSync(file));
      lastChanges = changes;
      return true;
    } catch (err) {
      log.error(`Database backup failed: ${err.message}`);
      return false;
    } finally {
      rmSync(file, { force: true });
      busy = false;
    }
  };
  const timer = setInterval(() => void snapshot(), intervalMs);
  timer.unref?.();
  return {
    snapshot,
    /** Final copy before the server stops. */
    async flush() {
      clearInterval(timer);
      while (busy) await new Promise((r) => setTimeout(r, 50));
      return snapshot(true);
    },
  };
}
