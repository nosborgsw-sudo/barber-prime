// Testes da camada de dados contra PostgreSQL 16 real (Docker). Nada é simulado:
// constraints, triggers, concorrência e reinício rodam no banco de verdade.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import * as db from '../../db/index.mjs';
import { startPostgres } from './apoio/postgres-docker.mjs';

const [B1, B2, B3] = db.SEED_BARBERS.map((b) => b.id);
const [CORTE, BARBA] = db.SEED_SERVICES.map((s) => s.id);
const sha = (s) => createHash('sha256').update(s).digest();

// Próxima segunda-feira (expediente do seed) com pelo menos 3 dias de antecedência, em São Paulo (UTC-3).
function nextMonday(weeksAhead = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 3);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * weeksAhead);
  return d.toISOString().slice(0, 10);
}
const at = (date, hhmm) => `${date}T${hhmm}:00-03:00`;
const DAY = nextMonday();

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `esperado ${code}, veio ${err.code}: ${err.message}`);
    return true;
  });
}

describe('dados: telefone (sem banco)', () => {
  test('normaliza formatos brasileiros para E.164', () => {
    for (const input of ['(11) 98765-4321', '11987654321', '+55 11 98765-4321', '5511987654321', '011 98765 4321']) {
      assert.equal(db.normalizePhoneBR(input), '+5511987654321', input);
    }
    assert.equal(db.normalizePhoneBR('(21) 3456-7890'), '+552134567890');
  });
  test('recusa sem DDD, DDD inexistente, celular sem 9 e texto estranho', () => {
    for (const input of ['98765-4321', '(20) 98765-4321', '(11) 88765-4321', '11 9876x4321', '', null, 11987654321, '+1 415 555 0100']) {
      assert.equal(db.normalizePhoneBR(input), null, String(input));
    }
  });
});

