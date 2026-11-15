import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const workflows = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

test('devops: toda ação dos workflows é fixada por SHA de commit (tag móvel não entra)', () => {
  assert.ok(workflows.length > 0);
  const loose = [];
  for (const f of workflows) {
    for (const [, ref] of readFileSync(join(DIR, f), 'utf8').matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
      if (!/@[0-9a-f]{40}$/.test(ref)) loose.push(`${f}: ${ref}`);
    }
  }
  assert.deepEqual(loose, []);
});

test('devops: workflows declaram permissions mínimas e não usam pull_request_target', () => {
  for (const f of workflows) {
    const src = readFileSync(join(DIR, f), 'utf8');
    assert.match(src, /^permissions:/m, `${f} sem permissions`);
    assert.doesNotMatch(src, /pull_request_target/, `${f} usa pull_request_target`);
    assert.doesNotMatch(src, /run:.*\$\{\{\s*github\.event\./, `${f} interpola dado do evento em run`);
  }
});
