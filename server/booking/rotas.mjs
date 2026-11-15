// Disponibilidade e reservas. O cliente é sempre o da sessão; reserva alheia responde 404.
import { createHash } from 'node:crypto';
import * as db from '../../db/index.mjs';
import { clientIp, rateLimit, requireCsrf, requireRole, scopeOf } from '../auth/seguranca.mjs';
import { localRange, requireShop } from '../catalog/rotas.mjs';
import { httpError, intParam, invalid, onlyFields, readJson, readQuery } from '../http.mjs';
import { parseLocalDate } from '../tempo.mjs';

// Cliente não recebe telefone/nome de outros nem dados internos; a própria reserva não traz o telefone dele.
function view(appointment, session) {
  if (!appointment) return appointment;
  if (session.role === 'customer') {
    const { customerName, customerPhone, ...own } = appointment;
    return own;
  }
  if (session.role === 'barber') {
    const { customerPhone, ...rest } = appointment;
    return rest;
  }
  return appointment;
}

// Teto de reservas futuras ativas por cliente: impede que uma conta (ou várias) ocupe a agenda inteira.
export const MAX_ACTIVE_FUTURE_PER_CUSTOMER = 5;

// Contagem e criação da reserva do mesmo cliente em série (por processo), para pedidos simultâneos
// não furarem o teto. Com várias instâncias contra o mesmo banco a corrida residual continua possível.
const customerQueues = new Map();

export async function serialByCustomer(customerId, run) {
  const previous = customerQueues.get(customerId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  const tail = current.catch(() => {});
  customerQueues.set(customerId, tail);
  try {
    return await current;
  } finally {
    if (customerQueues.get(customerId) === tail) customerQueues.delete(customerId);
  }
}

async function enforceActiveLimit(ctx, customerId, idempotencyKey) {
  // Repetição de uma chave de idempotência já usada devolve a reserva existente; não conta como nova.
  if (idempotencyKey !== undefined) {
    const { rows } = await ctx.pool.query(
      "SELECT 1 FROM idempotency_keys WHERE principal_id = $1 AND key = $2 AND created_at > now() - interval '24 hours'",
      [customerId, idempotencyKey]);
    if (rows.length) return;
  }
  const { rows } = await ctx.pool.query(
    "SELECT count(*)::int AS n FROM appointments WHERE customer_id = $1 AND status = 'confirmed' AND start_at > now()",
    [customerId]);
  if (rows[0].n >= MAX_ACTIVE_FUTURE_PER_CUSTOMER) {
    throw httpError(409, 'BOOKING_LIMIT', `Você já tem ${MAX_ACTIVE_FUTURE_PER_CUSTOMER} reservas futuras. Cancele uma para marcar outra.`);
  }
}

async function availability(ctx) {
  await rateLimit(ctx, 'read', clientIp(ctx), 'read');
  const query = readQuery(ctx.url, ['staffId', 'serviceId', 'date']);
  for (const field of ['staffId', 'serviceId', 'date']) if (!query[field]) throw invalid(field, 'obrigatório');
  const data = await db.listAvailability(ctx.pool, {
    staffId: query.staffId, serviceId: query.serviceId, date: parseLocalDate(query.date, 'date'),
  });
  return { status: 200, body: { data } };
}

async function createAppointment(ctx) {
  await requireCsrf(ctx);
  const session = await requireRole(ctx, ['customer', 'admin']);
  const principal = session.customerId ?? session.staffId;
  await rateLimit(ctx, 'booking', principal, 'booking');
  const allowed = session.role === 'admin'
    ? ['customerId', 'staffId', 'serviceId', 'startAt', 'notes']
    : ['staffId', 'serviceId', 'startAt', 'notes'];
  const required = session.role === 'admin' ? ['customerId', 'staffId', 'serviceId', 'startAt'] : ['staffId', 'serviceId', 'startAt'];
  const body = onlyFields(await readJson(ctx.request), allowed, required);
  const input = { ...body, customerId: session.role === 'customer' ? session.customerId : body.customerId };

  const key = ctx.request.headers['idempotency-key'];
  if (key !== undefined) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
      throw invalid('Idempotency-Key', '16..128 caracteres [A-Za-z0-9_-]');
    }
    const canonical = JSON.stringify(['customerId', 'staffId', 'serviceId', 'startAt', 'notes'].map((k) => input[k] ?? null));
    input.idempotencyKey = key;
    input.requestHash = createHash('sha256').update(canonical).digest();
    input.principalId = principal;
  }
  const { appointment, replayed } = session.role === 'customer'
    ? await serialByCustomer(session.customerId, async () => {
      await enforceActiveLimit(ctx, session.customerId, input.idempotencyKey);
      return db.createAppointment(ctx.pool, input);
    })
    : await db.createAppointment(ctx.pool, input);
  if (!replayed) await db.recordAudit(ctx.pool, { actorId: principal, action: 'appointment.created', entityId: appointment.id });
  return { status: replayed ? 200 : 201, body: { data: view(appointment, session) } };
}

