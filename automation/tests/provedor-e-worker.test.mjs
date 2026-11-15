import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError, createSmsProvider, loadSmsConfig, maskPhone } from '../challenge-provider.mjs';
import { buildAppointmentMessage, createAppointmentHandlers, processOutboxBatch } from '../../jobs/outbox-worker.mjs';

// Valores fictícios no formato da Twilio, montados em tempo de execução (não são credenciais).
const FAKE_SID = `AC${'0'.repeat(32)}`;
const FAKE_SECRET = `fake-${'x'.repeat(27)}`;
const FAKE_ENV = { TWILIO_ACCOUNT_SID: FAKE_SID, TWILIO_AUTH_TOKEN: FAKE_SECRET, TWILIO_FROM: '+15005550006' };
const PHONE = '+5511987654321';
const APPT_ID = '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  };
  fn.calls = calls;
  return fn;
}

test('rpa sms: configuração vem do ambiente e incompleta devolve null', () => {
  assert.equal(loadSmsConfig({}), null);
  assert.equal(loadSmsConfig({ ...FAKE_ENV, TWILIO_FROM: '' }), null);
  assert.equal(loadSmsConfig({ ...FAKE_ENV, TWILIO_ACCOUNT_SID: 'invalido' }), null);
  assert.equal(loadSmsConfig(FAKE_ENV).username, FAKE_SID);
  assert.throws(() => createSmsProvider({ config: null }), (e) => e.code === 'PROVIDER_NOT_CONFIGURED');
});

