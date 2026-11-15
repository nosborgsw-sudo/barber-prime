// O adaptador do frontend (public/api.js) contra o servidor real (PGlite em memória): rotas, CSRF, cookies e regras.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, startApp, nextWorkday } from '../backend/apoio.mjs';
import { loadScripts } from './apoio.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

// fetch como o navegador numa página servida pelo próprio servidor: mesma origem, cookies e Origin nas mutações.
function browserFetch() {
  const jar = new Map();
  return async (url, init) => {
    const headers = Object.assign({}, init.headers);
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => k + '=' + v).join('; ');
    if (init.method !== 'GET') headers.origin = app.base;
    const res = await fetch(app.base + url, Object.assign({}, init, { headers }));
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (/Max-Age=0/i.test(line) || pair.slice(i + 1) === '') jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  };
}

const adapter = () => loadScripts(['public/core.js', 'public/api.js']).BPApi.createApiAdapter({ fetch: browserFetch() });

test('integração: servidor entrega index.html, recursos e app-autonomo.html', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/styles.css', 'text/css'], ['/core.js', 'javascript'], ['/api.js', 'javascript'], ['/app.js', 'javascript'], ['/app-autonomo.html', 'text/html']]) {
    const res = await fetch(app.base + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), new RegExp(type), path);
    await res.arrayBuffer();
  }
  const html = await (await fetch(app.base + '/')).text();
  assert.match(html, /data-mode="api"/);
});

test('integração: catálogo público com horário de funcionamento e cliente agenda, lista, reagenda e cancela', async () => {
  const api = adapter();
  const C = loadScripts(['public/core.js']).BPCore;
  const [shop, staff, services] = await Promise.all([api.shop(), api.staff(), api.services()]);
  assert.equal(staff.length, 4);
  assert.ok(services.length >= 5);
  assert.ok(Array.isArray(shop.openingHours), 'GET /api/shop traz openingHours');
  assert.equal(await api.me(), null);

  await api.register({ name: 'Ana Souza', phone: '(11) 91234-5678' });
  const me = await api.me();
  assert.equal(me.role, 'customer');
  const date = nextWorkday(2);
  const corte = services.find((s) => s.name === 'Corte masculino') || services[0];
  const day = await api.availability({ staffId: staff[0].id, serviceId: corte.id, date });
  assert.ok(day.slots.length > 2);
  const key = crypto.randomUUID();
  const body = { staffId: staff[0].id, serviceId: corte.id, startAt: day.slots[0].startAt };
  const a = await api.createAppointment(body, key);
  assert.equal(a.status, 'confirmed');
  assert.equal((await api.createAppointment(body, key)).id, a.id, 'reenvio com a mesma chave não duplica');

  const list = await api.listAppointments({});
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].staffName, staff[0].name);

  // Outro cliente não consegue o mesmo horário nem ver a reserva.
  const other = adapter();
  await other.register({ name: 'Bruno Lima', phone: '(21) 99876-5432' });
  await assert.rejects(other.createAppointment(body, crypto.randomUUID()), (e) => e.code === 'SLOT_CONFLICT' && e.status === 409);
  assert.equal((await other.listAppointments({})).data.length, 0);
  await assert.rejects(other.getAppointment(a.id), (e) => e.status === 404);

  const moved = await api.reschedule(a.id, { startAt: day.slots[day.slots.length - 1].startAt, version: a.version });
  assert.equal(moved.version, a.version + 1);
  await assert.rejects(api.cancel(a.id, { version: a.version }), (e) => e.code === 'VERSION_CONFLICT');
  const cancelled = await api.cancel(a.id, { version: moved.version });
  assert.equal(cancelled.status, 'cancelled');
  assert.match(C.formatTime(moved.startAt, shop.timezone), /^\d{2}:\d{2}$/);
  await api.logout();
  assert.equal(await api.me(), null);
});

test('integração: telefone já cadastrado não entrega sessão e o admin opera o painel', async () => {
  const intruder = adapter();
  await intruder.register({ name: 'Impostor', phone: '(11) 91234-5678' });
  assert.equal(await intruder.me(), null, 'cadastro repetido não autentica');
  await assert.rejects(intruder.adminServices(), (e) => e.status === 401);

  const admin = adapter();
  await assert.rejects(admin.login({ login: ADMIN.login, password: ADMIN.password + 'x' }), (e) => e.status === 401);
  await admin.login(ADMIN);
  assert.equal((await admin.me()).role, 'admin');
  const created = await admin.createService({ name: 'Hidratação', durationMinutes: 30, priceCents: 3500 });
  const updated = await admin.updateService(created.id, { version: created.version, active: false });
  assert.equal(updated.active, false);
  const staff = await admin.adminStaff();
  const hours = await admin.workingHours(staff[0].id);
  assert.ok(hours.length >= 6);
  const date = nextWorkday(3);
  const C = loadScripts(['public/core.js']).BPCore;
  const block = await admin.createBlock({ staffId: staff[0].id, startAt: C.zonedToInstant(date, '13:00', 'America/Sao_Paulo'), endAt: C.zonedToInstant(date, '14:00', 'America/Sao_Paulo'), reason: 'Almoço' });
  assert.ok((await admin.blocks({ from: date, to: date })).some((b) => b.id === block.id));
  await admin.deleteBlock(block.id, block.version);
  const agenda = await admin.listAppointments({ from: date, to: date });
  assert.ok(Array.isArray(agenda.data));
  const shop = await admin.shop();
  const saved = await admin.updateShop({ version: shop.version, name: shop.name, address: 'Rua das Tesouras, 100', contactPhone: '(11) 3456-7890' });
  assert.equal(saved.address, 'Rua das Tesouras, 100');
});
