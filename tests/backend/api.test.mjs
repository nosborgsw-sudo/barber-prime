// Testes da API sobre servidor HTTP real e PostgreSQL embutido (PGlite), sem dublês do banco.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadSendChallenge } from '../../server/index.mjs';
import { ADMIN, randomSecret, catalog, loginAdmin, nextWorkday, registerCustomer, slots, startApp, tempDir } from './apoio.mjs';

const key = () => randomBytes(18).toString('base64url');

async function withApp(options, run) {
  const app = await startApp(options);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

test('backend: saúde com banco real responde operacional', async () => {
  await withApp({}, async ({ client }) => {
    const res = await client().get('/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { status: 'ok', stage: 'operational', operational: true, database: 'ok' });
  });
});

test('backend: catálogo público traz barbearia, horário de funcionamento, 4 barbeiros e serviços com preço e duração', async () => {
  await withApp({}, async ({ client }) => {
    const c = client();
    const shop = (await c.get('/api/shop')).json.data;
    assert.equal(shop.name, 'Barber Prime');
    assert.deepEqual(shop.openingHours.map((d) => d.weekday), [1, 2, 3, 4, 5, 6]);
    for (const day of shop.openingHours) assert.deepEqual([day.startLocal, day.endLocal], ['09:00', '19:00']);
    const { staff, services } = await catalog(c);
    assert.equal(staff.length, 4);
    for (const barber of staff) assert.deepEqual(Object.keys(barber).sort(), ['bio', 'id', 'name', 'role', 'sortOrder']);
    assert.ok(services.length >= 1);
    for (const service of services) {
      assert.ok(Number.isInteger(service.priceCents) && service.priceCents > 0);
      assert.ok(Number.isInteger(service.durationMinutes) && service.durationMinutes > 0);
    }
  });
});

test('backend: cadastro pede só nome e telefone, valida entrada e não duplica nem entrega sessão de cadastro existente', async () => {
  await withApp({}, async ({ client }) => {
    const ana = client();
    const anonymous = await ana.get('/api/auth/session');
    assert.deepEqual([anonymous.status, anonymous.json], [200, { data: null }]);
    assert.equal((await ana.get('/api/me')).status, 401);
    await registerCustomer(ana, 'Ana Souza', '(11) 98765-4321');
    assert.deepEqual((await ana.get('/api/auth/session')).json.data.name, 'Ana Souza');
    const me = await ana.get('/api/me');
    assert.equal(me.status, 200);
    assert.deepEqual([me.json.data.name, me.json.data.phone, me.json.data.role], ['Ana Souza', '+5511987654321', 'customer']);

    // Mesmo telefone em outro formato: mesma resposta 202, sem sessão e sem dados do cadastro existente.
    const intruso = client();
    const again = await intruso.post('/api/auth/register', { name: 'Outra Pessoa', phone: '+55 11 98765-4321' });
    assert.equal(again.status, 202);
    assert.equal(JSON.stringify(again.json).includes('Ana'), false);
    assert.equal((await intruso.get('/api/me')).status, 401);

    const bad = await client().post('/api/auth/register', { name: 'Bia', phone: '1234' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'VALIDATION_ERROR');
    const extra = await client().post('/api/auth/register', { name: 'Bia', phone: '11987650000', email: 'x@y.z' });
    assert.equal(extra.status, 400);
    assert.deepEqual(extra.json.error.fields, { email: 'campo não permitido' });
  });
});

test('backend: agendamento, conflito de horário, isolamento entre clientes, reagendamento e cancelamento', async () => {
  await withApp({}, async ({ client }) => {
    const ana = client();
    const bruno = client();
    await registerCustomer(ana, 'Ana Souza', '11987654321');
    await registerCustomer(bruno, 'Bruno Lima', '21987654321');
    const { staff, services } = await catalog(ana);
    const date = nextWorkday(2);
    const free = await slots(ana, staff[0].id, services[0].id, date);
    // Horário que não se sobrepõe ao primeiro (o serviço dura mais que o passo de 15 min).
    const later = free.find((s) => Date.parse(s.startAt) >= Date.parse(free[0].endAt));
    assert.ok(later);

    const created = await ana.post('/api/appointments',
      { staffId: staff[0].id, serviceId: services[0].id, startAt: free[0].startAt }, { headers: { 'idempotency-key': key() } });
    assert.equal(created.status, 201);
    const booking = created.json.data;
    assert.equal(booking.status, 'confirmed');
    assert.equal(booking.priceCents, services[0].priceCents);
    assert.equal('customerPhone' in booking, false);

    // Horário ocupado some da disponibilidade e segunda reserva no mesmo horário é recusada.
    assert.equal((await slots(bruno, staff[0].id, services[0].id, date)).some((s) => s.startAt === free[0].startAt), false);
    const clash = await bruno.post('/api/appointments', { staffId: staff[0].id, serviceId: services[0].id, startAt: free[0].startAt });
    assert.equal(clash.status, 409);
    assert.equal(clash.json.error.code, 'SLOT_CONFLICT');

    // Reserva de terceiro: invisível (404) para consultar, reagendar ou cancelar.
    assert.equal((await bruno.get(`/api/appointments/${booking.id}`)).status, 404);
    assert.equal((await bruno.post(`/api/appointments/${booking.id}/cancel`, { version: booking.version })).status, 404);
    assert.equal((await bruno.patch(`/api/appointments/${booking.id}/reschedule`, { startAt: later.startAt, version: booking.version })).status, 404);
    assert.deepEqual((await bruno.get('/api/appointments')).json.data, []);
    const mine = (await ana.get('/api/appointments')).json.data;
    assert.deepEqual(mine.map((a) => a.id), [booking.id]);

    const moved = await ana.patch(`/api/appointments/${booking.id}/reschedule`, { startAt: later.startAt, version: booking.version });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.data.startAt, later.startAt);
    assert.ok((await slots(ana, staff[0].id, services[0].id, date)).some((s) => s.startAt === free[0].startAt));

    const stale = await ana.post(`/api/appointments/${booking.id}/cancel`, { version: booking.version });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'VERSION_CONFLICT');
    const cancelled = await ana.post(`/api/appointments/${booking.id}/cancel`, { version: moved.json.data.version });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.data.status, 'cancelled');
  });
});

