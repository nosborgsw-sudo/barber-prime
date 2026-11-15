// Adaptador de demonstração (app-autonomo.html): mesmas regras do contrato, dados só no armazenamento local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts, memoryStorage, plain } from './apoio.mjs';

const ctx = loadScripts(['public/core.js', 'public/demo.js']);
const { BPDemo, BPCore: C } = ctx;
const NOW = new Date('2026-11-14T13:00:00.000Z'); // sábado, 10:00 em São Paulo
const MONDAY = '2026-11-16';

function adapter(storage) {
  return BPDemo.createDemoAdapter({ storage: storage || memoryStorage(), now: () => NOW, latency: 0 });
}

async function rejects(promise, code) {
  await assert.rejects(promise, (e) => e.code === code || assert.fail('esperado ' + code + ', veio ' + e.code));
}

async function catalog(api) {
  const [staff, services] = await Promise.all([api.staff(), api.services()]);
  return { staff, services, corte: services.find((s) => s.name === 'Corte masculino') };
}

test('demo: catálogo com quatro barbeiros, serviços com preço/duração e horário de funcionamento', async () => {
  const api = adapter();
  const { staff, services } = await catalog(api);
  assert.equal(staff.length, 4);
  assert.ok(services.every((s) => Number.isInteger(s.priceCents) && Number.isInteger(s.durationMinutes)));
  const shop = await api.shop();
  assert.equal(shop.timezone, 'America/Sao_Paulo');
  assert.deepEqual(plain(shop.openingHours.map((h) => h.weekday)), [1, 2, 3, 4, 5, 6]);
  assert.equal(shop.openingHours[0].startLocal, '09:00');
});

test('demo: cadastro, agendamento idempotente, conflito 409 e isolamento entre clientes', async () => {
  const storage = memoryStorage();
  const api = adapter(storage);
  const { staff, corte } = await catalog(api);
  const rafael = staff[0];
  await api.register({ name: 'Ana Souza', phone: '(11) 91234-5678' });
  assert.equal((await api.me()).role, 'customer');

  const day = await api.availability({ staffId: rafael.id, serviceId: corte.id, date: MONDAY });
  assert.equal(day.slots[0].startAt, C.zonedToInstant(MONDAY, '09:00', 'America/Sao_Paulo'));
  const body = { staffId: rafael.id, serviceId: corte.id, startAt: day.slots[0].startAt };
  const key = 'chave-idempotente-0001';
  const a = await api.createAppointment(body, key);
  assert.equal(a.status, 'confirmed');
  assert.equal(a.staffName, rafael.name);
  assert.equal(a.serviceName, 'Corte masculino');
  const replay = await api.createAppointment(body, key);
  assert.equal(replay.id, a.id, 'mesma chave devolve a mesma reserva');
  await rejects(api.createAppointment(Object.assign({}, body, { notes: 'outro' }), key), 'IDEMPOTENCY_CONFLICT');

  const after = await api.availability({ staffId: rafael.id, serviceId: corte.id, date: MONDAY });
  assert.ok(!after.slots.some((s) => C.overlaps(s.startAt, s.endAt, a.startAt, a.endAt)), 'horário ocupado some da lista');
  assert.ok(after.slots.some((s) => s.startAt === a.endAt), 'horário encostado no fim continua livre');

  // Outro cliente no mesmo navegador (sessão trocada) não vê nem cancela a reserva da Ana.
  await api.logout();
  await api.register({ name: 'Bruno Lima', phone: '(21) 99876-5432' });
  await rejects(api.createAppointment(body, 'chave-idempotente-0002'), 'SLOT_CONFLICT');
  assert.equal((await api.listAppointments({})).data.length, 0);
  await rejects(api.getAppointment(a.id), 'NOT_FOUND');
  await rejects(api.cancel(a.id, { version: 1 }), 'NOT_FOUND');
});

test('demo: telefone já cadastrado não concede sessão; acesso volta pelo código', async () => {
  const api = adapter();
  await api.register({ name: 'Ana Souza', phone: '11912345678' });
  await api.logout();
  await api.register({ name: 'Impostor', phone: '(11) 91234-5678' });
  assert.equal(await api.me(), null);
  const ch = await api.requestChallenge({ phone: '(11) 91234-5678' });
  await rejects(api.verifyChallenge({ challengeId: ch.challengeId, code: ch.demoCode === '000000' ? '111111' : '000000' }), 'INVALID_CHALLENGE');
  await api.verifyChallenge({ challengeId: ch.challengeId, code: ch.demoCode });
  assert.equal((await api.me()).name, 'Ana Souza');
  const unknown = await api.requestChallenge({ phone: '(31) 98888-7777' });
  assert.equal(unknown.demoCode, null, 'telefone sem cadastro não revela nada');
});

