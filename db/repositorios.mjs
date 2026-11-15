// Repositórios do Barber Prime. `db` é um pool ou cliente compatível com `pg` (query(text, values)).
// Funções que precisam de várias instruções atômicas recebem o pool e abrem a própria transação.
// Toda entrada vai como parâmetro ($n); nenhum SQL é montado com texto vindo de fora.
import { timingSafeEqual } from 'node:crypto';
import { dataError, translatePgError } from './erros.mjs';
import { normalizePhoneBR } from './telefone.mjs';
import { transaction } from './transacao.mjs';

// ---------- validação na fronteira de dados ----------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_PERIOD_MS = 31 * 24 * 3600 * 1000;

function invalid(field, reason) {
  return dataError('VALIDATION_ERROR', 'Entrada inválida.', { [field]: reason });
}
function uuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw invalid(field, 'uuid inválido');
  return value.toLowerCase();
}
function text(value, field, min, max) {
  if (typeof value !== 'string') throw invalid(field, 'texto obrigatório');
  const v = value.trim();
  if (v.length < min || v.length > max) throw invalid(field, `comprimento ${min}..${max}`);
  return v;
}
function int(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(field, `inteiro ${min}..${max}`);
  return value;
}
function bool(value, field) {
  if (typeof value !== 'boolean') throw invalid(field, 'booleano');
  return value;
}
function instant(value, field) {
  const ok = value instanceof Date || (typeof value === 'string' && INSTANT_RE.test(value));
  const d = ok ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) throw invalid(field, 'instante ISO 8601 com fuso');
  return d;
}
function localDate(value, field) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw invalid(field, 'data YYYY-MM-DD');
  const d = new Date(`${value}T00:00:00Z`);
  if (d.toISOString().slice(0, 10) !== value) throw invalid(field, 'data inexistente');
  return value;
}
function hash32(value, field) {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw invalid(field, 'hash de 32 bytes');
  return value;
}
function only(input, allowed, field = 'entrada') {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid(field, 'objeto obrigatório');
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw invalid(key, 'campo não permitido');
  return input;
}

// Escopo de acesso: só o dono vê a própria reserva; barbeiro, a própria agenda; admin, tudo.
function scopeFilter(scope, params, alias = 'a') {
  if (scope?.role === 'customer') {
    params.push(uuid(scope.customerId, 'scope.customerId'));
    return `${alias}.customer_id = $${params.length}`;
  }
  if (scope?.role === 'barber') {
    params.push(uuid(scope.staffId, 'scope.staffId'));
    return `${alias}.staff_id = $${params.length}`;
  }
  if (scope?.role === 'admin') return 'TRUE';
  throw dataError('VALIDATION_ERROR', 'Escopo de acesso ausente.');
}

async function run(db, sql, values) {
  try {
    return await db.query(sql, values);
  } catch (err) {
    throw translatePgError(err);
  }
}
async function inTx(pool, fn) {
  try {
    return await transaction(pool, fn);
  } catch (err) {
    throw translatePgError(err);
  }
}

// Instantes saem como texto ISO UTC, independente do driver.
const iso = (col) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ---------- barbearia ----------
const SHOP_COLS = `id, name, timezone, address, contact_phone AS "contactPhone",
  cancel_window_minutes AS "cancelWindowMinutes", version`;

export async function getShop(db) {
  const { rows } = await run(db, `SELECT ${SHOP_COLS} FROM shops ORDER BY created_at LIMIT 1`);
  return rows[0] ?? null;
}

export async function updateShop(db, id, input) {
  only(input, ['version', 'name', 'timezone', 'address', 'contactPhone', 'cancelWindowMinutes']);
  const params = [uuid(id, 'id'), int(input.version, 'version', 1, 2 ** 31 - 1)];
  const sets = [];
  const add = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (input.name !== undefined) add('name', text(input.name, 'name', 1, 100));
  if (input.address !== undefined) add('address', text(input.address, 'address', 0, 300));
  if (input.timezone !== undefined) {
    const tz = text(input.timezone, 'timezone', 1, 64);
    const { rows } = await run(db, 'SELECT 1 FROM pg_timezone_names WHERE name = $1', [tz]);
    if (!rows.length) throw invalid('timezone', 'fuso IANA desconhecido');
    add('timezone', tz);
  }
  if (input.contactPhone !== undefined) {
    const phone = input.contactPhone === null ? null : normalizePhoneBR(input.contactPhone);
    if (input.contactPhone !== null && !phone) throw invalid('contactPhone', 'telefone com DDD');
    add('contact_phone', phone);
  }
  if (input.cancelWindowMinutes !== undefined) add('cancel_window_minutes', int(input.cancelWindowMinutes, 'cancelWindowMinutes', 0, 10080));
  return versionedUpdate(db, 'shops', sets, params, SHOP_COLS);
}

async function versionedUpdate(db, table, sets, params, cols) {
  if (!sets.length) throw invalid('entrada', 'nada para alterar');
  const { rows } = await run(db,
    `UPDATE ${table} SET ${sets.join(', ')}, version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $2 RETURNING ${cols}`, params);
  if (rows.length) return rows[0];
  const exists = await run(db, `SELECT 1 FROM ${table} WHERE id = $1`, [params[0]]);
  throw exists.rows.length
    ? dataError('VERSION_CONFLICT', 'Registro alterado por outra pessoa; recarregue.')
    : dataError('NOT_FOUND', 'Registro não encontrado.');
}