test('rpa sms: envia desafio pela API oficial com Basic auth e formulário', async () => {
  const fetchImpl = fakeFetch([{ status: 201, body: { sid: 'SM123', status: 'queued' } }]);
  const sms = createSmsProvider({ config: loadSmsConfig(FAKE_ENV), fetchImpl });
  const res = await sms.sendChallenge({ challengeId: APPT_ID, destination: PHONE, code: '482913', expiresAt: '2026-11-17T12:05:00Z' });
  assert.deepEqual(res, { providerId: 'SM123', status: 'queued' });
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${FAKE_SID}/Messages.json`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${FAKE_SID}:${FAKE_SECRET}`).toString('base64')}`);
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(init.body);
  assert.equal(form.get('To'), PHONE);
  assert.equal(form.get('From'), '+15005550006');
  assert.match(form.get('Body'), /482913.*Válido até 09:05/);
});

test('rpa sms: recusa entrada inválida antes de chamar o provedor', async () => {
  const fetchImpl = fakeFetch([]);
  const sms = createSmsProvider({ config: loadSmsConfig(FAKE_ENV), fetchImpl });
  const base = { challengeId: APPT_ID, destination: PHONE, code: '482913', expiresAt: '2026-11-17T12:05:00Z' };
  await assert.rejects(sms.sendChallenge({ ...base, destination: '11987654321' }), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(sms.sendChallenge({ ...base, code: '12ab' }), /6 dígitos/);
  await assert.rejects(sms.sendChallenge({ ...base, expiresAt: 'x' }), /expiresAt/);
  await assert.rejects(sms.sendSms({ to: PHONE, body: '' }), /1 a 320/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('rpa sms: erros do provedor classificados sem vazar credencial nem telefone', async () => {
  const fetchImpl = fakeFetch([
    { status: 503, body: {} },
    { status: 400, body: { code: 21211, message: `Invalid To ${PHONE}` } },
    { status: 401, body: { code: 20003 } },
    Object.assign(new Error('t'), { name: 'TimeoutError' }),
  ]);
  const sms = createSmsProvider({ config: loadSmsConfig(FAKE_ENV), fetchImpl });
  const send = () => sms.sendSms({ to: PHONE, body: 'teste' });
  const errors = [];
  for (let i = 0; i < 4; i += 1) errors.push(await send().catch((e) => e));
  assert.deepEqual(errors.map((e) => [e.code, e.retryable]),
    [['PROVIDER_REJECTED', true], ['PROVIDER_REJECTED', false], ['PROVIDER_AUTH', false], ['PROVIDER_TIMEOUT', true]]);
  assert.match(errors[1].message, /HTTP 400 \(código 21211\)/);
  for (const e of errors) {
    assert.ok(e instanceof ProviderError);
    assert.ok(!e.message.includes(FAKE_SECRET) && !e.message.includes(PHONE));
  }
  assert.equal(maskPhone(PHONE), '**********4321');
});

// Dublê da interface de db/ para o outbox: mesmas regras de claimOutbox (attempts++ e máximo de 10).
function fakeDb(messages, appointments) {
  const rows = messages.map((m) => ({ attempts: 0, sentAt: null, lastError: null, ...m }));
  return {
    rows,
    async claimOutbox(_pool, { limit }) {
      return rows.filter((r) => !r.sentAt && r.attempts < 10).slice(0, limit)
        .map((r) => { r.attempts += 1; return { id: r.id, topic: r.topic, payload: r.payload, attempts: r.attempts }; });
    },
    async markOutboxSent(_pool, id) { rows.find((r) => r.id === id).sentAt = new Date(); },
    async markOutboxFailed(_pool, id, reason) { rows.find((r) => r.id === id).lastError = reason; },
    async getAppointment(_pool, id, scope) {
      assert.deepEqual(scope, { role: 'admin' });
      return appointments[id] ?? null;
    },
  };
}

const APPT = {
  id: APPT_ID, startAt: '2026-11-17T12:00:00.000Z', status: 'confirmed',
  serviceName: 'Corte masculino', staffName: 'Rafael Souza', customerPhone: PHONE,
};

test('rpa worker: mensagem do SMS no fuso da barbearia', () => {
  const msg = buildAppointmentMessage('appointment.confirmed', APPT, { timeZone: 'America/Sao_Paulo' });
  assert.match(msg, /^Barber Prime: agendamento confirmado — Corte masculino com Rafael Souza, .*09:00\.$/);
});

test('rpa worker: entrega, registra falhas e tenta de novo até o limite', async () => {
  const db = fakeDb([
    { id: 'm1', topic: 'appointment.confirmed', payload: { appointmentId: APPT_ID } },
    { id: 'm2', topic: 'appointment.cancelled', payload: { appointmentId: '00000000-0000-4000-8000-000000000000' } },
    { id: 'm3', topic: 'topico.desconhecido', payload: {} },
  ], { [APPT_ID]: APPT });
  const sent = [];
  let failNext = true;
  const sms = {
    async sendSms(msg) {
      if (failNext) { failNext = false; throw new ProviderError('PROVIDER_REJECTED', 'HTTP 503', { retryable: true }); }
      sent.push(msg);
      return { providerId: 'SM1' };
    },
  };
  const logs = [];
  const log = async (level, event, data) => { logs.push({ level, event, ...data }); };
  const handlers = createAppointmentHandlers({ db, pool: {}, sms, shop: { name: 'Barber Prime', timezone: 'America/Sao_Paulo' } });

  const first = await processOutboxBatch({ db, pool: {}, handlers, log });
  assert.deepEqual(first, { claimed: 3, sent: 0, failed: 3, skipped: 0 });
  assert.equal(db.rows[0].lastError, 'PROVIDER_REJECTED: HTTP 503');
  assert.equal(db.rows[1].lastError, 'PERMANENTE: reserva não encontrada');
  assert.equal(db.rows[2].lastError, 'PERMANENTE: sem tratador para topico.desconhecido');
  assert.deepEqual(logs.map((l) => [l.event, l.retryable]), [['outbox_falhou', true], ['outbox_falhou', false], ['outbox_falhou', false]]);

  const second = await processOutboxBatch({ db, pool: {}, handlers, log });
  assert.equal(second.sent, 1);
  assert.ok(db.rows[0].sentAt);
  assert.equal(sent[0].to, PHONE);
  assert.ok(!JSON.stringify(logs).includes(PHONE), 'log não guarda telefone completo');
  assert.equal(logs.find((l) => l.event === 'outbox_entregue').to, '**********4321');

  for (let i = 0; i < 20; i += 1) await processOutboxBatch({ db, pool: {}, handlers, log });
  assert.equal(db.rows[1].attempts, 10, 'para em 10 tentativas');
  assert.equal(logs.filter((l) => l.event === 'outbox_desistiu').length, 2);
  assert.equal(sent.length, 1, 'mensagem entregue não é reenviada');
});

test('rpa worker: reserva cancelada não recebe confirmação atrasada', async () => {
  const db = fakeDb([{ id: 'm1', topic: 'appointment.confirmed', payload: { appointmentId: APPT_ID } }],
    { [APPT_ID]: { ...APPT, status: 'cancelled' } });
  const sms = { async sendSms() { throw new Error('não deveria enviar'); } };
  const handlers = createAppointmentHandlers({ db, pool: {}, sms });
  const stats = await processOutboxBatch({ db, pool: {}, handlers, log: async () => {} });
  assert.deepEqual(stats, { claimed: 1, sent: 0, failed: 0, skipped: 1 });
  assert.ok(db.rows[0].sentAt);
});