test('demo: reagendar mantém a reserva original quando o novo horário está ocupado; cancelar exige versão', async () => {
  const api = adapter();
  const { staff, corte } = await catalog(api);
  const [rafael, diego] = staff;
  await api.register({ name: 'Ana Souza', phone: '11912345678' });
  const at = (h) => C.zonedToInstant(MONDAY, h, 'America/Sao_Paulo');
  const first = await api.createAppointment({ staffId: rafael.id, serviceId: corte.id, startAt: at('09:00') }, 'chave-reagendar-00001');
  const second = await api.createAppointment({ staffId: rafael.id, serviceId: corte.id, startAt: at('10:00') }, 'chave-reagendar-00002');

  await rejects(api.reschedule(first.id, { staffId: rafael.id, startAt: at('10:15'), version: 1 }), 'SLOT_CONFLICT');
  const kept = await api.getAppointment(first.id);
  assert.equal(kept.startAt, first.startAt);
  assert.equal(kept.version, 1);

  const moved = await api.reschedule(first.id, { staffId: diego.id, startAt: at('10:00'), version: 1 });
  assert.equal(moved.staffId, diego.id);
  assert.equal(moved.version, 2);
  await rejects(api.reschedule(first.id, { staffId: diego.id, startAt: at('11:00'), version: 1 }), 'VERSION_CONFLICT');

  await rejects(api.cancel(second.id, { version: 99 }), 'VERSION_CONFLICT');
  const cancelled = await api.cancel(second.id, { version: second.version });
  assert.equal(cancelled.status, 'cancelled');
  const free = await api.availability({ staffId: rafael.id, serviceId: corte.id, date: MONDAY });
  assert.ok(free.slots.some((s) => s.startAt === at('10:00')), 'cancelamento libera o horário');
});

test('demo: painel admin — credencial definida no primeiro acesso, serviços, expediente e bloqueios', async () => {
  const storage = memoryStorage();
  const api = adapter(storage);
  await rejects(api.adminServices(), 'UNAUTHENTICATED');
  const secret = ['demo', 'admin', 'teste', 'local'].join('-');
  await api.login({ login: 'gerente', password: secret });
  assert.equal((await api.me()).role, 'admin');
  assert.ok(!storage.getItem(BPDemo.STORAGE_KEY).includes(secret), 'senha não fica em texto puro');
  await api.logout();
  await rejects(api.login({ login: 'gerente', password: secret + 'x' }), 'INVALID_CREDENTIALS');
  await api.login({ login: 'gerente', password: secret });

  const created = await api.createService({ name: 'Hidratação', durationMinutes: 30, priceCents: 3500 });
  await rejects(api.createService({ name: 'X', durationMinutes: 3, priceCents: -5 }), 'VALIDATION_ERROR');
  const off = await api.updateService(created.id, { active: false, version: created.version });
  assert.equal(off.active, false);
  assert.ok(!(await api.services()).some((s) => s.id === created.id), 'serviço inativo some do catálogo público');
  assert.ok((await api.adminServices()).some((s) => s.id === created.id));

  const staff = await api.adminStaff();
  const rafael = staff[0];
  await rejects(api.replaceWorkingHours(rafael.id, { periods: [{ weekday: 7, startLocal: '09:00', endLocal: '18:00' }] }), 'VALIDATION_ERROR');
  await rejects(api.replaceWorkingHours(rafael.id, { periods: [{ weekday: 1, startLocal: '18:00', endLocal: '09:00' }] }), 'VALIDATION_ERROR');
  await api.replaceWorkingHours(rafael.id, { periods: [{ weekday: 1, startLocal: '10:00', endLocal: '16:00' }] });
  const services = await api.services();
  const day = await api.availability({ staffId: rafael.id, serviceId: services[0].id, date: MONDAY });
  assert.equal(C.formatTime(day.slots[0].startAt, 'America/Sao_Paulo'), '10:00');
  assert.equal((await api.availability({ staffId: rafael.id, serviceId: services[0].id, date: '2026-11-17' })).slots.length, 0);

  const block = await api.createBlock({ staffId: rafael.id, startAt: C.zonedToInstant(MONDAY, '10:00', 'America/Sao_Paulo'), endAt: C.zonedToInstant(MONDAY, '12:00', 'America/Sao_Paulo'), reason: 'Curso' });
  const blocked = await api.availability({ staffId: rafael.id, serviceId: services[0].id, date: MONDAY });
  assert.equal(C.formatTime(blocked.slots[0].startAt, 'America/Sao_Paulo'), '12:00');
  await rejects(api.deleteBlock(block.id, 99), 'VERSION_CONFLICT');
  await api.deleteBlock(block.id, block.version);
  assert.equal((await api.blocks({})).length, 0);

  const shop = await api.shop();
  await rejects(api.updateShop({ version: shop.version, contactPhone: '123' }), 'VALIDATION_ERROR');
  const saved = await api.updateShop({ version: shop.version, name: 'Barber Prime Centro', address: 'Rua A, 10', contactPhone: '(11) 3456-7890' });
  assert.equal(saved.contactPhone, '+551134567890');
});

test('demo: dados persistem no armazenamento e o reset volta ao estado inicial', async () => {
  const storage = memoryStorage();
  const api = adapter(storage);
  await api.register({ name: 'Ana Souza', phone: '11912345678' });
  const again = adapter(storage);
  assert.equal((await again.me()).name, 'Ana Souza');
  again.resetDemo();
  assert.equal(await adapter(storage).me(), null);
});
