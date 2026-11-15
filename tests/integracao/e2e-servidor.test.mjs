// Integração entre frentes: servidor real em processo separado (como `npm start`), frontend servido,
// API, PostgreSQL embutido e reinício do processo, pelo script de ponta a ponta.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runE2E } from '../../scripts/e2e-servidor.mjs';

test('integração: ponta a ponta no servidor real em processo separado, com reinício e persistência', { timeout: 180_000 }, async () => {
  const lines = [];
  const checks = await runE2E({ log: (line) => lines.push(line) });
  assert.equal(checks, 22, lines.join('\n'));
  assert.match(lines.at(-1), /^E2E OK/);
});
