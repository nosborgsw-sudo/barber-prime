#!/usr/bin/env node
// Worker do outbox (frente RPA): entrega os eventos gravados pela camada de dados na mesma transação
// da reserva (appointment.confirmed / rescheduled / cancelled) como SMS ao cliente.
//
//   DATABASE_URL=... TWILIO_...=... node jobs/outbox-worker.mjs [--uma-vez] [--intervalo 30] [--log jobs.log]
//
// Tentativas: claimOutbox (db/) incrementa `attempts`, adia `available_at` e para em 10 tentativas;
// SKIP LOCKED permite mais de um worker. Cada falha vai para outbox.last_error (sem segredo nem telefone)
// e para o log em JSON por linha. Sem provedor configurado o worker não consome nada (não queima tentativas).
//
// challenge.requested não é tratado aqui: o código de acesso não deve ficar em texto no banco;
// o backend chama automation/challenge-provider.mjs (sendChallenge) diretamente.
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ProviderError, maskPhone } from '../automation/challenge-provider.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PermanentError extends Error {
  constructor(message) { super(message); this.name = 'PermanentError'; }
}

export function createLogger({ file = null, stream = process.stderr } = {}) {
  return async (level, event, data = {}) => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), level, event, ...data })}\n`;
    if (file) await appendFile(file, line, 'utf8');
    else stream.write(line);
  };
}

function formatWhen(iso, timeZone) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(iso));
}

/** Monta o texto do SMS. Só dados que o próprio cliente já conhece; nada de outros clientes. */
export function buildAppointmentMessage(topic, appt, { shopName = 'Barber Prime', timeZone = 'America/Sao_Paulo' } = {}) {
  const when = formatWhen(appt.startAt, timeZone);
  const what = `${appt.serviceName} com ${appt.staffName}`;
  if (topic === 'appointment.confirmed') return `${shopName}: agendamento confirmado — ${what}, ${when}.`;
  if (topic === 'appointment.rescheduled') return `${shopName}: agendamento remarcado — ${what}, agora ${when}.`;
  if (topic === 'appointment.cancelled') return `${shopName}: agendamento cancelado — ${what}, ${when}.`;
  throw new PermanentError(`tópico sem mensagem: ${topic}`);
}

/**
 * Tratadores padrão por tópico. `db` é o módulo db/index.mjs (ou um dublê com a mesma interface).
 * Telefone vem de getAppointment com escopo admin (customerPhone), já normalizado em E.164.
 */
export function createAppointmentHandlers({ db, pool, sms, shop = {} }) {
  const options = { shopName: shop.name ?? 'Barber Prime', timeZone: shop.timezone ?? 'America/Sao_Paulo' };
  const notify = async (topic, payload) => {
    const id = payload?.appointmentId;
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new PermanentError('payload sem appointmentId válido');
    const appt = await db.getAppointment(pool, id, { role: 'admin' });
    if (!appt) throw new PermanentError('reserva não encontrada');
    if (topic !== 'appointment.cancelled' && appt.status === 'cancelled') return { skipped: 'reserva já cancelada' };
    if (!appt.customerPhone) throw new PermanentError('reserva sem telefone do cliente');
    const result = await sms.sendSms({ to: appt.customerPhone, body: buildAppointmentMessage(topic, appt, options) });
    return { providerId: result.providerId, to: maskPhone(appt.customerPhone) };
  };
  return {
    'appointment.confirmed': (p) => notify('appointment.confirmed', p),
    'appointment.rescheduled': (p) => notify('appointment.rescheduled', p),
    'appointment.cancelled': (p) => notify('appointment.cancelled', p),
  };
}

function reasonOf(err) {
  if (err instanceof ProviderError) return `${err.code}: ${err.message}`;
  if (err instanceof PermanentError) return `PERMANENTE: ${err.message}`;
  return `ERRO_INTERNO: ${err?.code ?? err?.name ?? 'desconhecido'}`;
}

/**
 * Processa um lote. Nunca lança por falha de uma mensagem: registra e segue para a próxima.
 * Retorna { claimed, sent, failed, skipped }.
 */
export async function processOutboxBatch({ db, pool, handlers, log, limit = 10, retryAfterSeconds = 60 }) {
  const batch = await db.claimOutbox(pool, { limit, retryAfterSeconds });
  const stats = { claimed: batch.length, sent: 0, failed: 0, skipped: 0 };
  for (const msg of batch) {
    const handler = handlers[msg.topic];
    try {
      if (!handler) throw new PermanentError(`sem tratador para ${msg.topic}`);
      const result = await handler(msg.payload);
      await db.markOutboxSent(pool, msg.id);
      if (result?.skipped) stats.skipped += 1; else stats.sent += 1;
      await log('info', 'outbox_entregue', { id: msg.id, topic: msg.topic, attempt: msg.attempts, ...result });
    } catch (err) {
      stats.failed += 1;
      const reason = reasonOf(err);
      const finalAttempt = msg.attempts >= 10;
      try {
        await db.markOutboxFailed(pool, msg.id, reason);
      } catch (markErr) {
        await log('error', 'outbox_marcar_falha_falhou', { id: msg.id, reason: markErr?.code ?? 'erro' });
      }
      await log(finalAttempt ? 'error' : 'warn', finalAttempt ? 'outbox_desistiu' : 'outbox_falhou', {
        id: msg.id, topic: msg.topic, attempt: msg.attempts, reason,
        retryable: err instanceof ProviderError ? err.retryable : !(err instanceof PermanentError),
      });
    }
  }
  return stats;
}

/** Laço com intervalo entre lotes; termina quando `signal` é abortado. Lote cheio repete sem esperar. */
export async function runWorker({ intervalSeconds = 30, signal, limit = 10, ...deps }) {
  while (!signal?.aborted) {
    let stats;
    try {
      stats = await processOutboxBatch({ ...deps, limit });
    } catch (err) {
      await deps.log('error', 'outbox_lote_falhou', { reason: err?.code ?? err?.name ?? 'erro' });
      stats = { claimed: 0 };
    }
    if (stats.claimed >= limit) continue;
    await new Promise((done) => {
      const timer = setTimeout(done, intervalSeconds * 1000);
      signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
    });
  }
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { 'uma-vez': { type: 'boolean', default: false }, intervalo: { type: 'string', default: '30' }, log: { type: 'string' } },
    strict: true,
  });
  const intervalSeconds = Number(values.intervalo);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 3600) {
    throw new Error('--intervalo precisa ser inteiro entre 5 e 3600 segundos');
  }
  if (values.log && !values.log.toLowerCase().endsWith('.log')) throw new Error('--log precisa terminar em .log');
  const log = createLogger({ file: values.log ? resolve(values.log) : null });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não definida');

  const { createSmsProvider } = await import('../automation/challenge-provider.mjs');
  const sms = createSmsProvider(); // sem configuração: ProviderError PROVIDER_NOT_CONFIGURED, nada é consumido
  const pg = (await import('pg')).default;
  const db = await import('../db/index.mjs');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  try {
    const shop = (await db.getShop(pool)) ?? {};
    const handlers = createAppointmentHandlers({ db, pool, sms, shop });
    if (values['uma-vez']) {
      const stats = await processOutboxBatch({ db, pool, handlers, log });
      process.stdout.write(`${JSON.stringify(stats)}\n`);
    } else {
      await log('info', 'worker_iniciado', { intervalSeconds });
      await runWorker({ db, pool, handlers, log, intervalSeconds, signal: controller.signal });
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    const message = err instanceof ProviderError ? `${err.code}: ${err.message}` : err.message;
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level: 'error', event: 'worker_falhou', message })}\n`);
    process.exitCode = 1;
  });
}