test('backend: reservas simultâneas no mesmo horário geram exatamente uma confirmação', async () => {
  await withApp({}, async ({ client }) => {
    const customers = [client(), client(), client()];
    for (const [i, c] of customers.entries()) await registerCustomer(c, `Cliente ${i}`, `1198765000${i}`);
    const { staff, services } = await catalog(customers[0]);
    const [slot] = await slots(customers[0], staff[1].id, services[0].id, nextWorkday(3));
    const results = await Promise.all(customers.map((c) =>
      c.post('/api/appointments', { staffId: staff[1].id, serviceId: services[0].id, startAt: slot.startAt })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
  });
});

test('backend: Idempotency-Key repete o resultado e recusa corpo diferente', async () => {
  await withApp({}, async ({ client }) => {
    const ana = client();
    await registerCustomer(ana, 'Ana Souza', '11987654321');
    const { staff, services } = await catalog(ana);
    const free = await slots(ana, staff[2].id, services[0].id, nextWorkday(2));
    const headers = { 'idempotency-key': key() };
    const body = { staffId: staff[2].id, serviceId: services[0].id, startAt: free[0].startAt };
    const first = await ana.post('/api/appointments', body, { headers });
    const replay = await ana.post('/api/appointments', body, { headers });
    assert.deepEqual([first.status, replay.status], [201, 200]);
    assert.equal(replay.json.data.id, first.json.data.id);
    const changed = await ana.post('/api/appointments', { ...body, startAt: free[3].startAt }, { headers });
    assert.equal(changed.status, 409);
    assert.equal(changed.json.error.code, 'IDEMPOTENCY_CONFLICT');
    const badKey = await ana.post('/api/appointments', body, { headers: { 'idempotency-key': 'curta' } });
    assert.equal(badKey.status, 400);
  });
});

test('backend: CSRF recusa outra origem e navegador sem token; aceita token da sessão', async () => {
  await withApp({}, async ({ client }) => {
    const evil = await client().post('/api/auth/register', { name: 'Ana', phone: '11987654321' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.error.code, 'CSRF_ORIGIN');
    const c = client();
    const noToken = await c.post('/api/auth/register', { name: 'Ana', phone: '11987654321' }, { headers: { origin: c.base } });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.json.error.code, 'CSRF_INVALID');
    const ok = await c.browser('POST', '/api/auth/register', { name: 'Ana Souza', phone: '11987654321' });
    assert.equal(ok.status, 202);
    // Cadastro novo e telefone repetido devolvem as mesmas chaves (não revela se o telefone existe).
    const dup = await client().browser('POST', '/api/auth/register', { name: 'Outra', phone: '11987654321' });
    assert.deepEqual(Object.keys(dup.json.data).sort(), Object.keys(ok.json.data).sort());
    assert.equal((await c.get('/api/me')).json.data.name, 'Ana Souza');
    const out = await c.browser('DELETE', '/api/auth/session');
    assert.equal(out.status, 204);
    assert.equal((await c.get('/api/me')).status, 401);
  });
});

test('backend: login da equipe, papéis e painel administrativo', async () => {
  await withApp({}, async ({ client }) => {
    const anon = client();
    assert.equal((await anon.get('/api/admin/staff')).status, 401);
    const wrong = await anon.post('/api/auth/session', { login: ADMIN.login, password: randomSecret() });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, 'INVALID_CREDENTIALS');

    const customer = client();
    await registerCustomer(customer, 'Ana Souza', '11987654321');
    assert.equal((await customer.get('/api/admin/staff')).status, 403);

    const admin = client();
    assert.equal((await loginAdmin(admin)).role, 'admin');
    const shop = (await admin.get('/api/shop')).json.data;
    const updated = await admin.patch('/api/admin/shop',
      { version: shop.version, address: 'Rua das Tesouras, 10', contactPhone: '(11) 3333-4444' });
    assert.equal(updated.status, 200);
    assert.equal((await anon.get('/api/shop')).json.data.address, 'Rua das Tesouras, 10');
    const stale = await admin.patch('/api/admin/shop', { version: shop.version, address: 'Outra' });
    assert.equal(stale.status, 409);

    const service = await admin.post('/api/admin/services', { name: 'Pigmentação', durationMinutes: 40, priceCents: 6000 });
    assert.equal(service.status, 201);
    assert.ok((await anon.get('/api/services')).json.data.some((s) => s.name === 'Pigmentação'));
    assert.equal((await admin.post('/api/admin/services', { name: 'X', durationMinutes: 'muito', priceCents: 1 })).status, 400);

    // Bloqueio ocupa a agenda do barbeiro: o horário sai da disponibilidade.
    const { staff, services } = await catalog(anon);
    const date = nextWorkday(4);
    const [first] = await slots(anon, staff[3].id, services[0].id, date);
    const end = new Date(Date.parse(first.startAt) + 60 * 60_000).toISOString();
    const block = await admin.post('/api/admin/blocks', { staffId: staff[3].id, startAt: first.startAt, endAt: end, reason: 'Almoço' });
    assert.equal(block.status, 201);
    assert.equal((await slots(anon, staff[3].id, services[0].id, date)).some((s) => s.startAt === first.startAt), false);

    // Barbeiro com credenciais dadas pelo admin vê só a própria agenda.
    const barberCredentials = { login: 'barbeiro1', password: randomSecret() };
    assert.equal((await admin.put(`/api/admin/staff/${staff[0].id}/credentials`, barberCredentials)).status, 204);
    const barber = client();
    assert.equal((await barber.post('/api/auth/session', barberCredentials)).status, 200);
    assert.equal((await barber.get(`/api/appointments?staffId=${staff[1].id}`)).status, 403);
    assert.equal((await barber.get(`/api/appointments?staffId=${staff[0].id}`)).status, 200);
    assert.equal((await barber.get('/api/admin/staff')).status, 403);
  });
});

test('backend: fronteira HTTP recusa JSON inválido, tipo errado, corpo grande e parâmetros inválidos', async () => {
  await withApp({}, async ({ client }) => {
    const c = client();
    assert.equal((await c.request('POST', '/api/auth/register', { raw: '{', headers: { 'content-type': 'application/json' } })).json.error.code, 'INVALID_JSON');
    assert.equal((await c.request('POST', '/api/auth/register', { raw: 'name=a', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
    const big = await c.post('/api/auth/register', { name: 'a'.repeat(70 * 1024), phone: '11987654321' });
    assert.equal(big.status, 413);
    const badUuid = await c.get('/api/availability?staffId=nao-uuid&serviceId=nao-uuid&date=2026-02-30');
    assert.equal(badUuid.status, 400);
    assert.equal((await c.get('/api/availability?staffId=a&staffId=b')).status, 400);
    assert.equal((await c.request('PUT', '/api/staff')).status, 405);
    const err = await c.get('/api/appointments/nao-existe');
    assert.equal(err.status, 401);
    assert.equal(JSON.stringify(err.json).includes('SELECT'), false);
  });
});

test('backend: prova de posse do telefone dá acesso ao cadastro existente; sem provedor responde 503', async () => {
  await withApp({}, async ({ client }) => {
    await registerCustomer(client(), 'Ana Souza', '11987654321');
    const res = await client().post('/api/auth/challenges', { phone: '11987654321' });
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, 'PROVIDER_UNAVAILABLE');
  });
  const sent = [];
  await withApp({ sendChallenge: async (message) => { sent.push(message); } }, async ({ client }) => {
    await registerCustomer(client(), 'Ana Souza', '11987654321');
    const other = client();
    const unknown = await other.post('/api/auth/challenges', { phone: '21900000000' });
    assert.equal(unknown.status, 202);
    assert.equal(sent.length, 0);
    const device = client();
    const challenge = await device.post('/api/auth/challenges', { phone: '(11) 98765-4321' });
    assert.equal(challenge.status, 202);
    assert.deepEqual(Object.keys(challenge.json.data).sort(), Object.keys(unknown.json.data).sort());
    assert.equal(sent.length, 1);
    const wrongCode = sent[0].code === '000000' ? '111111' : '000000';
    assert.equal((await device.post('/api/auth/challenges/verify', { challengeId: challenge.json.data.challengeId, code: wrongCode })).status, 401);
    const ok = await device.post('/api/auth/challenges/verify', { challengeId: challenge.json.data.challengeId, code: sent[0].code });
    assert.equal(ok.status, 200);
    assert.equal((await device.get('/api/me')).json.data.name, 'Ana Souza');
    assert.equal((await device.post('/api/auth/challenges/verify', { challengeId: challenge.json.data.challengeId, code: sent[0].code })).status, 401);
  });
});

test('backend: provedor de SMS do RPA só é ligado com configuração completa no ambiente', async () => {
  assert.equal(await loadSendChallenge({}), null);
  assert.equal(await loadSendChallenge({ TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32) }), null);
  const send = await loadSendChallenge({
    TWILIO_ACCOUNT_SID: 'AC' + '1'.repeat(32), TWILIO_AUTH_TOKEN: randomSecret() + randomSecret(), TWILIO_FROM: '+15005550006',
  });
  assert.equal(typeof send, 'function');
});

test('backend: reservas e sessão persistem após reiniciar o servidor', async () => {
  const tmp = await tempDir();
  try {
    let cookies;
    let bookingId;
    await withApp({ dataDir: tmp.dir }, async ({ client }) => {
      const ana = client();
      await registerCustomer(ana, 'Ana Souza', '11987654321');
      const { staff, services } = await catalog(ana);
      const [slot] = await slots(ana, staff[0].id, services[0].id, nextWorkday(2));
      bookingId = (await ana.post('/api/appointments', { staffId: staff[0].id, serviceId: services[0].id, startAt: slot.startAt })).json.data.id;
      cookies = ana.cookies;
    });
    await withApp({ dataDir: tmp.dir, admin: false }, async ({ client }) => {
      const ana = client();
      ana.cookies = cookies;
      const res = await ana.get(`/api/appointments/${bookingId}`);
      assert.equal(res.status, 200);
      assert.equal(res.json.data.status, 'confirmed');
    });
  } finally {
    await tmp.remove();
  }
});

test('backend: serve o frontend e bloqueia path traversal', async () => {
  await withApp({}, async ({ client }) => {
    const c = client();
    const home = await c.get('/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%5cpackage.json', '/.env']) {
      assert.equal((await c.get(path)).status, 404, path);
    }
  });
});
