// LGPD art. 18: o cliente exporta e exclui os PRÓPRIOS dados; ninguém mais usa essas rotas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog, loginAdmin, nextWorkday, registerCustomer, slots, startApp } from './apoio.mjs';

async function withApp(run) {
  const app = await startApp();
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

test('lgpd: exportação traz só os dados do cliente da sessão; sem sessão 401, equipe 403', async () => {
  await withApp(async ({ client }) => {
    const ana = client();
    const bruno = client();
    await registerCustomer(ana, 'Ana Titular', '11987651001');
    await registerCustomer(bruno, 'Bruno Outro', '11987651002');
    const { staff, services } = await catalog(ana);
    const [slot] = await slots(ana, staff[0].id, services[0].id, nextWorkday(2));
    const booked = await ana.post('/api/appointments', { staffId: staff[0].id, serviceId: services[0].id, startAt: slot.startAt });
    assert.equal(booked.status, 201);

    const res = await ana.get('/api/me/export');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment/);
    assert.equal(res.json.data.customer.name, 'Ana Titular');
    assert.equal(res.json.data.customer.phone, '+5511987651001');
    assert.deepEqual(res.json.data.appointments.map((a) => a.id), [booked.json.data.id]);
    assert.equal(res.json.data.appointments[0].staffName, staff[0].name);
    assert.equal(JSON.stringify(res.json).includes('Bruno'), false);
    assert.equal(JSON.stringify(res.json).includes('11987651002'), false);

    assert.equal((await client().get('/api/me/export')).status, 401);
    const admin = client();
    await loginAdmin(admin);
    assert.equal((await admin.get('/api/me/export')).status, 403);
    assert.equal((await admin.delete('/api/me')).status, 403);
  });
});

test('lgpd: exclusão apaga cadastro, reservas e sessão do titular, libera o horário e não toca em terceiros', async () => {
  await withApp(async ({ client, pool }) => {
    const ana = client();
    const bruno = client();
    await registerCustomer(ana, 'Ana Exclui', '11987651003');
    await registerCustomer(bruno, 'Bruno Fica', '11987651004');
    const { staff, services } = await catalog(ana);
    const date = nextWorkday(2);
    const [slotAna, slotBruno] = await slots(ana, staff[1].id, services[0].id, date);
    const reservaAna = await ana.post('/api/appointments', { staffId: staff[1].id, serviceId: services[0].id, startAt: slotAna.startAt });
    assert.equal(reservaAna.status, 201);
    const bSlot = (await slots(bruno, staff[2].id, services[0].id, date))[0] ?? slotBruno;
    const reservaBruno = await bruno.post('/api/appointments', { staffId: staff[2].id, serviceId: services[0].id, startAt: bSlot.startAt });
    assert.equal(reservaBruno.status, 201);

    // Navegador com token CSRF errado é recusado e nada é apagado.
    const forjado = await ana.request('DELETE', '/api/me', { headers: { origin: ana.base, 'x-csrf-token': 'token-invalido' } });
    assert.equal(forjado.status, 403);
    assert.equal((await ana.get('/api/me')).status, 200);
    assert.equal((await client().delete('/api/me')).status, 401);

    const apagado = await ana.browser('DELETE', '/api/me');
    assert.equal(apagado.status, 204);
    assert.equal((await ana.get('/api/me')).status, 401, 'sessão do titular deixa de valer');
    const restantes = await pool.query(
      "SELECT (SELECT count(*)::int FROM customers WHERE phone = '+5511987651003') AS c, (SELECT count(*)::int FROM appointments WHERE id = $1) AS a",
      [reservaAna.json.data.id]);
    assert.deepEqual(restantes.rows[0], { c: 0, a: 0 });
    const audit = await pool.query("SELECT actor_id, entity_id FROM audit_events WHERE action = 'customer.deleted'");
    assert.equal(audit.rows.length, 1);

    // Horário liberado e terceiro intacto.
    const livres = await slots(bruno, staff[1].id, services[0].id, date);
    assert.ok(livres.some((s) => s.startAt === slotAna.startAt), 'horário da reserva excluída não foi liberado');
    assert.equal((await bruno.get(`/api/appointments/${reservaBruno.json.data.id}`)).status, 200);
    assert.equal((await bruno.get('/api/me')).json.data.name, 'Bruno Fica');

    // O telefone pode ser cadastrado de novo, como cliente novo.
    const novo = client();
    await registerCustomer(novo, 'Ana Nova', '11987651003');
    assert.equal((await novo.get('/api/me')).json.data.name, 'Ana Nova');
    assert.deepEqual((await novo.get('/api/me/export')).json.data.appointments, []);
  });
});