async function listAppointments(ctx) {
  const session = await requireRole(ctx, ['customer', 'barber', 'admin']);
  const query = readQuery(ctx.url, ['from', 'to', 'limit', 'cursor', 'staffId', 'includeCancelled']);
  const limit = intParam(query.limit, 'limit', 1, 100) ?? 25;
  if (query.cursor !== undefined) throw invalid('cursor', 'cursor inválido');
  if (session.role === 'customer') {
    if (query.staffId !== undefined) throw httpError(403, 'FORBIDDEN', 'Filtro não permitido para clientes.');
    const rows = await db.listAppointmentsForCustomer(ctx.pool, session.customerId, { limit });
    return { status: 200, body: { data: rows.map((a) => view(a, session)), meta: { cursor: null } } };
  }
  if (session.role === 'barber' && query.staffId !== undefined && query.staffId !== session.staffId) {
    throw httpError(403, 'FORBIDDEN', 'Barbeiro só consulta a própria agenda.');
  }
  if (query.includeCancelled !== undefined && !['true', 'false'].includes(query.includeCancelled)) {
    throw invalid('includeCancelled', 'true|false');
  }
  const range = localRange(await requireShop(ctx.pool), query, 7);
  const rows = await db.listAgenda(ctx.pool, scopeOf(session), {
    ...range, staffId: query.staffId ?? null, includeCancelled: query.includeCancelled === 'true',
  });
  // Agenda vem inteira no período (até 31 dias); `limit` só recorta quando enviado.
  const page = query.limit === undefined ? rows : rows.slice(0, limit);
  return { status: 200, body: { data: page.map((a) => view(a, session)), meta: { cursor: null } } };
}

async function getAppointment(ctx) {
  const session = await requireRole(ctx, ['customer', 'barber', 'admin']);
  const appointment = await db.getAppointment(ctx.pool, ctx.params.id, scopeOf(session));
  if (!appointment) throw httpError(404, 'NOT_FOUND', 'Reserva não encontrada.');
  return { status: 200, body: { data: view(appointment, session) } };
}

async function reschedule(ctx) {
  await requireCsrf(ctx);
  const session = await requireRole(ctx, ['customer', 'admin']);
  const body = onlyFields(await readJson(ctx.request), ['staffId', 'startAt', 'version'], ['startAt', 'version']);
  const updated = await db.rescheduleAppointment(ctx.pool, ctx.params.id, scopeOf(session), body);
  await db.recordAudit(ctx.pool, { actorId: session.customerId ?? session.staffId, action: 'appointment.rescheduled', entityId: updated.id });
  return { status: 200, body: { data: view(updated, session) } };
}

async function cancel(ctx) {
  await requireCsrf(ctx);
  const session = await requireRole(ctx, ['customer', 'admin']);
  const body = onlyFields(await readJson(ctx.request), ['version'], ['version']);
  if (!Number.isInteger(body.version) || body.version < 1) throw invalid('version', 'inteiro >= 1');
  const scope = scopeOf(session);
  const current = await db.getAppointment(ctx.pool, ctx.params.id, scope);
  if (!current) throw httpError(404, 'NOT_FOUND', 'Reserva não encontrada.');
  // Repetir o cancelamento devolve o estado cancelado; fora isso, a versão precisa ser a atual.
  if (current.status !== 'cancelled' && current.version !== body.version) {
    throw httpError(409, 'VERSION_CONFLICT', 'Reserva alterada por outra pessoa; recarregue.');
  }
  const updated = await db.cancelAppointment(ctx.pool, current.id, scope);
  if (current.status !== 'cancelled') {
    await db.recordAudit(ctx.pool, { actorId: session.customerId ?? session.staffId, action: 'appointment.cancelled', entityId: updated.id });
  }
  return { status: 200, body: { data: view(updated, session) } };
}

async function setStatus(ctx) {
  await requireCsrf(ctx);
  const session = await requireRole(ctx, ['barber', 'admin']);
  const body = onlyFields(await readJson(ctx.request), ['status', 'version'], ['status', 'version']);
  const updated = await db.setAppointmentStatus(ctx.pool, ctx.params.id, scopeOf(session), body);
  await db.recordAudit(ctx.pool, { actorId: session.staffId, action: `appointment.${updated.status}`, entityId: updated.id });
  return { status: 200, body: { data: view(updated, session) } };
}

export const bookingRoutes = [
  ['GET', '/api/availability', availability],
  ['POST', '/api/appointments', createAppointment],
  ['GET', '/api/appointments', listAppointments],
  ['GET', '/api/appointments/:id', getAppointment],
  ['PATCH', '/api/appointments/:id/reschedule', reschedule],
  ['POST', '/api/appointments/:id/cancel', cancel],
  ['PATCH', '/api/appointments/:id/status', setStatus],
];
