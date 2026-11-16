import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { estimateRouting } from '../src/routing.js';
import { googleVerifier } from '../src/google.js';

async function start({ google = false } = {}) {
  const db = openDb(':memory:');
  // A stand-in for Google's check: tokens look like "ok:<sub>:<email>:<name>".
  const googleVerify = async (tok) => {
    const [kind, sub, email, name] = String(tok).split(':');
    if (kind !== 'ok') throw new Error('rejected');
    return { sub, email, name: name ?? '' };
  };
  const { server } = createApp({
    db,
    routing: estimateRouting(),
    ...(google ? { googleVerify, googleClientId: 'web-client-id' } : {}),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, close: () => server.close(), db };
}

test('email sign-up, then sign in by email or by phone', async () => {
  const { call, close } = await start();
  const reg = await call('POST', '/api/auth/register', {
    role: 'passenger', name: 'Amina', phone: '0772300001', email: 'Amina@Example.com', password: 'secret123',
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.email, 'amina@example.com');

  const byEmail = await call('POST', '/api/auth/login', { identifier: ' AMINA@example.com ', password: 'secret123' });
  assert.equal(byEmail.status, 200);
  const byPhone = await call('POST', '/api/auth/login', { identifier: '0772 300001', password: 'secret123' });
  assert.equal(byPhone.status, 200);
  const oldStyle = await call('POST', '/api/auth/login', { phone: '0772300001', password: 'secret123' });
  assert.equal(oldStyle.status, 200);
  const wrong = await call('POST', '/api/auth/login', { identifier: 'amina@example.com', password: 'nope-nope' });
  assert.equal(wrong.status, 401);
  close();
});

test('duplicate email and bad email are refused with clear codes', async () => {
  const { call, close } = await start();
  const base = { role: 'passenger', name: 'Amina', password: 'secret123' };
  assert.equal((await call('POST', '/api/auth/register', { ...base, phone: '0772300002', email: 'a@b.co' })).status, 201);
  const dup = await call('POST', '/api/auth/register', { ...base, phone: '0772300003', email: 'A@B.co' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'email_taken');
  const bad = await call('POST', '/api/auth/register', { ...base, phone: '0772300004', email: 'not-an-email' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'bad_email');
  const phoneDup = await call('POST', '/api/auth/register', { ...base, phone: '0772300002' });
  assert.equal(phoneDup.body.code, 'phone_taken');
  close();
});

test('options say Google is off until the server has a client ID', async () => {
  const off = await start();
  assert.deepEqual((await off.call('GET', '/api/auth/options')).body, { google: null });
  assert.equal((await off.call('POST', '/api/auth/google', { idToken: 'ok:1:a@b.co:Al' })).body.code, 'google_unavailable');
  off.close();
  const on = await start({ google: true });
  assert.deepEqual((await on.call('GET', '/api/auth/options')).body, { google: { serverClientId: 'web-client-id' } });
  on.close();
});

test('Google: new person is asked for a phone number, then signed up; next time signs straight in', async () => {
  const { call, close } = await start({ google: true });
  const first = await call('POST', '/api/auth/google', { idToken: 'ok:g1:amina@gmail.com:Amina K' });
  assert.equal(first.status, 200);
  assert.equal(first.body.needsProfile, true);
  assert.equal(first.body.email, 'amina@gmail.com');

  const done = await call('POST', '/api/auth/google', { idToken: 'ok:g1:amina@gmail.com:Amina K', phone: '0772300010' });
  assert.equal(done.status, 201);
  assert.equal(done.body.user.role, 'passenger');
  assert.equal(done.body.user.phone, '+256772300010');
  assert.equal(done.body.user.email, 'amina@gmail.com');

  const again = await call('POST', '/api/auth/google', { idToken: 'ok:g1:amina@gmail.com:Amina K' });
  assert.equal(again.status, 200);
  assert.equal(again.body.user.id, done.body.user.id);
  assert.ok(again.body.token);
  close();
});

test('Google: rejected token, and a typed email is never taken over', async () => {
  const { call, close } = await start({ google: true });
  assert.equal((await call('POST', '/api/auth/google', { idToken: 'bad:1:a@b.co' })).status, 401);

  await call('POST', '/api/auth/register', {
    role: 'passenger', name: 'Victim', phone: '0772300020', email: 'victim@gmail.com', password: 'secret123',
  });
  const hijack = await call('POST', '/api/auth/google', { idToken: 'ok:g9:victim@gmail.com:Victim', phone: '0772300021' });
  assert.equal(hijack.status, 409);
  assert.equal(hijack.body.code, 'email_taken');
  close();
});

test('Google token checks: wrong app, unverified email, expired', async () => {
  const fake = (payload) => async () => ({ ok: true, json: async () => payload });
  const good = { aud: 'web-id', iss: 'accounts.google.com', exp: String(Math.floor(Date.now() / 1000) + 600),
    email_verified: 'true', email: 'A@B.co', sub: '123', name: 'Al' };
  const tok = 'x'.repeat(30);

  const ok = await googleVerifier(['web-id'], fake(good))(tok);
  assert.deepEqual(ok, { sub: '123', email: 'a@b.co', name: 'Al' });
  await assert.rejects(googleVerifier(['web-id'], fake({ ...good, aud: 'other' }))(tok));
  await assert.rejects(googleVerifier(['web-id'], fake({ ...good, email_verified: 'false' }))(tok));
  await assert.rejects(googleVerifier(['web-id'], fake({ ...good, exp: '1' }))(tok));
  await assert.rejects(googleVerifier(['web-id'], fake({ ...good, iss: 'evil.com' }))(tok));
  await assert.rejects(googleVerifier(['web-id'], async () => ({ ok: false }))(tok));
});