// ---------- equipe ----------
const STAFF_COLS = 'id, name, role, bio, active, sort_order AS "sortOrder", version';

export async function listBarbers(db, { includeInactive = false } = {}) {
  const { rows } = await run(db,
    `SELECT ${STAFF_COLS} FROM staff WHERE role = 'barber' AND (active OR $1) ORDER BY sort_order, name`,
    [bool(includeInactive, 'includeInactive')]);
  return rows;
}

export async function updateStaff(db, id, input) {
  only(input, ['version', 'name', 'bio', 'active', 'sortOrder']);
  const params = [uuid(id, 'id'), int(input.version, 'version', 1, 2 ** 31 - 1)];
  const sets = [];
  const add = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (input.name !== undefined) add('name', text(input.name, 'name', 2, 100));
  if (input.bio !== undefined) add('bio', text(input.bio, 'bio', 0, 300));
  if (input.active !== undefined) add('active', bool(input.active, 'active'));
  if (input.sortOrder !== undefined) add('sort_order', int(input.sortOrder, 'sortOrder', 0, 1000));
  return versionedUpdate(db, 'staff', sets, params, STAFF_COLS);
}

// Credencial da equipe: recebe hash já calculado (scrypt/Argon2id) pelo backend; nunca senha em texto.
export async function setStaffCredentials(db, id, { login, passwordHash }) {
  const normalized = text(login, 'login', 3, 100).toLowerCase();
  if (!/^[a-z0-9._-]{3,100}$/.test(normalized)) throw invalid('login', 'letras, números, . _ -');
  const { rowCount } = await run(db,
    'UPDATE staff SET login = $2, password_hash = $3, version = version + 1, updated_at = now() WHERE id = $1',
    [uuid(id, 'id'), normalized, text(passwordHash, 'passwordHash', 20, 512)]);
  if (!rowCount) throw dataError('NOT_FOUND', 'Registro não encontrado.');
  await run(db, 'UPDATE sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [id]);
}

export async function createStaff(db, input) {
  only(input, ['shopId', 'name', 'role', 'bio']);
  if (!['barber', 'admin'].includes(input.role)) throw invalid('role', 'barber|admin');
  const { rows } = await run(db,
    `INSERT INTO staff (shop_id, name, role, bio, sort_order)
     VALUES ($1, $2, $3, $4, (SELECT coalesce(max(sort_order), 0) + 1 FROM staff)) RETURNING ${STAFF_COLS}`,
    [uuid(input.shopId, 'shopId'), text(input.name, 'name', 2, 100), input.role, text(input.bio ?? '', 'bio', 0, 300)]);
  return rows[0];
}

export async function findStaffForLogin(db, login) {
  if (typeof login !== 'string' || login.length > 100) return null;
  const { rows } = await run(db,
    `SELECT id, name, role, password_hash AS "passwordHash" FROM staff
     WHERE login = $1 AND active AND password_hash IS NOT NULL`, [login.trim().toLowerCase()]);
  return rows[0] ?? null;
}

export async function getStaff(db, id) {
  const { rows } = await run(db, `SELECT ${STAFF_COLS} FROM staff WHERE id = $1`, [uuid(id, 'id')]);
  return rows[0] ?? null;
}

// ---------- serviços ----------
const SERVICE_COLS = `id, name, description, duration_minutes AS "durationMinutes", price_cents AS "priceCents",
  active, sort_order AS "sortOrder", version`;

export async function listServices(db, { includeInactive = false } = {}) {
  const { rows } = await run(db,
    `SELECT ${SERVICE_COLS} FROM services WHERE active OR $1 ORDER BY sort_order, name`,
    [bool(includeInactive, 'includeInactive')]);
  return rows;
}

export async function createService(db, input) {
  only(input, ['shopId', 'name', 'description', 'durationMinutes', 'priceCents']);
  const { rows } = await run(db,
    `INSERT INTO services (shop_id, name, description, duration_minutes, price_cents, sort_order)
     VALUES ($1, $2, $3, $4, $5, (SELECT coalesce(max(sort_order), 0) + 1 FROM services)) RETURNING ${SERVICE_COLS}`,
    [uuid(input.shopId, 'shopId'), text(input.name, 'name', 2, 100), text(input.description ?? '', 'description', 0, 300),
      int(input.durationMinutes, 'durationMinutes', 5, 480), int(input.priceCents, 'priceCents', 0, 1000000)]);
  return rows[0];
}

// Alterar preço/duração não muda reservas existentes: elas guardam o snapshot.
export async function updateService(db, id, input) {
  only(input, ['version', 'name', 'description', 'durationMinutes', 'priceCents', 'active', 'sortOrder']);
  const params = [uuid(id, 'id'), int(input.version, 'version', 1, 2 ** 31 - 1)];
  const sets = [];
  const add = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (input.name !== undefined) add('name', text(input.name, 'name', 2, 100));
  if (input.description !== undefined) add('description', text(input.description, 'description', 0, 300));
  if (input.durationMinutes !== undefined) add('duration_minutes', int(input.durationMinutes, 'durationMinutes', 5, 480));
  if (input.priceCents !== undefined) add('price_cents', int(input.priceCents, 'priceCents', 0, 1000000));
  if (input.active !== undefined) add('active', bool(input.active, 'active'));
  if (input.sortOrder !== undefined) add('sort_order', int(input.sortOrder, 'sortOrder', 0, 1000));
  return versionedUpdate(db, 'services', sets, params, SERVICE_COLS);
}

// ---------- expediente ----------
export async function getWorkingHours(db, staffId) {
  const { rows } = await run(db,
    `SELECT id, staff_id AS "staffId", weekday, to_char(start_local, 'HH24:MI') AS "startLocal",
       to_char(end_local, 'HH24:MI') AS "endLocal", valid_from::text AS "validFrom", valid_until::text AS "validUntil", version
     FROM working_hours WHERE staff_id = $1 ORDER BY weekday, start_local`, [uuid(staffId, 'staffId')]);
  return rows;
}

// Reserva confirmada futura fora do expediente do seu dia local (SQL reutilizado).
const OUTSIDE_HOURS = `NOT EXISTS (
  SELECT 1 FROM working_hours wh
  WHERE wh.staff_id = %STAFF%
    AND wh.weekday = extract(dow FROM (%START% AT TIME ZONE %TZ%))::int
    AND (%START% AT TIME ZONE %TZ%)::date BETWEEN wh.valid_from AND coalesce(wh.valid_until, 'infinity'::date)
    AND (%START% AT TIME ZONE %TZ%)::time >= wh.start_local
    AND (%END% AT TIME ZONE %TZ%) <= (%START% AT TIME ZONE %TZ%)::date + wh.end_local)`;
const outsideHours = (staff, start, end, tz) =>
  OUTSIDE_HOURS.replaceAll('%STAFF%', staff).replaceAll('%START%', start).replaceAll('%END%', end).replaceAll('%TZ%', tz);

// Substitui o expediente semanal; recusa (409) se deixar reserva confirmada futura fora do horário.
export async function replaceWorkingHours(pool, staffId, entries, { now = new Date() } = {}) {
  const id = uuid(staffId, 'staffId');
  if (!Array.isArray(entries) || entries.length > 28) throw invalid('entries', 'lista de até 28 turnos');
  const clean = entries.map((e, i) => {
    only(e, ['weekday', 'startLocal', 'endLocal', 'validFrom', 'validUntil'], `entries[${i}]`);
    if (!TIME_RE.test(e.startLocal ?? '') || !TIME_RE.test(e.endLocal ?? '')) throw invalid(`entries[${i}]`, 'HH:mm');
    if (e.endLocal <= e.startLocal) throw invalid(`entries[${i}]`, 'fim depois do início');
    return [int(e.weekday, `entries[${i}].weekday`, 0, 6), e.startLocal, e.endLocal,
      e.validFrom === undefined ? '2000-01-01' : localDate(e.validFrom, `entries[${i}].validFrom`),
      e.validUntil == null ? null : localDate(e.validUntil, `entries[${i}].validUntil`)];
  });
  return inTx(pool, async (tx) => {
    const staff = await tx.query('SELECT id FROM staff WHERE id = $1 FOR UPDATE', [id]);
    if (!staff.rows.length) throw dataError('NOT_FOUND', 'Profissional não encontrado.');
    await tx.query('DELETE FROM working_hours WHERE staff_id = $1', [id]);
    for (const values of clean) {
      await tx.query(
        'INSERT INTO working_hours (staff_id, weekday, start_local, end_local, valid_from, valid_until) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, ...values]);
    }
    const { rows } = await tx.query(
      `SELECT count(*)::int AS n FROM appointments a JOIN staff st ON st.id = a.staff_id JOIN shops sh ON sh.id = st.shop_id
       WHERE a.staff_id = $1 AND a.status = 'confirmed' AND a.start_at > $2
         AND ${outsideHours('a.staff_id', 'a.start_at', 'a.end_at', 'sh.timezone')}`,
      [id, instant(now, 'now')]);
    if (rows[0].n > 0) {
      throw dataError('SCHEDULE_CONFLICT', `Há ${rows[0].n} reserva(s) confirmada(s) fora do novo expediente.`);
    }
    return getWorkingHours(tx, id);
  });
}

// ---------- clientes ----------
// Cadastro sem duplicar telefone. Telefone já cadastrado NÃO devolve o cliente existente:
// o chamador responde de forma genérica e exige prova de posse (challenges).
export async function registerCustomer(db, input) {
  only(input, ['name', 'phone']);
  const name = text(input.name, 'name', 2, 100);
  const phone = normalizePhoneBR(input.phone);
  if (!phone) throw invalid('phone', 'telefone brasileiro com DDD');
  const { rows } = await run(db,
    `INSERT INTO customers (name, phone) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING
     RETURNING id, name, ${iso('created_at')} AS "createdAt", version`, [name, phone]);
  return rows.length ? { created: true, customer: rows[0] } : { created: false, customer: null };
}

// Uso interno do fluxo de prova de posse; nunca expor o resultado ao solicitante.
export async function findCustomerIdByPhone(db, phoneInput) {
  const phone = normalizePhoneBR(phoneInput);
  if (!phone) return null;
  const { rows } = await run(db, 'SELECT id FROM customers WHERE phone = $1', [phone]);
  return rows[0]?.id ?? null;
}

export async function getCustomer(db, id) {
  const { rows } = await run(db,
    `SELECT id, name, phone, ${iso('phone_verified_at')} AS "phoneVerifiedAt", ${iso('created_at')} AS "createdAt", version
     FROM customers WHERE id = $1`, [uuid(id, 'id')]);
  return rows[0] ?? null;
}

// ---------- disponibilidade ----------
export async function listAvailability(db, { staffId, serviceId, date, stepMinutes = 15, now = new Date() }) {
  const params = [uuid(staffId, 'staffId'), uuid(serviceId, 'serviceId')];
  const ctx = await run(db,
    `SELECT sh.timezone, sv.duration_minutes AS dur FROM staff st
     JOIN shops sh ON sh.id = st.shop_id
     JOIN services sv ON sv.id = $2 AND sv.active AND sv.shop_id = st.shop_id
     WHERE st.id = $1 AND st.active AND st.role = 'barber'`, params);
  if (!ctx.rows.length) throw dataError('NOT_FOUND', 'Profissional ou serviço não encontrado.');
  const { rows } = await run(db,
    `WITH win AS (
       SELECT (($3::date + wh.start_local) AT TIME ZONE $6::text) AS ws, (($3::date + wh.end_local) AT TIME ZONE $6::text) AS we
       FROM working_hours wh
       WHERE wh.staff_id = $1 AND EXISTS (SELECT 1 FROM services sv WHERE sv.id = $2 AND sv.active) AND wh.weekday = extract(dow FROM $3::date)::int
         AND $3::date BETWEEN wh.valid_from AND coalesce(wh.valid_until, 'infinity'::date)
     ), slots AS (
       SELECT g AS s, g + make_interval(mins => $7::int) AS e
       FROM win, generate_series(win.ws, win.we - make_interval(mins => $7::int), make_interval(mins => $4::int)) g
     )
     SELECT ${iso('s')} AS "startAt", ${iso('e')} AS "endAt" FROM slots
     WHERE s > $5::timestamptz AND NOT EXISTS (
       SELECT 1 FROM occupations o WHERE o.staff_id = $1 AND o.period && tstzrange(slots.s, slots.e, '[)'))
     ORDER BY s`,
    [...params, localDate(date, 'date'), int(stepMinutes, 'stepMinutes', 5, 120), instant(now, 'now'),
      ctx.rows[0].timezone, ctx.rows[0].dur]);
  return { staffId: params[0], serviceId: params[1], date, timezone: ctx.rows[0].timezone, slots: rows };
}

// ---------- reservas ----------
const APPT_COLS = `a.id, a.customer_id AS "customerId", a.staff_id AS "staffId", a.service_id AS "serviceId",
  ${iso('a.start_at')} AS "startAt", ${iso('a.end_at')} AS "endAt", a.duration_minutes AS "durationMinutes",
  a.price_cents AS "priceCents", a.status, a.notes, a.version, ${iso('a.created_at')} AS "createdAt",
  st.name AS "staffName", sv.name AS "serviceName"`;
const APPT_FROM = 'appointments a JOIN staff st ON st.id = a.staff_id JOIN services sv ON sv.id = a.service_id';

async function fetchAppointment(db, id, scope) {
  const params = [id];
  const where = scopeFilter(scope, params);
  const customerCol = scope.role === 'customer' ? '' : ', c.name AS "customerName"' + (scope.role === 'admin' ? ', c.phone AS "customerPhone"' : '');
  const { rows } = await db.query(
    `SELECT ${APPT_COLS}${customerCol} FROM ${APPT_FROM} JOIN customers c ON c.id = a.customer_id
     WHERE a.id = $1 AND ${where}`, params);
  return rows[0] ?? null;
}

export async function getAppointment(db, id, scope) {
  try {
    return await fetchAppointment(db, uuid(id, 'id'), scope);
  } catch (err) {
    throw translatePgError(err);
  }
}

// Confere barbeiro ativo, expediente e horário futuro; trava o barbeiro em modo compartilhado
// para não correr com replaceWorkingHours.
async function checkSlot(tx, staffId, start, end, now) {
  const { rows } = await tx.query(
    `SELECT sh.timezone, ${outsideHours('st.id', '$2::timestamptz', '$3::timestamptz', 'sh.timezone')} AS outside
     FROM staff st JOIN shops sh ON sh.id = st.shop_id
     WHERE st.id = $1 AND st.active AND st.role = 'barber' FOR SHARE OF st`, [staffId, start, end]);
  if (!rows.length) throw dataError('NOT_FOUND', 'Profissional não encontrado.');
  if (start <= now) throw dataError('BUSINESS_RULE', 'O horário precisa ser no futuro.');
  if (rows[0].outside === true || rows[0].outside === 't') {
    throw dataError('BUSINESS_RULE', 'Horário fora do expediente do profissional.');
  }
}

async function enqueue(tx, topic, dedupeKey, payload) {
  await tx.query(
    'INSERT INTO outbox (topic, dedupe_key, payload) VALUES ($1, $2, $3) ON CONFLICT (dedupe_key) DO NOTHING',
    [topic, dedupeKey, JSON.stringify(payload)]);
}

/**
 * Cria reserva confirmada. Preço e duração são copiados do serviço (snapshot).
 * Com idempotencyKey: mesmo corpo devolve a reserva já criada (replayed=true); corpo diferente → 409.
 */
export async function createAppointment(pool, input, { now = new Date() } = {}) {
  only(input, ['customerId', 'staffId', 'serviceId', 'startAt', 'notes', 'idempotencyKey', 'requestHash', 'principalId']);
  const customerId = uuid(input.customerId, 'customerId');
  const staffId = uuid(input.staffId, 'staffId');
  const serviceId = uuid(input.serviceId, 'serviceId');
  const start = instant(input.startAt, 'startAt');
  const notes = text(input.notes ?? '', 'notes', 0, 500);
  const nowAt = instant(now, 'now');
  let key = null;
  if (input.idempotencyKey !== undefined) {
    key = text(input.idempotencyKey, 'idempotencyKey', 16, 128);
    hash32(input.requestHash, 'requestHash');
  }
  const principal = key ? uuid(input.principalId ?? customerId, 'principalId') : null;

  return inTx(pool, async (tx) => {
    if (key) {
      const ins = await tx.query(
        `INSERT INTO idempotency_keys (principal_id, key, request_hash) VALUES ($1, $2, $3)
         ON CONFLICT (principal_id, key) DO NOTHING RETURNING key`, [principal, key, input.requestHash]);
      if (!ins.rows.length) {
        const { rows } = await tx.query(
          `SELECT request_hash, appointment_id FROM idempotency_keys
           WHERE principal_id = $1 AND key = $2 AND created_at > $3::timestamptz - interval '24 hours'`, [principal, key, nowAt]);
        const prev = rows[0];
        const same = prev && Buffer.from(prev.request_hash).equals(input.requestHash);
        if (!same || !prev.appointment_id) throw dataError('IDEMPOTENCY_CONFLICT', 'Chave de idempotência já usada com outro pedido.');
        return { appointment: await fetchAppointment(tx, prev.appointment_id, { role: 'admin' }), replayed: true };
      }
    }
    const svc = await tx.query('SELECT duration_minutes, price_cents FROM services WHERE id = $1 AND active', [serviceId]);
    if (!svc.rows.length) throw dataError('NOT_FOUND', 'Serviço não encontrado.');
    const { duration_minutes: dur, price_cents: price } = svc.rows[0];
    const end = new Date(start.getTime() + dur * 60_000);
    await checkSlot(tx, staffId, start, end, nowAt);
    const cust = await tx.query('SELECT 1 FROM customers WHERE id = $1', [customerId]);
    if (!cust.rows.length) throw dataError('NOT_FOUND', 'Cliente não encontrado.');
    const { rows } = await tx.query(
      `INSERT INTO appointments (customer_id, staff_id, service_id, start_at, end_at, duration_minutes, price_cents, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [customerId, staffId, serviceId, start, end, dur, price, notes]);
    const id = rows[0].id;
    if (key) await tx.query('UPDATE idempotency_keys SET appointment_id = $3 WHERE principal_id = $1 AND key = $2', [principal, key, id]);
    await enqueue(tx, 'appointment.confirmed', `appointment.confirmed:${id}`, { appointmentId: id });
    return { appointment: await fetchAppointment(tx, id, { role: 'admin' }), replayed: false };
  });
}

export async function listAppointmentsForCustomer(db, customerId, { limit = 25 } = {}) {
  const { rows } = await run(db,
    `SELECT ${APPT_COLS} FROM ${APPT_FROM} WHERE a.customer_id = $1 ORDER BY a.start_at DESC LIMIT $2`,
    [uuid(customerId, 'customerId'), int(limit, 'limit', 1, 100)]);
  return rows;
}

// Agenda por período (até 31 dias). Barbeiro só vê a própria; admin pode filtrar por staffId.
export async function listAgenda(db, scope, { from, to, staffId = null, includeCancelled = false }) {
  const start = instant(from, 'from');
  const end = instant(to, 'to');
  if (end <= start || end - start > MAX_PERIOD_MS) throw invalid('to', 'período de até 31 dias');
  if (scope?.role === 'customer') throw dataError('VALIDATION_ERROR', 'Escopo de acesso inválido.');
  const params = [start, end, bool(includeCancelled, 'includeCancelled')];
  const where = scopeFilter(scope, params);
  let staffFilter = 'TRUE';
  if (staffId !== null) { params.push(uuid(staffId, 'staffId')); staffFilter = `a.staff_id = $${params.length}`; }
  const phone = scope.role === 'admin' ? ', c.phone AS "customerPhone"' : '';
  const { rows } = await run(db,
    `SELECT ${APPT_COLS}, c.name AS "customerName"${phone} FROM ${APPT_FROM} JOIN customers c ON c.id = a.customer_id
     WHERE a.start_at < $2 AND a.end_at > $1 AND (a.status <> 'cancelled' OR $3) AND ${where} AND ${staffFilter}
     ORDER BY a.start_at, st.sort_order LIMIT 2000`, params);
  return rows;
}

async function lockAppointment(tx, id, scope) {
  const params = [uuid(id, 'id')];
  const where = scopeFilter(scope, params);
  const { rows } = await tx.query(
    `SELECT a.id, a.status, a.version, a.start_at, a.staff_id, a.duration_minutes, sh.cancel_window_minutes AS window
     FROM appointments a JOIN staff st ON st.id = a.staff_id JOIN shops sh ON sh.id = st.shop_id
     WHERE a.id = $1 AND ${where} FOR UPDATE OF a`, params);
  if (!rows.length) throw dataError('NOT_FOUND', 'Reserva não encontrada.');
  return rows[0];
}

function withinCustomerWindow(row, scope, nowAt) {
  if (scope.role !== 'customer') return;
  const limit = new Date(row.start_at).getTime() - row.window * 60_000;
  if (nowAt.getTime() > limit) throw dataError('BUSINESS_RULE', 'Prazo para alterar esta reserva encerrado.');
}

// Reagenda. Se o novo horário conflitar, a transação desfaz tudo e a reserva original permanece.
export async function rescheduleAppointment(pool, id, scope, input, { now = new Date() } = {}) {
  only(input, ['version', 'startAt', 'staffId']);
  const version = int(input.version, 'version', 1, 2 ** 31 - 1);
  const start = instant(input.startAt, 'startAt');
  const nowAt = instant(now, 'now');
  return inTx(pool, async (tx) => {
    const row = await lockAppointment(tx, id, scope);
    if (row.version !== version) throw dataError('VERSION_CONFLICT', 'Reserva alterada por outra pessoa; recarregue.');
    if (row.status !== 'confirmed') throw dataError('BUSINESS_RULE', 'Só reservas confirmadas podem ser reagendadas.');
    withinCustomerWindow(row, scope, nowAt);
    const staffId = input.staffId === undefined ? row.staff_id : uuid(input.staffId, 'staffId');
    if (scope.role === 'barber' && staffId !== uuid(scope.staffId, 'scope.staffId')) throw dataError('BUSINESS_RULE', 'Barbeiro só reagenda na própria agenda.');
    const end = new Date(start.getTime() + row.duration_minutes * 60_000);
    await checkSlot(tx, staffId, start, end, nowAt);
    await tx.query(
      `UPDATE appointments SET staff_id = $2, start_at = $3, end_at = $4, version = version + 1, updated_at = now()
       WHERE id = $1`, [row.id, staffId, start, end]);
    await enqueue(tx, 'appointment.rescheduled', `appointment.rescheduled:${row.id}:${version + 1}`, { appointmentId: row.id });
    return fetchAppointment(tx, row.id, scope);
  });
}

// Cancela e libera o horário na mesma transação. Repetir o cancelamento devolve o estado atual.
export async function cancelAppointment(pool, id, scope, { now = new Date() } = {}) {
  const nowAt = instant(now, 'now');
  return inTx(pool, async (tx) => {
    const row = await lockAppointment(tx, id, scope);
    if (row.status === 'cancelled') return fetchAppointment(tx, row.id, scope);
    if (row.status !== 'confirmed') throw dataError('BUSINESS_RULE', 'Atendimento encerrado não pode ser cancelado.');
    withinCustomerWindow(row, scope, nowAt);
    await tx.query(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = $2, version = version + 1, updated_at = now()
       WHERE id = $1`, [row.id, nowAt]);
    await enqueue(tx, 'appointment.cancelled', `appointment.cancelled:${row.id}`, { appointmentId: row.id });
    return fetchAppointment(tx, row.id, scope);
  });
}

// Barbeiro/admin marcam atendimento concluído ou falta.
export async function setAppointmentStatus(pool, id, scope, input) {
  only(input, ['version', 'status']);
  if (scope?.role !== 'barber' && scope?.role !== 'admin') throw dataError('VALIDATION_ERROR', 'Escopo de acesso inválido.');
  if (!['completed', 'no_show'].includes(input.status)) throw invalid('status', 'completed|no_show');
  const version = int(input.version, 'version', 1, 2 ** 31 - 1);
  return inTx(pool, async (tx) => {
    const row = await lockAppointment(tx, id, scope);
    if (row.version !== version) throw dataError('VERSION_CONFLICT', 'Reserva alterada por outra pessoa; recarregue.');
    if (row.status !== 'confirmed') throw dataError('BUSINESS_RULE', 'Transição de status não permitida.');
    await tx.query('UPDATE appointments SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [row.id, input.status]);
    return fetchAppointment(tx, row.id, scope);
  });
}

// ---------- bloqueios ----------
const BLOCK_COLS = `id, staff_id AS "staffId", ${iso('start_at')} AS "startAt", ${iso('end_at')} AS "endAt", reason, version`;

// Bloqueio que colide com reserva ou outro bloqueio → SLOT_CONFLICT (409); nada é cancelado em silêncio.
export async function createBlock(db, input) {
  only(input, ['staffId', 'startAt', 'endAt', 'reason', 'createdBy']);
  const start = instant(input.startAt, 'startAt');
  const end = instant(input.endAt, 'endAt');
  if (end <= start || end - start > MAX_PERIOD_MS) throw invalid('endAt', 'depois do início, até 31 dias');
  const { rows } = await run(db,
    `INSERT INTO blocks (staff_id, start_at, end_at, reason, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING ${BLOCK_COLS}`,
    [uuid(input.staffId, 'staffId'), start, end, text(input.reason ?? '', 'reason', 0, 200),
      input.createdBy == null ? null : uuid(input.createdBy, 'createdBy')]);
  return rows[0];
}

export async function listBlocks(db, { from, to, staffId = null }) {
  const start = instant(from, 'from');
  const end = instant(to, 'to');
  if (end <= start || end - start > MAX_PERIOD_MS) throw invalid('to', 'período de até 31 dias');
  const { rows } = await run(db,
    `SELECT ${BLOCK_COLS} FROM blocks WHERE start_at < $2 AND end_at > $1 AND ($3::uuid IS NULL OR staff_id = $3)
     ORDER BY start_at`, [start, end, staffId === null ? null : uuid(staffId, 'staffId')]);
  return rows;
}

export async function deleteBlock(db, id) {
  const { rowCount } = await run(db, 'DELETE FROM blocks WHERE id = $1', [uuid(id, 'id')]);
  if (!rowCount) throw dataError('NOT_FOUND', 'Bloqueio não encontrado.');
}

// ---------- sessões ----------
// tokenHash/csrfHash: SHA-256 (32 bytes) do valor aleatório; o token puro nunca é gravado.
export async function createSession(db, { tokenHash, role, customerId = null, staffId = null, csrfHash = null, ttlSeconds = 7 * 24 * 3600 }) {
  if (!['anonymous', 'customer', 'barber', 'admin'].includes(role)) throw invalid('role', 'papel inválido');
  const { rows } = await run(db,
    `INSERT INTO sessions (token_hash, role, customer_id, staff_id, csrf_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) RETURNING id, role, ${iso('expires_at')} AS "expiresAt"`,
    [hash32(tokenHash, 'tokenHash'), role, customerId === null ? null : uuid(customerId, 'customerId'),
      staffId === null ? null : uuid(staffId, 'staffId'), csrfHash === null ? null : hash32(csrfHash, 'csrfHash'),
      int(ttlSeconds, 'ttlSeconds', 60, 30 * 24 * 3600)]);
  return rows[0];
}

// Sessão válida (não expirada, não revogada, dentro da inatividade); atualiza last_seen_at.
export async function findActiveSession(db, tokenHash, { idleSeconds = 12 * 3600 } = {}) {
  if (!Buffer.isBuffer(tokenHash) || tokenHash.length !== 32) return null;
  const { rows } = await run(db,
    `UPDATE sessions SET last_seen_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       AND last_seen_at > now() - make_interval(secs => $2)
     RETURNING id, role, customer_id AS "customerId", staff_id AS "staffId", csrf_hash AS "csrfHash"`,
    [tokenHash, int(idleSeconds, 'idleSeconds', 60, 30 * 24 * 3600)]);
  const s = rows[0];
  if (s?.csrfHash) s.csrfHash = Buffer.from(s.csrfHash);
  return s ?? null;
}

export async function setSessionCsrf(db, sessionId, csrfHash) {
  await run(db, 'UPDATE sessions SET csrf_hash = $2 WHERE id = $1', [uuid(sessionId, 'sessionId'), hash32(csrfHash, 'csrfHash')]);
}

export async function revokeSession(db, sessionId) {
  await run(db, 'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [uuid(sessionId, 'sessionId')]);
}

// ---------- prova de posse do telefone ----------
// Dois limites diários, persistentes e válidos entre instâncias:
// - pedidos por telefone + solicitante (spam de SMS); pedir código nunca consome a cota de outro solicitante;
// - palpites ERRADOS por telefone, somados entre todos os desafios: 50 em 24 h (~0,15% de acerto em
//   30 dias para 6 dígitos). Só errar o código consome essa cota; pedir códigos, não.
// - pedidos por telefone, somando todos os solicitantes (custo e assédio por SMS): 20 em 24 h. Vale
//   também quando o chamador não informa o solicitante.
export const CHALLENGES_PER_REQUESTER_PER_DAY = 5;
export const CHALLENGES_PER_PHONE_PER_DAY = 20;
export const WRONG_GUESSES_PER_PHONE_PER_DAY = 50;

const lockPhone = (tx, phone) =>
  tx.query("SELECT pg_advisory_xact_lock(hashtextextended(encode($1, 'hex'), 7))", [phone]);

async function wrongGuesses(tx, phone) {
  const { rows: [{ n }] } = await tx.query(
    `SELECT coalesce(sum(attempts - CASE WHEN consumed_at IS NULL THEN 0 ELSE 1 END), 0)::int AS n
     FROM challenges WHERE phone_hash = $1 AND created_at > now() - interval '24 hours'`, [phone]);
  return n;
}

export async function createChallenge(pool, {
  phoneHash, customerId = null, codeHash, ttlSeconds = 300, requesterHash = null,
  maxPerDay = CHALLENGES_PER_REQUESTER_PER_DAY, maxPerPhonePerDay = CHALLENGES_PER_PHONE_PER_DAY,
  maxWrongPerDay = WRONG_GUESSES_PER_PHONE_PER_DAY,
}) {
  const phone = hash32(phoneHash, 'phoneHash');
  const requester = requesterHash === null ? null : hash32(requesterHash, 'requesterHash');
  const values = [phone, customerId === null ? null : uuid(customerId, 'customerId'),
    hash32(codeHash, 'codeHash'), int(ttlSeconds, 'ttlSeconds', 60, 900), requester];
  const max = int(maxPerDay, 'maxPerDay', 1, 100);
  const maxWrong = int(maxWrongPerDay, 'maxWrongPerDay', 1, 1000);
  const maxPhone = int(maxPerPhonePerDay, 'maxPerPhonePerDay', 1, 1000);
  return inTx(pool, async (tx) => {
    // Serializa por telefone para pedidos simultâneos não furarem os limites.
    await lockPhone(tx, phone);
    if (await wrongGuesses(tx, phone) >= maxWrong) {
      throw dataError('RATE_LIMITED', 'Muitas tentativas para este telefone. Tente mais tarde.');
    }
    const { rows: [{ total }] } = await tx.query(
      "SELECT count(*)::int AS total FROM challenges WHERE phone_hash = $1 AND created_at > now() - interval '24 hours'", [phone]);
    if (total >= maxPhone) throw dataError('RATE_LIMITED', 'Limite diário de códigos atingido.');
    // Cota menor por solicitante: um único solicitante não esgota sozinho a cota do telefone.
    if (requester) {
      const { rows: [{ n }] } = await tx.query(
        `SELECT count(*)::int AS n FROM challenges
         WHERE phone_hash = $1 AND requester_hash = $2 AND created_at > now() - interval '24 hours'`,
        [phone, requester]);
      if (n >= max) throw dataError('RATE_LIMITED', 'Limite diário de códigos atingido.');
    }
    const { rows } = await tx.query(
      `INSERT INTO challenges (phone_hash, customer_id, code_hash, expires_at, requester_hash)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5) RETURNING id`, values);
    return rows[0].id;
  });
}

// Verifica o código (hash) com no máximo 5 tentativas, uso único e dentro da cota diária de palpites
// errados do telefone. Retorna customerId ou null.
export async function verifyChallenge(pool, challengeId, codeHash, { maxWrongPerDay = WRONG_GUESSES_PER_PHONE_PER_DAY } = {}) {
  if (typeof challengeId !== 'string' || !UUID_RE.test(challengeId)) return null;
  hash32(codeHash, 'codeHash');
  const maxWrong = int(maxWrongPerDay, 'maxWrongPerDay', 1, 1000);
  return inTx(pool, async (tx) => {
    const { rows: [target] } = await tx.query('SELECT phone_hash FROM challenges WHERE id = $1', [challengeId]);
    if (!target) return null;
    const phone = Buffer.from(target.phone_hash);
    await lockPhone(tx, phone);
    if (await wrongGuesses(tx, phone) >= maxWrong) return null;
    const { rows } = await tx.query(
      `UPDATE challenges SET attempts = attempts + 1
       WHERE id = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < 5
       RETURNING code_hash, customer_id`, [challengeId]);
    if (!rows.length) return null;
    const ok = timingSafeEqual(Buffer.from(rows[0].code_hash), codeHash);
    if (!ok || !rows[0].customer_id) return null;
    await tx.query('UPDATE challenges SET consumed_at = now() WHERE id = $1', [challengeId]);
    await tx.query('UPDATE customers SET phone_verified_at = coalesce(phone_verified_at, now()) WHERE id = $1', [rows[0].customer_id]);
    return rows[0].customer_id;
  });
}

// ---------- limite de requisições persistente ----------
export async function hitRateLimit(db, bucket, { windowSeconds, max, now = new Date() }) {
  const b = text(bucket, 'bucket', 1, 200);
  const w = int(windowSeconds, 'windowSeconds', 1, 86400);
  const m = int(max, 'max', 1, 100000);
  const t = instant(now, 'now').getTime();
  const windowStart = new Date(Math.floor(t / (w * 1000)) * w * 1000);
  const { rows } = await run(db,
    `INSERT INTO rate_limits (bucket, window_start) VALUES ($1, $2)
     ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits`, [b, windowStart]);
  const allowed = rows[0].hits <= m;
  return { allowed, retryAfterSeconds: allowed ? 0 : Math.ceil((windowStart.getTime() + w * 1000 - t) / 1000) };
}

// ---------- outbox ----------
// Reserva até `limit` mensagens pendentes para envio; SKIP LOCKED permite vários workers.
export async function claimOutbox(pool, { limit = 10, retryAfterSeconds = 60 } = {}) {
  return inTx(pool, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE outbox SET attempts = attempts + 1, available_at = now() + make_interval(secs => $2)
       WHERE id IN (SELECT id FROM outbox WHERE sent_at IS NULL AND available_at <= now() AND attempts < 10
                    ORDER BY available_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, topic, payload, attempts`,
      [int(limit, 'limit', 1, 100), int(retryAfterSeconds, 'retryAfterSeconds', 1, 86400)]);
    return rows.map((r) => ({ ...r, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload }));
  });
}

export async function markOutboxSent(db, id) {
  await run(db, 'UPDATE outbox SET sent_at = now(), last_error = NULL WHERE id = $1', [uuid(id, 'id')]);
}

export async function markOutboxFailed(db, id, reason) {
  await run(db, 'UPDATE outbox SET last_error = $2 WHERE id = $1', [uuid(id, 'id'), String(reason ?? '').slice(0, 500)]);
}

// ---------- auditoria e limpeza ----------
export async function recordAudit(db, { actorId = null, action, entityId = null }) {
  await run(db, 'INSERT INTO audit_events (actor_id, action, entity_id) VALUES ($1, $2, $3)',
    [actorId === null ? null : uuid(actorId, 'actorId'), text(action, 'action', 1, 100),
      entityId === null ? null : uuid(entityId, 'entityId')]);
}

export async function purgeExpired(db) {
  const out = {};
  for (const [name, sql] of [
    ['sessions', "DELETE FROM sessions WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'"],
    ['challenges', "DELETE FROM challenges WHERE expires_at < now() - interval '1 day'"],
    ['idempotencyKeys', "DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'"],
    ['rateLimits', "DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'"],
  ]) {
    out[name] = (await run(db, sql)).rowCount;
  }
  return out;
}
