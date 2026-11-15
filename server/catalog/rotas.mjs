// Catálogo público (barbearia, barbeiros, serviços) e administração (configuração, expediente, bloqueios).
import * as db from '../../db/index.mjs';
import { clientIp, rateLimit, requireCsrf, requireRole } from '../auth/seguranca.mjs';
import { httpError, intParam, invalid, onlyFields, readJson, readQuery } from '../http.mjs';
import { addDays, localToday, parseLocalDate, startOfLocalDay } from '../tempo.mjs';

export async function requireShop(pool) {
  const shop = await db.getShop(pool);
  if (!shop) throw httpError(503, 'DB_UNAVAILABLE', 'Barbearia ainda não configurada.');
  return shop;
}

const publicStaff = (s) => ({ id: s.id, name: s.name, role: s.role, bio: s.bio, sortOrder: s.sortOrder });

// Horário de funcionamento público: por dia da semana, menor início e maior fim dos expedientes
// vigentes hoje dos barbeiros ativos. Dia sem expediente fica ausente.
export async function openingHours(pool, timezone) {
  const today = localToday(timezone);
  const byDay = new Map();
  for (const barber of await db.listBarbers(pool)) {
    for (const period of await db.getWorkingHours(pool, barber.id)) {
      if (period.validFrom > today || (period.validUntil && period.validUntil < today)) continue;
      const day = byDay.get(period.weekday);
      byDay.set(period.weekday, {
        weekday: period.weekday,
        startLocal: day && day.startLocal < period.startLocal ? day.startLocal : period.startLocal,
        endLocal: day && day.endLocal > period.endLocal ? day.endLocal : period.endLocal,
      });
    }
  }
  return [...byDay.values()].sort((a, b) => a.weekday - b.weekday);
}

async function getShop(ctx) {
  await rateLimit(ctx, 'read', clientIp(ctx), 'read');
  const shop = await requireShop(ctx.pool);
  return { status: 200, body: { data: { ...shop, openingHours: await openingHours(ctx.pool, shop.timezone) } } };
}

async function listStaff(ctx) {
  await rateLimit(ctx, 'read', clientIp(ctx), 'read');
  return { status: 200, body: { data: (await db.listBarbers(ctx.pool)).map(publicStaff) } };
}

async function listServices(ctx) {
  await rateLimit(ctx, 'read', clientIp(ctx), 'read');
  return { status: 200, body: { data: await db.listServices(ctx.pool) } };
}

async function adminListStaff(ctx) {
  await requireRole(ctx, ['admin']);
  return { status: 200, body: { data: await db.listBarbers(ctx.pool, { includeInactive: true }) } };
}

async function adminListServices(ctx) {
  await requireRole(ctx, ['admin']);
  return { status: 200, body: { data: await db.listServices(ctx.pool, { includeInactive: true }) } };
}

async function audit(ctx, session, action, entityId) {
  await db.recordAudit(ctx.pool, { actorId: session.staffId, action, entityId });
}

async function updateShop(ctx) {
  await requireCsrf(ctx);
  const session = await requireRole(ctx, ['admin']);
  const body = onlyFields(await readJson(ctx.request),
    ['version', 'name', 'timezone', 'address', 'contactPhone', 'cancelWindowMinutes'], ['version']);
  const shop = await requireShop(ctx.pool);
  const updated = await db.updateShop(ctx.pool, shop.id, body);
  await audit(ctx, session, 'shop.updated', shop.id);
  return { status: 200, body: { data: updated } };
}

async function createService(ctx) {
  await requireCsrf(ctx);
  const session = await requireRole(ctx, ['admin']);
  const body = onlyFields(await readJson(ctx.request),
    ['name', 'description', 'durationMinutes', 'priceCents'], ['name', 'durationMinutes', 'priceCents']);
  const shop = await requireShop(ctx.pool);
  const created = await db.createService(ctx.pool, { ...body, shopId: shop.id });
  await audit(ctx, session, 'service.created', created.id);
  return { status: 201, body: { data: created } };
}

async function updateService(ctx) {
  await requireCsrf(ctx);
  const session = await requireRole(ctx, ['admin']);
  const body = onlyFields(await readJson(ctx.request),
    ['version', 'name', 'description', 'durationMinutes', 'priceCents', 'active', 'sortOrder'], ['version']);
  const updated = await db.updateService(ctx.pool, ctx.params.id, body);
  await audit(ctx, session, 'service.updated', updated.id);
  return { status: 200, body: { data: updated } };
}

