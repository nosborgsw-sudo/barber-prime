import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { API_ROUTES, createApp } from '../../server/app.mjs';
import { startServer } from '../../server/index.mjs';

async function withServer(run) {
  const server = createApp();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

// Sem banco configurado o servidor não finge funcionar: saúde 503 e nenhuma rota de negócio responde dados.
test('bootstrap: sem banco, saúde informa explicitamente que produto não está operacional', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await response.json(), { status: 'error', stage: 'operational', operational: false, database: 'unavailable' });
  });
});

test('bootstrap: sem banco, rotas de negócio respondem 503 sem simulação; rota inexistente 404', async () => {
  await withServer(async (base) => {
    for (const [method, path] of [['GET', '/api/appointments'], ['GET', '/api/staff'], ['POST', '/api/auth/session']]) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'DB_UNAVAILABLE');
    }
    const missing = await fetch(`${base}/api/inexistente`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'NOT_FOUND');
    const wrongMethod = await fetch(`${base}/api/health`, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET');
  });
});

test('bootstrap: configuração de porta inválida é recusada antes de escutar', () => {
  for (const port of ['abc', '-1', '65536', '3.5', '', ' ']) {
    assert.throws(() => startServer({ port }), /PORT/);
  }
  assert.throws(() => startServer({ host: '' }), /HOST/);
});

test('bootstrap: ponto de entrada inicia em porta atribuída pelo sistema', async () => {
  const server = startServer({ port: 0, dataDir: 'memory://', adminLogin: '', adminPassword: '', log: { info() {}, error() {} } });
  await once(server, 'listening');
  try {
    assert.ok(server.address().port > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('contrato: módulos têm donos, reservas separadas e rotas do contrato iguais às do servidor', async () => {
  const contract = JSON.parse(await readFile(new URL('../../docs/contrato-api.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(contract.reservas).sort(), ['backend', 'dados', 'devops', 'frontend', 'rpa']);
  const patterns = Object.values(contract.reservas).flat();
  assert.equal(new Set(patterns).size, patterns.length);
  for (const module of contract.sistema.modulos) {
    assert.ok(contract.reservas[module.dono]);
    assert.ok(module.arquivos.length > 0);
    assert.ok(module.requisitos.length > 0);
  }
  const implemented = contract.rotas.filter((route) => route.estado === 'implementada').map((route) => `${route.metodo} ${route.caminho}`);
  assert.deepEqual(implemented.sort(), [...API_ROUTES].sort());
  assert.equal(contract.rotas.filter((route) => route.estado !== 'implementada').length, 0);
  assert.ok(implemented.length >= 20);
});