describe('dados: PostgreSQL real', () => {
  let pg;
  let motivo;
  const pool = () => pg.pool;
  const customers = {};

  before(async () => {
    const started = await startPostgres();
    if (started.motivo) {
      if (process.env.DADOS_EXIGIR_PG === '1') throw new Error(started.motivo);
      motivo = started.motivo;
      return;
    }
    pg = started;
  });
  after(async () => { await pg?.stop(); });

  const t = (name, fn) => test(name, async (ctx) => {
    if (motivo) return ctx.skip(motivo);
    await fn(ctx);
  });

  t('migração aplica, é idempotente, reverte e reaplica', async () => {
    const coluna = async () => (await pool().query(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'challenges' AND column_name = 'requester_hash'")).rows[0].n;
    assert.deepEqual(await db.migrate(pool()), [1, 2]);
    assert.deepEqual(await db.migrate(pool()), []);
    assert.equal(await coluna(), 1);
    assert.deepEqual(await db.rollback(pool()), [2]);
    assert.equal(await coluna(), 0, '002 reverte só a coluna');
    assert.deepEqual(await db.rollback(pool()), [1]);
    const { rows } = await pool().query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'");
    assert.equal(rows[0].n, 0);
    assert.deepEqual(await db.migrate(pool()), [1, 2]);
  });

  t('migração alterada depois de aplicada é recusada (checksum)', async () => {
    await pool().query("UPDATE schema_migrations SET checksum = 'x' WHERE version = 1");
    await assert.rejects(db.migrate(pool()), /alterada/);
    const { rows } = await pool().query('SELECT count(*)::int AS n FROM shops');
    assert.equal(rows[0].n, 0);
    // restaura o checksum real reaplicando do zero
    await pool().query('DROP TABLE schema_migrations');
    await pool().query((await import('node:fs')).readFileSync(new URL('../../migrations/001_esquema_inicial.down.sql', import.meta.url), 'utf8'));
    assert.deepEqual(await db.migrate(pool()), [1, 2]);
  });

  t('seed cria barbearia, 4 barbeiros, serviços e expediente, e é idempotente', async () => {
    await db.seed(pool());
    await db.seed(pool());
    const barbers = await db.listBarbers(pool());
    assert.equal(barbers.length, 4);
    assert.deepEqual(barbers.map((b) => b.name), db.SEED_BARBERS.map((b) => b.name));
    const services = await db.listServices(pool());
    assert.equal(services.length, 5);
    assert.equal(services[0].priceCents, 6000);
    assert.equal(services[0].durationMinutes, 45);
    assert.equal((await db.getWorkingHours(pool(), B1)).length, 6);
    const shop = await db.getShop(pool());
    assert.equal(shop.name, 'Barber Prime');
    assert.equal(shop.timezone, 'America/Sao_Paulo');
    const secrets = await pool().query('SELECT count(*)::int AS n FROM staff WHERE password_hash IS NOT NULL');
    assert.equal(secrets.rows[0].n, 0, 'seed não grava senha');
    const people = await pool().query('SELECT (SELECT count(*) FROM customers)::int AS c, (SELECT count(*) FROM sessions)::int AS s');
    assert.deepEqual(people.rows[0], { c: 0, s: 0 });
  });

  t('cadastro de cliente não duplica telefone em formatos diferentes e não revela o existente', async () => {
    const a = await db.registerCustomer(pool(), { name: 'Cliente Alfa', phone: '(11) 98765-4321' });
    assert.equal(a.created, true);
    customers.a = a.customer.id;
    const dup = await db.registerCustomer(pool(), { name: 'Outro Nome', phone: '+55 11 98765-4321' });
    assert.deepEqual(dup, { created: false, customer: null });
    const b = await db.registerCustomer(pool(), { name: 'Cliente Beta', phone: '21 99876-5432' });
    customers.b = b.customer.id;
    const c = await db.registerCustomer(pool(), { name: 'Cliente Gama', phone: '31 99777-1111' });
    customers.c = c.customer.id;
    const { rows } = await pool().query('SELECT count(*)::int AS n FROM customers');
    assert.equal(rows[0].n, 3);
    await rejectsCode(db.registerCustomer(pool(), { name: 'X', phone: '11987654321' }), 'VALIDATION_ERROR');
    await rejectsCode(db.registerCustomer(pool(), { name: 'Ok Nome', phone: '123' }), 'VALIDATION_ERROR');
    await rejectsCode(db.registerCustomer(pool(), { name: 'Ok Nome', phone: '11987654322', admin: true }), 'VALIDATION_ERROR');
  });

  t('banco recusa telefone não normalizado mesmo sem passar pela aplicação', async () => {
    await assert.rejects(pool().query("INSERT INTO customers (name, phone) VALUES ('Direto', '(11) 91234-5678')"), (e) => e.code === '23514');
  });

  t('texto com SQL é guardado como texto (consultas parametrizadas)', async () => {
    const name = "Robert'); DROP TABLE customers;--";
    const r = await db.registerCustomer(pool(), { name, phone: '41 99111-2222' });
    assert.equal((await db.getCustomer(pool(), r.customer.id)).name, name);
    assert.equal((await pool().query('SELECT count(*)::int AS n FROM customers')).rows[0].n, 4);
  });

  t('reserva copia preço e duração; mudar o serviço depois não altera a reserva', async () => {
    const { appointment } = await db.createAppointment(pool(), { customerId: customers.a, staffId: B1, serviceId: CORTE, startAt: at(DAY, '09:00') });
    assert.equal(appointment.priceCents, 6000);
    assert.equal(appointment.durationMinutes, 45);
    assert.equal(appointment.endAt, new Date(at(DAY, '09:45')).toISOString());
    assert.equal(appointment.status, 'confirmed');
    const svc = (await db.listServices(pool())).find((s) => s.id === CORTE);
    await db.updateService(pool(), CORTE, { version: svc.version, priceCents: 7000, durationMinutes: 50 });
    const again = await db.getAppointment(pool(), appointment.id, { role: 'customer', customerId: customers.a });
    assert.equal(again.priceCents, 6000);
    assert.equal(again.durationMinutes, 45);
    await db.updateService(pool(), CORTE, { version: svc.version + 1, priceCents: 6000, durationMinutes: 45 });
  });

  t('10 reservas simultâneas no mesmo horário e barbeiro: só 1 sucesso', async () => {
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const r = await db.registerCustomer(pool(), { name: `Concorrente ${i}`, phone: `11 9${String(70000000 + i).padStart(8, '0')}` });
      ids.push(r.customer.id);
    }
    const results = await Promise.allSettled(ids.map((customerId) =>
      db.createAppointment(pool(), { customerId, staffId: B2, serviceId: CORTE, startAt: at(DAY, '14:00') })));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter((r) => r.status === 'rejected' && r.reason.code === 'SLOT_CONFLICT');
    assert.equal(ok.length, 1);
    assert.equal(conflicts.length, 9);
    assert.equal(conflicts[0].reason.status, 409);
    const { rows } = await pool().query(
      "SELECT count(*)::int AS n FROM appointments WHERE staff_id = $1 AND status = 'confirmed' AND start_at = $2", [B2, at(DAY, '14:00')]);
    assert.equal(rows[0].n, 1);
  });

  t('sobreposição parcial conflita; encostar no fim e outro barbeiro no mesmo horário não conflitam', async () => {
    await rejectsCode(db.createAppointment(pool(), { customerId: customers.b, staffId: B1, serviceId: BARBA, startAt: at(DAY, '09:30') }), 'SLOT_CONFLICT');
    const adjacent = await db.createAppointment(pool(), { customerId: customers.b, staffId: B1, serviceId: BARBA, startAt: at(DAY, '09:45') });
    assert.equal(adjacent.appointment.startAt, new Date(at(DAY, '09:45')).toISOString());
    const other = await db.createAppointment(pool(), { customerId: customers.c, staffId: B3, serviceId: CORTE, startAt: at(DAY, '09:00') });
    assert.equal(other.appointment.staffId, B3);
  });

  t('regras de horário: passado, fora do expediente e domingo são recusados', async () => {
    const now = new Date(at(DAY, '12:00'));
    await rejectsCode(db.createAppointment(pool(), { customerId: customers.a, staffId: B1, serviceId: CORTE, startAt: at(DAY, '11:00') }, { now }), 'BUSINESS_RULE');
    await rejectsCode(db.createAppointment(pool(), { customerId: customers.a, staffId: B1, serviceId: CORTE, startAt: at(DAY, '08:30') }), 'BUSINESS_RULE');
    await rejectsCode(db.createAppointment(pool(), { customerId: customers.a, staffId: B1, serviceId: CORTE, startAt: at(DAY, '18:30') }), 'BUSINESS_RULE');
    const sunday = new Date(`${DAY}T12:00:00Z`);
    sunday.setUTCDate(sunday.getUTCDate() - 1);
    await rejectsCode(db.createAppointment(pool(), { customerId: customers.a, staffId: B1, serviceId: CORTE, startAt: at(sunday.toISOString().slice(0, 10), '10:00') }), 'BUSINESS_RULE');
    const last = await db.createAppointment(pool(), { customerId: customers.a, staffId: B1, serviceId: CORTE, startAt: at(DAY, '18:15') });
    assert.equal(last.appointment.endAt, new Date(at(DAY, '19:00')).toISOString());
  });

  t('bloqueio conflita com reserva em qualquer ordem e nada é cancelado em silêncio', async () => {
    await rejectsCode(db.createBlock(pool(), { staffId: B1, startAt: at(DAY, '09:15'), endAt: at(DAY, '10:00') }), 'SLOT_CONFLICT');
    const block = await db.createBlock(pool(), { staffId: B1, startAt: at(DAY, '12:00'), endAt: at(DAY, '13:00'), reason: 'Almoço' });
    await rejectsCode(db.createAppointment(pool(), { customerId: customers.c, staffId: B1, serviceId: CORTE, startAt: at(DAY, '11:30') }), 'SLOT_CONFLICT');
    const from = at(DAY, '00:00');
    const to = at(nextMonday(1), '00:00');
    assert.equal((await db.listBlocks(pool(), { from, to, staffId: B1 })).length, 1);
    await db.deleteBlock(pool(), block.id);
    const ok = await db.createAppointment(pool(), { customerId: customers.c, staffId: B1, serviceId: CORTE, startAt: at(DAY, '11:30') });
    assert.equal(ok.appointment.status, 'confirmed');
    await rejectsCode(db.deleteBlock(pool(), block.id), 'NOT_FOUND');
  });

  t('disponibilidade exclui horários ocupados e respeita o expediente', async () => {
    const av = await db.listAvailability(pool(), { staffId: B1, serviceId: CORTE, date: DAY, stepMinutes: 15 });
    const starts = av.slots.map((s) => s.startAt);
    assert.equal(av.timezone, 'America/Sao_Paulo');
    assert.ok(!starts.includes(new Date(at(DAY, '09:00')).toISOString()), '09:00 ocupado');
    assert.ok(!starts.includes(new Date(at(DAY, '09:30')).toISOString()), '09:30 sobrepõe 09:45');
    assert.ok(starts.includes(new Date(at(DAY, '10:15')).toISOString()), '10:15 livre');
    assert.ok(!starts.includes(new Date(at(DAY, '18:30')).toISOString()), '18:30 terminaria após 19:00');
    assert.equal(starts[starts.length - 1] < new Date(at(DAY, '18:16')).toISOString(), true);
    const sunday = new Date(`${DAY}T12:00:00Z`);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    assert.deepEqual((await db.listAvailability(pool(), { staffId: B1, serviceId: CORTE, date: sunday.toISOString().slice(0, 10) })).slots, []);
    await rejectsCode(db.listAvailability(pool(), { staffId: randomUUID(), serviceId: CORTE, date: DAY }), 'NOT_FOUND');
    await rejectsCode(db.listAvailability(pool(), { staffId: B1, serviceId: CORTE, date: '2026-02-30' }), 'VALIDATION_ERROR');
  });

  t('isolamento: cliente não lê, cancela nem reagenda reserva de outro; barbeiro só a própria agenda', async () => {
    const mine = (await db.listAppointmentsForCustomer(pool(), customers.a))[0];
    const asB = { role: 'customer', customerId: customers.b };
    assert.equal(await db.getAppointment(pool(), mine.id, asB), null);
    await rejectsCode(db.cancelAppointment(pool(), mine.id, asB), 'NOT_FOUND');
    await rejectsCode(db.rescheduleAppointment(pool(), mine.id, asB, { version: mine.version, startAt: at(DAY, '15:00') }), 'NOT_FOUND');
    assert.equal(await db.getAppointment(pool(), mine.id, { role: 'barber', staffId: B3 }), null);
    assert.ok(await db.getAppointment(pool(), mine.id, { role: 'barber', staffId: mine.staffId }));
    const agenda = await db.listAgenda(pool(), { role: 'barber', staffId: B3 }, { from: at(DAY, '00:00'), to: at(DAY, '23:59') });
    assert.ok(agenda.length > 0 && agenda.every((a) => a.staffId === B3));
    assert.ok(agenda.every((a) => !('customerPhone' in a)), 'barbeiro não recebe telefone');
    const all = await db.listAgenda(pool(), { role: 'admin' }, { from: at(DAY, '00:00'), to: at(DAY, '23:59') });
    assert.ok(all.some((a) => a.staffId === B1) && all.some((a) => a.staffId === B3));
    await rejectsCode(db.getAppointment(pool(), mine.id, undefined), 'VALIDATION_ERROR');
    await rejectsCode(db.getAppointment(pool(), "1' OR '1'='1", asB), 'VALIDATION_ERROR');
    await rejectsCode(db.listAgenda(pool(), { role: 'admin' }, { from: at(DAY, '00:00'), to: at(nextMonday(5), '00:00') }), 'VALIDATION_ERROR');
  });

  t('reagendar para horário ocupado mantém a reserva original; reagendar livre libera o antigo', async () => {
    const mine = (await db.listAppointmentsForCustomer(pool(), customers.a)).find((a) => a.startAt === new Date(at(DAY, '09:00')).toISOString());
    const asA = { role: 'customer', customerId: customers.a };
    await rejectsCode(db.rescheduleAppointment(pool(), mine.id, asA, { version: mine.version, startAt: at(DAY, '11:30') }), 'SLOT_CONFLICT');
    const kept = await db.getAppointment(pool(), mine.id, asA);
    assert.equal(kept.startAt, mine.startAt);
    assert.equal(kept.version, mine.version);
    await rejectsCode(db.rescheduleAppointment(pool(), mine.id, asA, { version: mine.version + 5, startAt: at(DAY, '15:00') }), 'VERSION_CONFLICT');
    const moved = await db.rescheduleAppointment(pool(), mine.id, asA, { version: mine.version, startAt: at(DAY, '15:00'), staffId: B3 });
    assert.equal(moved.startAt, new Date(at(DAY, '15:00')).toISOString());
    assert.equal(moved.staffId, B3);
    assert.equal(moved.version, mine.version + 1);
    const freed = await db.createAppointment(pool(), { customerId: customers.b, staffId: B1, serviceId: BARBA, startAt: at(DAY, '09:00') });
    assert.equal(freed.appointment.status, 'confirmed');
  });

  t('cancelar libera o horário, repetir é idempotente e prazo do cliente é respeitado', async () => {
    const asC = { role: 'customer', customerId: customers.c };
    const appt = (await db.listAppointmentsForCustomer(pool(), customers.c)).find((a) => a.staffId === B3);
    const late = new Date(new Date(appt.startAt).getTime() - 30 * 60_000);
    await rejectsCode(db.cancelAppointment(pool(), appt.id, asC, { now: late }), 'BUSINESS_RULE');
    const cancelled = await db.cancelAppointment(pool(), appt.id, asC);
    assert.equal(cancelled.status, 'cancelled');
    const twice = await db.cancelAppointment(pool(), appt.id, asC);
    assert.equal(twice.version, cancelled.version);
    const outbox = await pool().query("SELECT count(*)::int AS n FROM outbox WHERE dedupe_key = $1", [`appointment.cancelled:${appt.id}`]);
    assert.equal(outbox.rows[0].n, 1);
    const reuse = await db.createAppointment(pool(), { customerId: customers.b, staffId: B3, serviceId: CORTE, startAt: appt.startAt });
    assert.equal(reuse.appointment.status, 'confirmed');
    await rejectsCode(db.setAppointmentStatus(pool(), appt.id, { role: 'admin' }, { version: twice.version, status: 'completed' }), 'BUSINESS_RULE');
  });

  t('concluído/falta não reabrem, nem por UPDATE direto no banco', async () => {
    const appt = (await db.listAppointmentsForCustomer(pool(), customers.b)).find((a) => a.status === 'confirmed');
    await rejectsCode(db.setAppointmentStatus(pool(), appt.id, { role: 'customer', customerId: customers.b }, { version: appt.version, status: 'completed' }), 'VALIDATION_ERROR');
    const done = await db.setAppointmentStatus(pool(), appt.id, { role: 'barber', staffId: appt.staffId }, { version: appt.version, status: 'completed' });
    assert.equal(done.status, 'completed');
    await rejectsCode(db.cancelAppointment(pool(), appt.id, { role: 'admin' }), 'BUSINESS_RULE');
    await assert.rejects(pool().query("UPDATE appointments SET status = 'confirmed' WHERE id = $1", [appt.id]),
      (e) => e.code === '23514' && db.translatePgError(e).code === 'BUSINESS_RULE');
    const occ = await pool().query('SELECT count(*)::int AS n FROM occupations WHERE appointment_id = $1', [appt.id]);
    assert.equal(occ.rows[0].n, 1, 'atendimento concluído continua ocupando o horário');
  });

  t('idempotência: mesmo corpo repete o resultado, corpo diferente dá 409, pedidos simultâneos criam 1 reserva', async () => {
    const key = randomBytes(16).toString('hex');
    const body = { customerId: customers.a, staffId: B2, serviceId: BARBA, startAt: at(DAY, '16:00') };
    const first = await db.createAppointment(pool(), { ...body, idempotencyKey: key, requestHash: sha(JSON.stringify(body)) });
    const second = await db.createAppointment(pool(), { ...body, idempotencyKey: key, requestHash: sha(JSON.stringify(body)) });
    assert.equal(second.replayed, true);
    assert.equal(second.appointment.id, first.appointment.id);
    await rejectsCode(db.createAppointment(pool(), { ...body, startAt: at(DAY, '17:00'), idempotencyKey: key, requestHash: sha('outro') }), 'IDEMPOTENCY_CONFLICT');
    const key2 = randomBytes(16).toString('hex');
    const body2 = { customerId: customers.a, staffId: B2, serviceId: BARBA, startAt: at(DAY, '17:00') };
    const parallel = await Promise.all(Array.from({ length: 5 }, () =>
      db.createAppointment(pool(), { ...body2, idempotencyKey: key2, requestHash: sha(JSON.stringify(body2)) })));
    assert.equal(new Set(parallel.map((p) => p.appointment.id)).size, 1);
    assert.equal(parallel.filter((p) => !p.replayed).length, 1);
  });

  t('expediente: alteração que deixaria reserva confirmada fora do horário é recusada e nada muda', async () => {
    const before = await db.getWorkingHours(pool(), B2);
    await rejectsCode(db.replaceWorkingHours(pool(), B2, [{ weekday: 1, startLocal: '09:00', endLocal: '12:00' }]), 'SCHEDULE_CONFLICT');
    assert.deepEqual(await db.getWorkingHours(pool(), B2), before);
    await rejectsCode(db.replaceWorkingHours(pool(), B2, [{ weekday: 1, startLocal: '09:00', endLocal: '12:00' }, { weekday: 1, startLocal: '11:00', endLocal: '13:00' }]), 'VALIDATION_ERROR');
    await rejectsCode(db.replaceWorkingHours(pool(), B2, [{ weekday: 1, startLocal: '25:00', endLocal: '26:00' }]), 'VALIDATION_ERROR');
    const changed = await db.replaceWorkingHours(pool(), B2, [...before.map((w) => ({ weekday: w.weekday, startLocal: w.startLocal, endLocal: w.endLocal })), { weekday: 0, startLocal: '10:00', endLocal: '14:00' }]);
    assert.equal(changed.length, 7);
  });

  t('transação desfaz tudo quando o callback falha', async () => {
    await assert.rejects(db.transaction(pool(), async (tx) => {
      await tx.query("INSERT INTO customers (name, phone) VALUES ('Fantasma', '+5511955554444')");
      throw new Error('falha proposital');
    }), /falha proposital/);
    assert.equal(await db.findCustomerIdByPhone(pool(), '11955554444'), null);
  });

  t('sessão: só hash do token, expira, revoga; telefone sozinho não cria sessão', async () => {
    const token = randomBytes(32);
    const s = await db.createSession(pool(), { tokenHash: sha(token), role: 'customer', customerId: customers.a });
    const found = await db.findActiveSession(pool(), sha(token));
    assert.equal(found.customerId, customers.a);
    assert.equal(await db.findActiveSession(pool(), sha(randomBytes(32))), null);
    const raw = await pool().query('SELECT token_hash FROM sessions WHERE id = $1', [s.id]);
    assert.ok(!raw.rows[0].token_hash.equals(token), 'token puro não é gravado');
    await db.revokeSession(pool(), s.id);
    assert.equal(await db.findActiveSession(pool(), sha(token)), null);
    await assert.rejects(pool().query("INSERT INTO sessions (token_hash, role, expires_at) VALUES ($1, 'customer', now() + interval '1 day')", [sha('x')]), (e) => e.code === '23514');
  });

  t('prova de posse: código errado conta tentativa, máximo 5, uso único', async () => {
    const id = await db.createChallenge(pool(), { phoneHash: sha('+5511987654321'), customerId: customers.a, codeHash: sha('123456') });
    for (let i = 0; i < 4; i++) assert.equal(await db.verifyChallenge(pool(), id, sha('000000')), null);
    assert.equal(await db.verifyChallenge(pool(), id, sha('123456')), customers.a);
    assert.equal(await db.verifyChallenge(pool(), id, sha('123456')), null, 'uso único');
    const id2 = await db.createChallenge(pool(), { phoneHash: sha('+5511987654321'), customerId: customers.a, codeHash: sha('654321') });
    for (let i = 0; i < 5; i++) await db.verifyChallenge(pool(), id2, sha('000000'));
    assert.equal(await db.verifyChallenge(pool(), id2, sha('654321')), null, 'bloqueado após 5 tentativas');
    assert.ok((await db.getCustomer(pool(), customers.a)).phoneVerifiedAt);
  });

  t('prova de posse: teto diário de desafios por telefone, também sob concorrência', async () => {
    const phone = sha('+5511911112222');
    const outro = sha('+5511933334444');
    const req = sha('requester:192.0.2.1');
    const pedidos = Array.from({ length: 6 }, (_, i) => db.createChallenge(pool(), { phoneHash: phone, codeHash: sha(`c${i}`), requesterHash: req, maxPerDay: 4 }));
    const res = await Promise.allSettled(pedidos);
    assert.equal(res.filter((r) => r.status === 'fulfilled').length, 4);
    for (const r of res.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'RATE_LIMITED');
    assert.equal(res.find((r) => r.status === 'rejected').reason.status, 429);
    assert.ok(await db.createChallenge(pool(), { phoneHash: outro, codeHash: sha('x'), maxPerDay: 4 }), 'outro telefone não é afetado');
    // Desafios com mais de 24 h deixam de contar.
    await pool().query("UPDATE challenges SET created_at = now() - interval '25 hours', expires_at = now() - interval '24 hours' WHERE phone_hash = $1", [phone]);
    assert.ok(await db.createChallenge(pool(), { phoneHash: phone, codeHash: sha('novo'), requesterHash: req, maxPerDay: 4 }));
    // Sem solicitante não se aplica a cota por solicitante; vale a cota total do telefone (teste abaixo).
    for (let i = 0; i < 6; i++) assert.ok(await db.createChallenge(pool(), { phoneHash: phone, codeHash: sha(`n${i}`), maxPerDay: 4 }));
    await rejectsCode(db.createChallenge(pool(), { phoneHash: phone, codeHash: sha('y'), maxPerDay: 0 }), 'VALIDATION_ERROR');
  });

  t('prova de posse: terceiro que esgota os pedidos não bloqueia o dono do telefone (B5)', async () => {
    const phone = sha('+5511977778888');
    const atacante = sha('requester:203.0.113.9');
    const dono = sha('requester:198.51.100.7');
    for (let i = 0; i < 5; i++) await db.createChallenge(pool(), { phoneHash: phone, codeHash: sha(`a${i}`), requesterHash: atacante });
    await rejectsCode(db.createChallenge(pool(), { phoneHash: phone, codeHash: sha('a5'), requesterHash: atacante }), 'RATE_LIMITED');
    const id = await db.createChallenge(pool(), { phoneHash: phone, customerId: customers.b, codeHash: sha('424242'), requesterHash: dono });
    assert.equal(await db.verifyChallenge(pool(), id, sha('424242')), customers.b, 'dono ainda recupera o acesso');
    const raw = await pool().query('SELECT requester_hash FROM challenges WHERE id = $1', [id]);
    assert.ok(Buffer.from(raw.rows[0].requester_hash).equals(dono));
    await rejectsCode(db.createChallenge(pool(), { phoneHash: phone, codeHash: sha('z'), requesterHash: Buffer.alloc(3) }), 'VALIDATION_ERROR');
  });

  t('prova de posse: palpites errados somados entre desafios e solicitantes têm teto diário por telefone', async () => {
    const phone = sha('+5511966667777');
    const lim = { maxWrongPerDay: 7 };
    const ids = [];
    for (let r = 0; r < 3; r++) {
      ids.push(await db.createChallenge(pool(), { phoneHash: phone, customerId: customers.a, codeHash: sha(`9${r}`), requesterHash: sha(`r${r}`), ...lim }));
    }
    for (let i = 0; i < 5; i++) await db.verifyChallenge(pool(), ids[0], sha('000000'), lim);
    // 10 palpites errados simultâneos em outro desafio: o lock por telefone impede passar de 7 no total.
    await Promise.all(Array.from({ length: 10 }, () => db.verifyChallenge(pool(), ids[1], sha('000000'), lim)));
    const { rows: [{ n }] } = await pool().query('SELECT sum(attempts)::int AS n FROM challenges WHERE phone_hash = $1', [phone]);
    assert.equal(n, 7);
    assert.equal(await db.verifyChallenge(pool(), ids[2], sha('92'), lim), null, 'cota esgotada: nem o código certo vale');
    await rejectsCode(db.createChallenge(pool(), { phoneHash: phone, codeHash: sha('x'), requesterHash: sha('r9'), ...lim }), 'RATE_LIMITED');
    // Só pedir códigos não consome a cota de palpites: outro telefone com 5 pedidos segue verificável.
    const p2 = sha('+5511955550000');
    for (let i = 0; i < 4; i++) await db.createChallenge(pool(), { phoneHash: p2, codeHash: sha(`p${i}`), requesterHash: sha(`q${i}`), ...lim });
    const ok = await db.createChallenge(pool(), { phoneHash: p2, customerId: customers.a, codeHash: sha('515151'), requesterHash: sha('q9'), ...lim });
    assert.equal(await db.verifyChallenge(pool(), ok, sha('515151'), lim), customers.a);
  });

  t('prova de posse: teto diário total por telefone vale com ou sem solicitante e sob concorrência (N1)', async () => {
    const phone = sha('+5511944443333');
    assert.equal(db.CHALLENGES_PER_PHONE_PER_DAY, 20);
    // Padrão (20/dia): sem solicitante, como o servidor chamava, o 21º pedido é recusado.
    const res = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => db.createChallenge(pool(), { phoneHash: phone, codeHash: sha(`s${i}`) })));
    assert.equal(res.filter((r) => r.status === 'fulfilled').length, 20);
    for (const r of res.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'RATE_LIMITED');
    // Muitos solicitantes diferentes também não passam da cota total do telefone.
    const p2 = sha('+5511944442222');
    const lim = { maxPerPhonePerDay: 6 };
    for (let i = 0; i < 6; i++) await db.createChallenge(pool(), { phoneHash: p2, codeHash: sha(`t${i}`), requesterHash: sha(`ip${i}`), ...lim });
    await rejectsCode(db.createChallenge(pool(), { phoneHash: p2, codeHash: sha('t6'), requesterHash: sha('ip6'), ...lim }), 'RATE_LIMITED');
    await rejectsCode(db.createChallenge(pool(), { phoneHash: p2, codeHash: sha('t7'), maxPerPhonePerDay: 0 }), 'VALIDATION_ERROR');
    // Pedidos com mais de 24 h deixam de contar.
    await pool().query("UPDATE challenges SET created_at = now() - interval '25 hours', expires_at = now() - interval '24 hours' WHERE phone_hash = $1", [phone]);
    assert.ok(await db.createChallenge(pool(), { phoneHash: phone, codeHash: sha('depois') }));
  });

  t('purgeExpired remove só o que expirou há mais de 1 dia', async () => {
    const velho = randomBytes(32);
    const novo = randomBytes(32);
    const sv = await db.createSession(pool(), { tokenHash: sha(velho), role: 'anonymous' });
    await db.createSession(pool(), { tokenHash: sha(novo), role: 'anonymous' });
    await pool().query("UPDATE sessions SET created_at = now() - interval '10 days', expires_at = now() - interval '2 days' WHERE id = $1", [sv.id]);
    const cv = await db.createChallenge(pool(), { phoneHash: sha('+5511955556666'), codeHash: sha('1') });
    await pool().query("UPDATE challenges SET created_at = now() - interval '3 days', expires_at = now() - interval '2 days' WHERE id = $1", [cv]);
    await db.hitRateLimit(pool(), 'purge:teste', { windowSeconds: 60, max: 5, now: new Date(Date.now() - 3 * 86400_000) });
    await db.hitRateLimit(pool(), 'purge:teste', { windowSeconds: 60, max: 5 });
    const out = await db.purgeExpired(pool());
    assert.ok(out.sessions >= 1 && out.challenges >= 1 && out.rateLimits >= 1);
    assert.equal(typeof out.idempotencyKeys, 'number');
    assert.equal(await db.findActiveSession(pool(), sha(velho)), null);
    assert.ok(await db.findActiveSession(pool(), sha(novo)), 'sessão válida preservada');
    assert.equal((await pool().query('SELECT count(*)::int AS n FROM challenges WHERE id = $1', [cv])).rows[0].n, 0);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM rate_limits WHERE bucket = 'purge:teste'")).rows[0].n, 1);
  });

  t('limite de requisições persistente e outbox com SKIP LOCKED', async () => {
    const opts = { windowSeconds: 900, max: 2 };
    assert.equal((await db.hitRateLimit(pool(), 'login:ip:203.0.113.1', opts)).allowed, true);
    assert.equal((await db.hitRateLimit(pool(), 'login:ip:203.0.113.1', opts)).allowed, true);
    const third = await db.hitRateLimit(pool(), 'login:ip:203.0.113.1', opts);
    assert.equal(third.allowed, false);
    assert.ok(third.retryAfterSeconds > 0);
    const [w1, w2] = await Promise.all([db.claimOutbox(pool(), { limit: 3 }), db.claimOutbox(pool(), { limit: 3 })]);
    const ids = [...w1, ...w2].map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'nenhuma mensagem entregue a dois workers');
    assert.ok(w1[0]?.payload?.appointmentId || w2[0]?.payload?.appointmentId);
    await db.markOutboxSent(pool(), ids[0]);
  });

  t('dados persistem após reiniciar o PostgreSQL', async () => {
    const before = (await pool().query('SELECT count(*)::int AS n FROM appointments')).rows[0].n;
    assert.ok(before > 0);
    await pg.restart();
    assert.equal((await pool().query('SELECT count(*)::int AS n FROM appointments')).rows[0].n, before);
    assert.deepEqual(await db.migrate(pool()), []);
    const list = await db.listAppointmentsForCustomer(pool(), customers.a);
    assert.ok(list.length > 0);
  });

  t('validação de entrada: campo desconhecido, uuid e instante inválidos não chegam ao banco', async () => {
    await rejectsCode(db.createAppointment(pool(), { customerId: customers.a, staffId: B1, serviceId: CORTE, startAt: at(DAY, '10:30'), priceCents: 1 }), 'VALIDATION_ERROR');
    await rejectsCode(db.createAppointment(pool(), { customerId: 'abc', staffId: B1, serviceId: CORTE, startAt: at(DAY, '10:30') }), 'VALIDATION_ERROR');
    await rejectsCode(db.createAppointment(pool(), { customerId: customers.a, staffId: B1, serviceId: CORTE, startAt: '2026-13-01 10:00' }), 'VALIDATION_ERROR');
    await rejectsCode(db.createAppointment(pool(), { customerId: customers.a, staffId: B1, serviceId: CORTE, startAt: at(DAY, '10:30'), notes: 'x'.repeat(501) }), 'VALIDATION_ERROR');
    await rejectsCode(db.createAppointment(pool(), { customerId: randomUUID(), staffId: B1, serviceId: CORTE, startAt: at(DAY, '10:30') }), 'NOT_FOUND');
    await rejectsCode(db.updateShop(pool(), db.SEED_SHOP_ID, { version: 1, timezone: 'Marte/Base' }), 'VALIDATION_ERROR');
    const shop = await db.updateShop(pool(), db.SEED_SHOP_ID, { version: 1, address: 'Rua Exemplo, 100', contactPhone: '(11) 3333-4444' });
    assert.equal(shop.contactPhone, '+551133334444');
    await rejectsCode(db.updateShop(pool(), db.SEED_SHOP_ID, { version: 1, address: 'velha' }), 'VERSION_CONFLICT');
  });
});