async function updateStaff(ctx) {
  await requireCsrf(ctx);
  const session = await requireRole(ctx, ['admin']);
  const body = onlyFields(await readJson(ctx.request), ['version', 'name', 'bio', 'active', 'sortOrder'], ['version']);
  const updated = await db.updateStaff(ctx.pool, ctx.params.id, body);
  await audit(ctx, session, 'staff.updated', updated.id);
  return { status: 200, body: { data: updated } };
}

async function getWorkingHours(ctx) {
  await requireRole(ctx, ['admin']);
  const query = readQuery(ctx.url, ['staffId']);
  if (!query.staffId) throw invalid('staffId', 'obrigatório');
  return { status: 200, body: { data: await db.getWorkingHours(ctx.pool, query.staffId) } };
}

// Substitui o expediente semanal. `version` é aceita por compatibilidade com o contrato, mas a
// camada de dados não versiona o expediente: a proteção real é o 409 quando reservas ficariam fora do horário.
async function replaceWorkingHours(ctx) {
  await requireCsrf(ctx);
  const session = await requireRole(ctx, ['admin']);
  const body = onlyFields(await readJson(ctx.request), ['version', 'periods'], ['periods']);
  if (body.version !== undefined && (!Number.isInteger(body.version) || body.version < 1)) throw invalid('version', 'inteiro >= 1');
  const staff = await db.getStaff(ctx.pool, ctx.params.staffId);
  if (!staff) throw httpError(404, 'NOT_FOUND', 'Profissional não encontrado.');
  const data = await db.replaceWorkingHours(ctx.pool, staff.id, body.periods);
  await audit(ctx, session, 'working_hours.replaced', staff.id);
  return { status: 200, body: { data } };
}

// Período em datas locais [from, to] → instantes [início de from, início de to+1).
export function localRange(shop, query, defaultDays) {
  const from = query.from === undefined ? localToday(shop.timezone) : parseLocalDate(query.from, 'from');
  const to = query.to === undefined ? addDays(from, defaultDays - 1) : parseLocalDate(query.to, 'to');
  if (to < from) throw invalid('to', 'depois de from');
  const start = startOfLocalDay(from, shop.timezone);
  const end = startOfLocalDay(addDays(to, 1), shop.timezone);
  if (end - start > 31 * 24 * 3600 * 1000) throw invalid('to', 'período de até 31 dias');
  return { from: start.toISOString(), to: end.toISOString() };
}

async function listBlocks(ctx) {
  await requireRole(ctx, ['admin']);
  const query = readQuery(ctx.url, ['staffId', 'from', 'to']);
  const range = localRange(await requireShop(ctx.pool), query, 31);
  const data = await db.listBlocks(ctx.pool, { ...range, staffId: query.staffId ?? null });
  return { status: 200, body: { data } };
}

async function createBlock(ctx) {
  await requireCsrf(ctx);
  const session = await requireRole(ctx, ['admin']);
  const body = onlyFields(await readJson(ctx.request), ['staffId', 'startAt', 'endAt', 'reason'], ['staffId', 'startAt', 'endAt']);
  const staff = await db.getStaff(ctx.pool, body.staffId);
  if (!staff) throw httpError(404, 'NOT_FOUND', 'Profissional não encontrado.');
  const created = await db.createBlock(ctx.pool, { ...body, createdBy: session.staffId });
  await audit(ctx, session, 'block.created', created.id);
  return { status: 201, body: { data: created } };
}

async function deleteBlock(ctx) {
  await requireCsrf(ctx);
  const session = await requireRole(ctx, ['admin']);
  const query = readQuery(ctx.url, ['version']);
  intParam(query.version, 'version', 1, 2 ** 31 - 1);
  await db.deleteBlock(ctx.pool, ctx.params.id);
  await audit(ctx, session, 'block.deleted', ctx.params.id);
  return { status: 204 };
}

export const catalogRoutes = [
  ['GET', '/api/shop', getShop],
  ['GET', '/api/staff', listStaff],
  ['GET', '/api/services', listServices],
  ['GET', '/api/admin/staff', adminListStaff],
  ['GET', '/api/admin/services', adminListServices],
  ['PATCH', '/api/admin/shop', updateShop],
  ['POST', '/api/admin/services', createService],
  ['PATCH', '/api/admin/services/:id', updateService],
  ['PATCH', '/api/admin/staff/:id', updateStaff],
  ['GET', '/api/admin/working-hours', getWorkingHours],
  ['PUT', '/api/admin/working-hours/:staffId', replaceWorkingHours],
  ['GET', '/api/admin/blocks', listBlocks],
  ['POST', '/api/admin/blocks', createBlock],
  ['DELETE', '/api/admin/blocks/:id', deleteBlock],
];
