// Testes de unidade das peças de segurança do backend (sem servidor nem banco).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sep } from 'node:path';
import { codeHash, cookieName, hashPassword, newToken, phoneHash, sha256, verifyPassword } from '../../server/auth/seguranca.mjs';
import { resolveStatic } from '../../server/static.mjs';

test('seguranca: scrypt com salt aleatório verifica só a senha certa', async () => {
  const [right, wrong] = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')];
  const hash = await hashPassword(right);
  assert.match(hash, /^scrypt\$32768\$8\$3\$/);
  assert.notEqual(hash, await hashPassword(right));
  assert.equal(await verifyPassword(right, hash), true);
  assert.equal(await verifyPassword(wrong, hash), false);
  assert.equal(await verifyPassword(wrong, null), false);
  assert.equal(await verifyPassword(wrong, 'formato$invalido'), false);
});

test('seguranca: tokens aleatórios de 256 bits, hashes com chave do servidor e cookie __Host- em HTTPS', () => {
  const a = newToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, newToken());
  assert.equal(sha256(a).length, 32);
  const k1 = { phoneHashKey: Buffer.alloc(32, 1) };
  const k2 = { phoneHashKey: Buffer.alloc(32, 2) };
  assert.notDeepEqual(phoneHash(k1, '+5511987654321'), phoneHash(k2, '+5511987654321'));
  assert.notDeepEqual(codeHash(k1, '123456'), codeHash(k1, '123457'));
  assert.equal(cookieName({ cookieSecure: true }), '__Host-bp_session');
  assert.equal(cookieName({ cookieSecure: false }), 'bp_session');
});

test('static: só entrega arquivos de public/ com extensão conhecida', () => {
  assert.ok(resolveStatic('/').endsWith(`${sep}public${sep}index.html`));
  assert.ok(resolveStatic('/styles.css').endsWith(`${sep}public${sep}styles.css`));
  for (const path of ['/../package.json', '/%2e%2e/server/app.mjs', '/a/..%2f..%2fpackage.json', '/.env', '/%00.html', '/x%5c..%5c.html', '/arquivo.exe', '/%E0%A4%A']) {
    assert.equal(resolveStatic(path), null, path);
  }
});
