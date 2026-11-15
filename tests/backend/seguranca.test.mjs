// Segurança (revisão rodada 2): bloqueio de login por terceiros, X-Forwarded-For forjado, teto de reservas,
// cookie do cadastro, tempo/falha do provedor no desafio, HSTS e CSP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { configFromEnv, createApp } from '../../server/app.mjs';
import { ensureAdmin } from '../../server/auth/rotas.mjs';
import { MAX_ACTIVE_FUTURE_PER_CUSTOMER, serialByCustomer } from '../../server/booking/rotas.mjs';
import { CHALLENGES_PER_REQUESTER_PER_DAY } from '../../db/index.mjs';
import { openDatabase } from '../../server/db.mjs';
import { ADMIN, Client, catalog, randomSecret, nextWorkday, registerCustomer, slots, startApp } from './apoio.mjs';

const silent = { info() {}, error() {}, warn() {} };
const key = () => randomBytes(18).toString('base64url');

async function withApp(options, run) {
  const app = await startApp(options);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

// App com configuração de ambiente própria (ex.: TRUST_PROXY, COOKIE_SECURE); `limits` sobrepõe limites
// de janela curta e `sendChallenge` é o dublê do provedor de SMS.
async function withEnvApp(env, run, { limits = {}, sendChallenge = null } = {}) {
  const pool = await openDatabase({ databaseUrl: '', dataDir: 'memory://' });
  await ensureAdmin(pool, ADMIN);
  const config = configFromEnv(env);
  config.limits = { ...config.limits, ...limits };
  const server = createApp({ pool, config, sendChallenge, log: silent });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, client: () => new Client(base) });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}

test('segurança: tentativas erradas de terceiros não travam o login do administrador', async () => {
  await withEnvApp({ TRUST_PROXY: '1' }, async ({ client }) => {
    const atacante = client();
    let limited = false;
    for (let i = 0; i < 10 && !limited; i++) {
      const res = await atacante.post('/api/auth/session', { login: ADMIN.login, password: randomSecret() },
        { headers: { 'x-forwarded-for': '203.0.113.9' } });
      limited = res.status === 429;
    }
    assert.ok(limited, 'tentativas do atacante deveriam ser limitadas');
    const dono = await client().post('/api/auth/session', ADMIN, { headers: { 'x-forwarded-for': '198.51.100.20' } });
    assert.equal(dono.status, 200);
  });
});

