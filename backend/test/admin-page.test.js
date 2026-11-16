import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// A typo in the admin page's script leaves a blank page, so check it parses.
test('the admin page script has no syntax errors', () => {
  const html = readFileSync(new URL('../../admin/index.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'admin page has a script');
  const file = join(mkdtempSync(join(tmpdir(), 'admin-')), 'admin.js');
  writeFileSync(file, script);
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
