// QA independente: casos-limite de cadastro, reservas e escopo de acesso sobre o servidor real (PGlite), sem dublês.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { catalog, loginAdmin, nextWorkday, randomSecret, registerCustomer, slots, startApp } from './apoio.mjs';

const key = () => randomBytes(18).toString('base64url');

async function withApp(run) {
  const app = await startApp();
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

// Data local (São Paulo) deslocada em dias, ignorando dia útil.
function localDate(offsetDays) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

function nextSunday() {
  for (let i = 2; ; i++) {
    const d = localDate(i);
    if (new Date(`${d}T12:00:00Z`).getUTCDay() === 0) return d;
  }
}

const book = (c, staffId, serviceId, startAt) => c.post('/api/appointments', { staffId, serviceId, startAt });

test('qa: telefone duplicado em outros formatos não cria segundo cliente nem entrega sessão', async () => {
  await withApp(async ({ client, pool }) => {
    const dono = client();
    await registerCustomer(dono, 'Carlos Dono', '(11) 98123-4567');
    assert.equal((await dono.get('/api/me')).status, 200);

    for (const formato of ['11981234567', '+55 11 98123-4567', '011 98123 4567', '55 (11) 981234567']) {
      const intruso = client();
      const res = await intruso.post('/api/auth/register', { name: 'Intruso', phone: formato });
      // Formato aceito ou recusado, nunca vira sessão nem cadastro novo.
      assert.ok([202, 400].includes(res.status), `${formato}: ${res.status}`);
      assert.equal((await intruso.get('/api/me')).status, 401, formato);
      assert.deepEqual((await intruso.get('/api/appointments')).status, 401, formato);
    }
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM customers');
    assert.equal(rows[0].n, 1);
  });
});

test('qa: resposta do cadastro não revela se o telefone já existia (mesmo status, corpo e cookies)', async () => {
  await withApp(async ({ client }) => {
    await registerCustomer(client(), 'Primeiro', '31987650001');
    const novo = await client().post('/api/auth/register', { name: 'Outro', phone: '31987650002' });
    const repetido = await client().post('/api/auth/register', { name: 'Outro', phone: '31987650001' });
    assert.equal(novo.status, repetido.status);
    assert.deepEqual(Object.keys(novo.json.data).sort(), Object.keys(repetido.json.data).sort());
    assert.equal(novo.json.data.message, repetido.json.data.message);
    const cookieNames = (r) => r.headers.getSetCookie().map((l) => l.split('=')[0]).sort();
    assert.deepEqual(cookieNames(novo), cookieNames(repetido));
  });
});

test('qa: cadastro exige nome e telefone válidos, recusa campos extras e limita tentativas em série', async () => {
  await withApp(async ({ client }) => {
    const c = client();
    for (const body of [
      { name: 'Sem Telefone' },
      { phone: '11987654321' },
      { name: '', phone: '11987654321' },
      { name: 'Sem DDD', phone: '987654321' },
      { name: 'Extra', phone: '11987654321', email: 'a@b.c' },
    ]) {
      const res = await c.post('/api/auth/register', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await c.get('/api/me')).status, 401);
    // Varredura de telefones pelo mesmo IP esbarra no limite (429) em poucas tentativas.
    let limited = false;
    for (let i = 0; i < 30 && !limited; i++) {
      limited = (await c.post('/api/auth/register', { name: 'Robo', phone: `119876${String(i).padStart(5, '0')}` })).status === 429;
    }
    assert.ok(limited, 'sem limite de tentativas de cadastro');
  });
});

test('qa: reserva recusada sem sessão, no passado, fora do expediente, no domingo e em profissional inexistente', async () => {
  await withApp(async ({ client }) => {
    const anon = client();
    const ana = client();
    await registerCustomer(ana, 'Ana QA', '11987650010');
    const { staff, services } = await catalog(ana);
    const [slot] = await slots(ana, staff[0].id, services[0].id, nextWorkday(2));

    assert.equal((await book(anon, staff[0].id, services[0].id, slot.startAt)).status, 401);

    const past = await book(ana, staff[0].id, services[0].id, `${localDate(-1)}T10:00:00-03:00`);
    assert.ok(past.status >= 400 && past.status < 500, `passado: ${past.status}`);

    const madrugada = await book(ana, staff[0].id, services[0].id, `${nextWorkday(2)}T03:00:00-03:00`);
    assert.ok(madrugada.status >= 400 && madrugada.status < 500, `madrugada: ${madrugada.status}`);

    const domingo = nextSunday();
    assert.deepEqual(await slots(ana, staff[0].id, services[0].id, domingo), []);
    const fechado = await book(ana, staff[0].id, services[0].id, `${domingo}T10:00:00-03:00`);
    assert.ok(fechado.status >= 400 && fechado.status < 500, `domingo: ${fechado.status}`);

    const fantasma = await book(ana, '00000000-0000-4000-8000-000000000000', services[0].id, slot.startAt);
    assert.ok([400, 404, 409].includes(fantasma.status), `profissional inexistente: ${fantasma.status}`);

    // Cliente não escolhe outro dono para a reserva.
    const outroDono = await ana.post('/api/appointments',
      { customerId: '00000000-0000-4000-8000-000000000000', staffId: staff[0].id, serviceId: services[0].id, startAt: slot.startAt });
    assert.equal(outroDono.status, 400);

    assert.deepEqual((await ana.get('/api/appointments')).json.data, []);
  });
});

test('qa: calendário por profissional — sobreposição parcial é conflito, outro barbeiro no mesmo horário é livre', async () => {
  await withApp(async ({ client }) => {
    const ana = client();
    const bia = client();
    await registerCustomer(ana, 'Ana QA', '11987650020');
    await registerCustomer(bia, 'Bia QA', '11987650021');
    const { staff, services } = await catalog(ana);
    const longo = services.find((s) => s.durationMinutes > 15) ?? services[0];
    assert.ok(longo.durationMinutes > 15, 'precisa de serviço com mais de 15 min');
    const date = nextWorkday(3);
    const [first] = await slots(ana, staff[0].id, longo.id, date);

    assert.equal((await book(ana, staff[0].id, longo.id, first.startAt)).status, 201);
    const quinzeDepois = new Date(Date.parse(first.startAt) + 15 * 60_000).toISOString();
    const parcial = await book(bia, staff[0].id, longo.id, quinzeDepois);
    assert.equal(parcial.status, 409);
    assert.equal(parcial.json.error.code, 'SLOT_CONFLICT');
    // Slots que se sobrepõem ao ocupado somem da disponibilidade daquele barbeiro.
    const restantes = await slots(bia, staff[0].id, longo.id, date);
    assert.ok(restantes.every((s) => Date.parse(s.endAt) <= Date.parse(first.startAt) || Date.parse(s.startAt) >= Date.parse(first.endAt)));

    const outro = await book(bia, staff[1].id, longo.id, first.startAt);
    assert.equal(outro.status, 201);
  });
});

test('qa: horário bloqueado pelo admin some e é recusado; cancelado volta a ficar livre para outro cliente', async () => {
  await withApp(async ({ client }) => {
    const admin = client();
    await loginAdmin(admin);
    const ana = client();
    const bia = client();
    await registerCustomer(ana, 'Ana QA', '11987650030');
    await registerCustomer(bia, 'Bia QA', '11987650031');
    const { staff, services } = await catalog(ana);
    const date = nextWorkday(4);
    const free = await slots(ana, staff[2].id, services[0].id, date);
    const alvo = free[0];

    const block = await admin.post('/api/admin/blocks', { staffId: staff[2].id, startAt: alvo.startAt, endAt: alvo.endAt, reason: 'QA' });
    assert.equal(block.status, 201);
    assert.equal((await slots(ana, staff[2].id, services[0].id, date)).some((s) => s.startAt === alvo.startAt), false);
    assert.equal((await book(ana, staff[2].id, services[0].id, alvo.startAt)).status, 409);

    const depois = free.find((s) => Date.parse(s.startAt) >= Date.parse(alvo.endAt) + 60 * 60_000);
    const criada = await book(ana, staff[2].id, services[0].id, depois.startAt);
    assert.equal(criada.status, 201);
    const cancel = await ana.post(`/api/appointments/${criada.json.data.id}/cancel`, { version: criada.json.data.version });
    assert.equal(cancel.status, 200);
    assert.ok((await slots(bia, staff[2].id, services[0].id, date)).some((s) => s.startAt === depois.startAt));
    assert.equal((await book(bia, staff[2].id, services[0].id, depois.startAt)).status, 201);
  });
});

test('qa: reagendar para horário de outro cliente dá 409 e mantém a reserva original intacta', async () => {
  await withApp(async ({ client }) => {
    const ana = client();
    const bia = client();
    await registerCustomer(ana, 'Ana QA', '11987650040');
    await registerCustomer(bia, 'Bia QA', '11987650041');
    const { staff, services } = await catalog(ana);
    const date = nextWorkday(2);
    const free = await slots(ana, staff[3].id, services[0].id, date);
    const segundo = free.find((s) => Date.parse(s.startAt) >= Date.parse(free[0].endAt));
    const minha = (await book(ana, staff[3].id, services[0].id, free[0].startAt)).json.data;
    assert.equal((await book(bia, staff[3].id, services[0].id, segundo.startAt)).status, 201);

    const res = await ana.patch(`/api/appointments/${minha.id}/reschedule`, { startAt: segundo.startAt, version: minha.version });
    assert.equal(res.status, 409);
    const atual = (await ana.get(`/api/appointments/${minha.id}`)).json.data;
    assert.equal(atual.startAt, minha.startAt);
    assert.equal(atual.status, 'confirmed');
    assert.equal(atual.version, minha.version);
  });
});

test('qa: escopo — cliente não vê agenda nem muda status; barbeiro só enxerga a própria agenda e sem telefone', async () => {
  await withApp(async ({ client }) => {
    const admin = client();
    await loginAdmin(admin);
    const ana = client();
    await registerCustomer(ana, 'Ana QA', '11987650050');
    const { staff, services } = await catalog(ana);
    const date = nextWorkday(2);
    const [s0] = await slots(ana, staff[0].id, services[0].id, date);
    const daAna = (await ana.post('/api/appointments', { staffId: staff[1].id, serviceId: services[0].id, startAt: s0.startAt },
      { headers: { 'idempotency-key': key() } })).json.data;
    assert.equal('customerPhone' in daAna, false);

    assert.equal((await ana.get(`/api/appointments?staffId=${staff[1].id}`)).status, 403);
    assert.equal((await ana.patch(`/api/appointments/${daAna.id}/status`, { status: 'completed', version: daAna.version })).status, 403);
    assert.equal((await ana.get('/api/admin/working-hours')).status, 403);
    assert.equal((await ana.patch('/api/admin/shop', { version: 1, name: 'Tomada' })).status, 403);

    const cred = { login: 'barbeiro-qa', password: randomSecret() };
    assert.equal((await admin.put(`/api/admin/staff/${staff[0].id}/credentials`, cred)).status, 204);
    const barbeiro = client();
    assert.equal((await barbeiro.post('/api/auth/session', cred)).status, 200);
    // Reserva de outro barbeiro: não aparece, não abre e não muda de status.
    assert.equal((await barbeiro.get(`/api/appointments/${daAna.id}`)).status, 404);
    assert.equal((await barbeiro.patch(`/api/appointments/${daAna.id}/status`, { status: 'completed', version: daAna.version })).status, 404);
    const agenda = await barbeiro.get(`/api/appointments?from=${date}&to=${date}`);
    assert.equal(agenda.status, 200);
    assert.equal(agenda.json.data.some((a) => a.id === daAna.id), false);

    const agendaAdmin = (await admin.get(`/api/appointments?from=${date}&to=${date}&staffId=${staff[1].id}`)).json.data;
    assert.ok(agendaAdmin.some((a) => a.id === daAna.id));
  });
});

test('qa: nome, endereço e contato da barbearia são configuráveis pelo admin e aparecem no catálogo público', async () => {
  await withApp(async ({ client }) => {
    const admin = client();
    await loginAdmin(admin);
    const anon = client();
    const shop = (await anon.get('/api/shop')).json.data;
    assert.ok(shop.name);
    assert.ok(Array.isArray(shop.openingHours) || typeof shop.openingHours === 'object', 'horário de funcionamento');
    const res = await admin.patch('/api/admin/shop',
      { version: shop.version, name: 'Prime QA', address: 'Av. Central, 500', contactPhone: '(21) 3222-1100' });
    assert.equal(res.status, 200);
    const publico = (await anon.get('/api/shop')).json.data;
    assert.equal(publico.name, 'Prime QA');
    assert.equal(publico.address, 'Av. Central, 500');
    assert.match(JSON.stringify(publico), /3222/);
  });
});