test('segurança: X-Forwarded-For forjado pelo cliente não troca o IP usado nos limites', async () => {
  await withEnvApp({ TRUST_PROXY: '1' }, async ({ client }) => {
    const c = client();
    let limited = false;
    // O cliente varia a primeira entrada; o proxy confiável acrescenta sempre o mesmo IP real no fim.
    for (let i = 0; i < 10 && !limited; i++) {
      const res = await c.post('/api/auth/register', { name: 'Robo', phone: `119876${String(i).padStart(5, '0')}` },
        { headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` } });
      limited = res.status === 429;
    }
    assert.ok(limited, 'IP forjado na primeira entrada escapou do limite');
  });
});

test('segurança: cliente tem teto de reservas futuras ativas; cancelar libera e repetição idempotente continua valendo', async () => {
  await withApp({}, async ({ client }) => {
    const ana = client();
    await registerCustomer(ana, 'Ana Teto', '11987650099');
    const { staff, services } = await catalog(ana);
    const date = nextWorkday(2);
    const book = async (i, headers = {}) => {
      const staffId = staff[i % staff.length].id;
      const [slot] = await slots(ana, staffId, services[0].id, date);
      return ana.post('/api/appointments', { staffId, serviceId: services[0].id, startAt: slot.startAt }, { headers });
    };
    const made = [];
    let lastKey;
    let lastBody;
    for (let i = 0; i < MAX_ACTIVE_FUTURE_PER_CUSTOMER; i++) {
      lastKey = key();
      const res = await book(i, { 'idempotency-key': lastKey });
      assert.equal(res.status, 201, res.text);
      made.push(res.json.data);
    }
    const extra = await book(MAX_ACTIVE_FUTURE_PER_CUSTOMER);
    assert.equal(extra.status, 409);
    assert.equal(extra.json.error.code, 'BOOKING_LIMIT');

    // Repetir a última requisição (mesma chave e corpo) devolve a reserva existente, sem 409.
    const last = made.at(-1);
    lastBody = { staffId: last.staffId, serviceId: last.serviceId, startAt: last.startAt };
    const replay = await ana.post('/api/appointments', lastBody, { headers: { 'idempotency-key': lastKey } });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.data.id, last.id);

    const cancelled = await ana.post(`/api/appointments/${made[0].id}/cancel`, { version: made[0].version });
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal((await book(MAX_ACTIVE_FUTURE_PER_CUSTOMER)).status, 201);
  });
});

test('segurança: cadastro com telefone existente emite cookie novo como o cadastro novo, mesmo com sessão prévia', async () => {
  await withApp({}, async ({ client }) => {
    await registerCustomer(client(), 'Primeiro', '31987650011');
    const cookieNames = (r) => r.headers.getSetCookie().map((l) => l.split('=')[0]).sort();
    const tentar = async (phone) => {
      const c = client();
      await c.get('/api/auth/csrf'); // sessão anônima já existente
      const res = await c.post('/api/auth/register', { name: 'Outro', phone });
      return { res, me: await c.get('/api/me') };
    };
    const novo = await tentar('31987650012');
    const repetido = await tentar('31987650011');
    assert.equal(novo.res.status, repetido.res.status);
    assert.deepEqual(cookieNames(novo.res), cookieNames(repetido.res));
    assert.equal(cookieNames(repetido.res).length, 1);
    assert.equal(repetido.me.status, 401, 'telefone existente nunca recebe sessão de cliente');
  });
});

test('segurança: desafio não espera o provedor; falha ou lentidão dele não revela telefone cadastrado', async () => {
  const lento = () => new Promise((_, reject) => setTimeout(() => reject(new Error('provedor fora')), 1500));
  await withApp({ sendChallenge: lento }, async ({ client }) => {
    await registerCustomer(client(), 'Ana Desafio', '11987650077');
    const medir = async (phone) => {
      const inicio = Date.now();
      const res = await client().post('/api/auth/challenges', { phone });
      return { res, ms: Date.now() - inicio };
    };
    const cadastrado = await medir('11987650077');
    const desconhecido = await medir('21900000077');
    assert.equal(cadastrado.res.status, 202);
    assert.equal(desconhecido.res.status, 202);
    assert.deepEqual(Object.keys(cadastrado.res.json.data).sort(), Object.keys(desconhecido.res.json.data).sort());
    assert.ok(cadastrado.ms < 1000, `resposta esperou o provedor (${cadastrado.ms} ms)`);
    await new Promise((resolve) => setTimeout(resolve, 1700)); // a rejeição do provedor é tratada sem derrubar nada
  });
});

test('segurança: HSTS só em deploy HTTPS e CSP com script-src no frontend e no HTML autônomo', async () => {
  await withEnvApp({ COOKIE_SECURE: '1' }, async ({ client }) => {
    const res = await client().get('/api/health');
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  });
  await withApp({}, async ({ client }) => {
    const c = client();
    assert.equal((await c.get('/api/health')).headers.get('strict-transport-security'), null);
    const page = await c.get('/');
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    const auto = await c.get('/app-autonomo.html');
    if (auto.status === 200) {
      const cspAuto = auto.headers.get('content-security-policy');
      assert.match(cspAuto, /script-src 'unsafe-inline'/);
      assert.match(cspAuto, /connect-src 'none'/);
    }
  });
});

test('segurança: teto diário de códigos SMS por telefone e solicitante vale pela API, sem travar outro solicitante', async () => {
  const sent = [];
  // Janela curta folgada para chegar ao teto diário da camada de dados.
  const limits = { auth: { windowSeconds: 15 * 60, max: 100 } };
  await withEnvApp({ TRUST_PROXY: '1' }, async ({ client }) => {
    await registerCustomer(client(), 'Ana Cota', '11987650055');
    const pedir = (ip) => client().post('/api/auth/challenges', { phone: '11987650055' }, { headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < CHALLENGES_PER_REQUESTER_PER_DAY; i++) assert.equal((await pedir('203.0.113.50')).status, 202);
    const excedente = await pedir('203.0.113.50');
    assert.equal(excedente.status, 429);
    assert.equal(excedente.json.error.code, 'RATE_LIMITED');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sent.length, CHALLENGES_PER_REQUESTER_PER_DAY, 'nenhum SMS além do teto diário');
    // O dono, de outra origem, ainda recebe o código.
    assert.equal((await pedir('198.51.100.60')).status, 202);
  }, { limits, sendChallenge: async (message) => { sent.push(message); } });
});

test('segurança: reservas simultâneas do mesmo cliente não passam do teto', async () => {
  await withApp({}, async ({ client }) => {
    const ana = client();
    await registerCustomer(ana, 'Ana Corrida', '11987650066');
    const { staff, services } = await catalog(ana);
    const service = services[0];
    const date = nextWorkday(3);
    // Horários sem sobreposição: em cada profissional, um a cada duração do serviço.
    const livres = [];
    for (const s of staff) {
      let fim = 0;
      for (const slot of await slots(ana, s.id, service.id, date)) {
        const inicio = Date.parse(slot.startAt);
        if (inicio < fim) continue;
        livres.push({ staffId: s.id, startAt: slot.startAt });
        fim = inicio + service.durationMinutes * 60_000;
      }
    }
    const pedidos = livres.slice(0, MAX_ACTIVE_FUTURE_PER_CUSTOMER + 3)
      .map((l) => ana.post('/api/appointments', { staffId: l.staffId, serviceId: service.id, startAt: l.startAt }));
    const results = await Promise.all(pedidos);
    assert.equal(results.length, MAX_ACTIVE_FUTURE_PER_CUSTOMER + 3);
    assert.deepEqual(results.map((r) => r.status).sort(), [
      ...Array(MAX_ACTIVE_FUTURE_PER_CUSTOMER).fill(201), ...Array(3).fill(409)].sort());
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.json.error.code === 'BOOKING_LIMIT'));
  });
});

test('segurança: verificação do teto e criação da reserva do mesmo cliente rodam em série; clientes diferentes não esperam', async () => {
  const pausa = () => new Promise((resolve) => setTimeout(resolve, 20));
  let ativos = 0;
  let maximo = 0;
  const tarefa = async () => {
    ativos += 1;
    maximo = Math.max(maximo, ativos);
    await pausa(); // entre a contagem e a criação
    ativos -= 1;
  };
  await Promise.all([1, 2, 3, 4].map(() => serialByCustomer('cliente-a', tarefa)));
  assert.equal(maximo, 1, 'duas verificações do mesmo cliente se sobrepuseram');
  // Uma falha não trava a fila do cliente.
  await assert.rejects(serialByCustomer('cliente-a', async () => { throw new Error('x'); }));
  assert.equal(await serialByCustomer('cliente-a', async () => 'ok'), 'ok');
  maximo = 0;
  await Promise.all(['b', 'c'].map((id) => serialByCustomer(id, tarefa)));
  assert.equal(maximo, 2);
});
