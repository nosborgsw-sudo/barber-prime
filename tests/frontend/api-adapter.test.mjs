// Adaptador HTTP com fetch simulado: CSRF, Idempotency-Key, sessão e erros padronizados do contrato.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts, plain } from './apoio.mjs';

const { BPApi } = loadScripts(['public/core.js', 'public/api.js'], { fetch: () => { throw new Error('fetch global não deve ser usado'); } });

function json(status, body, headers) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: Object.assign(body === undefined ? {} : { 'content-type': 'application/json' }, headers),
  });
}

function fakeServer(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, credentials: init.credentials };
    calls.push(call);
    return handler(call, calls);
  };
  return { calls, api: BPApi.createApiAdapter({ fetch }) };
}

test('api adapter: mutação busca CSRF, envia X-CSRF-Token e Idempotency-Key na mesma origem', async () => {
  const { calls, api } = fakeServer((c) => {
    if (c.url === '/api/auth/csrf') return json(200, { data: { csrfToken: 'tok-1' } });
    if (c.url === '/api/appointments') return json(201, { data: { id: 'a1', status: 'confirmed' } });
    return json(404, { error: { code: 'NOT_FOUND' } });
  });
  const appt = await api.createAppointment({ staffId: 's', serviceId: 'v', startAt: 'x' }, 'chave-0123456789abcdef');
  assert.equal(appt.id, 'a1');
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.headers['X-CSRF-Token'], 'tok-1');
  assert.equal(post.headers['Idempotency-Key'], 'chave-0123456789abcdef');
  assert.equal(post.credentials, 'same-origin');
});

test('api adapter: usa o csrfToken devolvido pelo login e renova uma vez após 403 CSRF', async () => {
  let csrfCalls = 0;
  const { calls, api } = fakeServer((c, all) => {
    if (c.url === '/api/auth/csrf') { csrfCalls += 1; return json(200, { data: { csrfToken: 'tok-renovado' } }); }
    if (c.url === '/api/auth/session') return json(200, { data: { id: 'u', role: 'admin', csrfToken: 'tok-login' } });
    if (c.url.startsWith('/api/admin/services')) {
      const tries = all.filter((x) => x.url.startsWith('/api/admin/services')).length;
      return tries === 1 ? json(403, { error: { code: 'CSRF_INVALID' } }) : json(201, { data: { id: 'svc' } });
    }
    return json(404, { error: { code: 'NOT_FOUND' } });
  });
  await api.login({ login: 'admin', password: 'x'.repeat(12) });
  const before = csrfCalls;
  const created = await api.createService({ name: 'Corte', durationMinutes: 30, priceCents: 100 });
  assert.equal(created.id, 'svc');
  const posts = calls.filter((c) => c.url === '/api/admin/services');
  assert.equal(posts[0].headers['X-CSRF-Token'], 'tok-login', 'token do login usado direto');
  assert.equal(posts[1].headers['X-CSRF-Token'], 'tok-renovado');
  assert.equal(csrfCalls - before, 1, 'renova uma única vez');
});

test('api adapter: me() sem sessão devolve null; erros viram ApiError com código e campos', async () => {
  const { api } = fakeServer((c) => {
    if (c.url === '/api/auth/session' && c.method === 'GET') return json(200, { data: null });
    if (c.url === '/api/auth/csrf') return json(200, { data: { csrfToken: 't' } });
    if (c.url === '/api/auth/register') return json(400, { error: { code: 'VALIDATION_ERROR', message: 'Entrada inválida.', fields: { phone: 'Telefone inválido.' } } });
    if (c.url.startsWith('/api/availability')) return json(429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '30' });
    return json(404, { error: { code: 'NOT_FOUND' } });
  });
  assert.equal(await api.me(), null);
  await assert.rejects(api.register({ name: 'Ana', phone: '1' }), (e) => {
    assert.equal(e.code, 'VALIDATION_ERROR');
    assert.deepEqual(plain(e.fields), { phone: 'Telefone inválido.' });
    return true;
  });
  await assert.rejects(api.availability({ staffId: 'a', serviceId: 'b', date: '2026-11-16' }), (e) => e.status === 429 && e.retryAfter === 30);
});

test('api adapter: query string codificada e falha de rede vira NETWORK_ERROR', async () => {
  const { calls, api } = fakeServer((c) => json(200, { data: [], meta: { cursor: null } }));
  const r = await api.listAppointments({ from: '2026-11-16', to: '2026-11-16', staffId: undefined });
  assert.deepEqual(plain(r), { data: [], meta: { cursor: null } });
  assert.equal(calls[0].url, '/api/appointments?from=2026-11-16&to=2026-11-16');
  await api.reschedule('../x', { startAt: 'y', version: 1 }).catch(() => null);
  assert.ok(calls.some((c) => c.url === '/api/appointments/..%2Fx/reschedule'), 'id é codificado no caminho');

  const offline = BPApi.createApiAdapter({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.staff(), (e) => e.code === 'NETWORK_ERROR' && e.status === 0);
});
