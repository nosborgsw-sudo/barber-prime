// Rotas de autenticação: CSRF, cadastro de cliente, prova de posse do telefone, login da equipe e sessão.
import { randomInt } from 'node:crypto';
import * as db from '../../db/index.mjs';
import { httpError, invalid, onlyFields, readJson } from '../http.mjs';
import {
  clearSessionCookie, clientIp, codeHash, hashPassword, issueSession, loadSession, phoneHash, rateLimit,
  refreshCsrf, requireCsrf, requireRole, verifyPassword,
} from './seguranca.mjs';

const REGISTER_MESSAGE = 'Solicitação recebida. Continue no dispositivo ou verifique a posse do telefone.';
const CHALLENGE_MESSAGE = 'Se possível, enviaremos as instruções.';
const CHALLENGE_TTL_SECONDS = 300;

function stringField(value, field, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw invalid(field, `texto ${min}..${max}`);
  return value;
}

async function csrf(ctx) {
  await rateLimit(ctx, 'csrf', clientIp(ctx), 'read');
  return { status: 200, body: { data: { csrfToken: await refreshCsrf(ctx) } } };
}

// Cadastro pede só nome e telefone. Telefone já cadastrado recebe a MESMA resposta e só uma sessão anônima:
// acesso a cadastro existente só com prova de posse (desafio).
async function register(ctx) {
  await requireCsrf(ctx);
  await rateLimit(ctx, 'register', clientIp(ctx), 'register');
  const body = onlyFields(await readJson(ctx.request), ['name', 'phone'], ['name', 'phone']);
  const result = await db.registerCustomer(ctx.pool, { name: body.name, phone: body.phone });
  // Os dois ramos emitem sessão nova (mesmo Set-Cookie e token CSRF novo), para a resposta não revelar
  // se o telefone já existia; no telefone já cadastrado a sessão é anônima.
  let csrfToken;
  if (result.created) {
    csrfToken = await issueSession(ctx, { role: 'customer', customerId: result.customer.id });
    await db.recordAudit(ctx.pool, { action: 'customer.registered', entityId: result.customer.id });
  } else {
    csrfToken = await issueSession(ctx, { role: 'anonymous' });
  }
  return { status: 202, body: { data: { message: REGISTER_MESSAGE, csrfToken } } };
}

async function requestChallenge(ctx) {
  await requireCsrf(ctx);
  await rateLimit(ctx, 'challenge-ip', clientIp(ctx), 'auth');
  const body = onlyFields(await readJson(ctx.request), ['phone'], ['phone']);
  const phone = db.normalizePhoneBR(body.phone);
  if (!phone) throw invalid('phone', 'telefone brasileiro com DDD');
  await rateLimit(ctx, 'challenge-phone', phone, 'auth');
  if (typeof ctx.sendChallenge !== 'function') {
    throw httpError(503, 'PROVIDER_UNAVAILABLE', 'Verificação por mensagem indisponível no momento.');
  }
  const customerId = await db.findCustomerIdByPhone(ctx.pool, phone);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  // Solicitante = IP (HMAC com a chave do servidor): a camada de dados aplica a cota diária de códigos
  // por telefone e solicitante, sem que um terceiro esgote a cota do dono.
  const challengeId = await db.createChallenge(ctx.pool, {
    phoneHash: phoneHash(ctx.config, phone), customerId, codeHash: codeHash(ctx.config, code), ttlSeconds: CHALLENGE_TTL_SECONDS,
    requesterHash: phoneHash(ctx.config, `requester:${clientIp(ctx)}`),
  });
  // Telefone sem cadastro: o desafio existe (nunca valida) e a resposta é idêntica; nada é enviado.
  // O envio não é aguardado: tempo de resposta e falha do provedor não podem revelar se o telefone tem cadastro.
  if (customerId) {
    Promise.resolve()
      .then(() => ctx.sendChallenge({
        challengeId, destination: phone, code, expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
      }))
      .catch((error) => ctx.log?.error?.(`Falha no envio do desafio (${error?.code ?? error?.name ?? 'erro'}).`));
  }
  return { status: 202, body: { data: { challengeId, message: CHALLENGE_MESSAGE } } };
}

async function verifyChallenge(ctx) {
  await requireCsrf(ctx);
  await rateLimit(ctx, 'challenge-verify', clientIp(ctx), 'auth');
  const body = onlyFields(await readJson(ctx.request), ['challengeId', 'code'], ['challengeId', 'code']);
  if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw invalid('code', '6 dígitos');
  if (typeof body.challengeId !== 'string') throw invalid('challengeId', 'uuid');
  const customerId = await db.verifyChallenge(ctx.pool, body.challengeId, codeHash(ctx.config, body.code));
  if (!customerId) throw httpError(401, 'INVALID_CODE', 'Código inválido ou expirado.');
  const csrfToken = await issueSession(ctx, { role: 'customer', customerId });
  return { status: 200, body: { data: { role: 'customer', csrfToken } } };
}

async function login(ctx) {
  await requireCsrf(ctx);
  await rateLimit(ctx, 'login-ip', clientIp(ctx), 'auth');
  const body = onlyFields(await readJson(ctx.request), ['login', 'password'], ['login', 'password']);
  const loginName = stringField(body.login, 'login', 3, 100).trim().toLowerCase();
  const password = stringField(body.password, 'password', 12, 128);
  // Limite por login E origem: tentativas de terceiros não travam o login de quem é dono da conta.
  await rateLimit(ctx, 'login-id', `${loginName}|${clientIp(ctx)}`, 'auth');
  const staff = await db.findStaffForLogin(ctx.pool, loginName);
  const ok = await verifyPassword(password, staff?.passwordHash ?? null);
  if (!staff || !ok) throw httpError(401, 'INVALID_CREDENTIALS', 'Login ou senha inválidos.');
  const csrfToken = await issueSession(ctx, { role: staff.role, staffId: staff.id });
  await db.recordAudit(ctx.pool, { actorId: staff.id, action: 'staff.login', entityId: staff.id });
  return { status: 200, body: { data: { id: staff.id, role: staff.role, csrfToken } } };
}

async function logout(ctx) {
  await requireCsrf(ctx);
  const session = await loadSession(ctx);
  if (!session) throw httpError(401, 'UNAUTHENTICATED', 'Sessão ausente ou expirada.');
  await db.revokeSession(ctx.pool, session.id);
  clearSessionCookie(ctx);
  return { status: 204 };
}

// Dados de quem está na sessão (cliente ou equipe), ou null se o cadastro não existe mais.
async function currentUser(ctx, session) {
  if (session.role === 'customer') {
    const customer = await db.getCustomer(ctx.pool, session.customerId);
    return customer && { id: customer.id, name: customer.name, phone: customer.phone, role: 'customer' };
  }
  const staff = await db.getStaff(ctx.pool, session.staffId);
  return staff && { id: staff.id, name: staff.name, role: staff.role };
}

async function me(ctx) {
  const session = await requireRole(ctx, ['customer', 'barber', 'admin']);
  const user = await currentUser(ctx, session);
  if (!user) throw httpError(401, 'UNAUTHENTICATED', 'Sessão inválida.');
  return { status: 200, body: { data: user } };
}

// LGPD art. 18 (acesso e portabilidade): tudo o que o sistema guarda do cliente da sessão, em JSON.
async function exportMyData(ctx) {
  const session = await requireRole(ctx, ['customer']);
  await rateLimit(ctx, 'export', session.customerId, 'auth');
  const { rows: [customer] } = await ctx.pool.query(
    `SELECT id, name, phone, phone_verified_at AS "phoneVerifiedAt", created_at AS "createdAt"
     FROM customers WHERE id = $1`, [session.customerId]);
  if (!customer) throw httpError(401, 'UNAUTHENTICATED', 'Sessão inválida.');
  const { rows: appointments } = await ctx.pool.query(
    `SELECT a.id, st.name AS "staffName", sv.name AS "serviceName", a.start_at AS "startAt", a.end_at AS "endAt",
            a.status, a.notes, a.price_cents AS "priceCents", a.created_at AS "createdAt"
     FROM appointments a JOIN staff st ON st.id = a.staff_id JOIN services sv ON sv.id = a.service_id
     WHERE a.customer_id = $1 ORDER BY a.start_at DESC`, [session.customerId]);
  ctx.response.setHeader('Content-Disposition', 'attachment; filename="meus-dados-barber-prime.json"');
  return { status: 200, body: { data: { customer, appointments, exportedAt: new Date().toISOString() } } };
}

// LGPD art. 18 (eliminação): apaga o cadastro do cliente da sessão, as reservas dele (as futuras liberam o
// horário), envios pendentes, sessões e códigos. A auditoria guarda só o id, sem dado pessoal.
async function deleteMyData(ctx) {
  await requireCsrf(ctx);
  const session = await requireRole(ctx, ['customer']);
  await rateLimit(ctx, 'delete-me', session.customerId, 'auth');
  const customerId = session.customerId;
  await db.transaction(ctx.pool, async (tx) => {
    const { rows } = await tx.query('SELECT id::text AS id FROM appointments WHERE customer_id = $1', [customerId]);
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await tx.query("DELETE FROM outbox WHERE sent_at IS NULL AND payload->>'appointmentId' = ANY($1::text[])", [ids]);
    }
    await tx.query('DELETE FROM appointments WHERE customer_id = $1', [customerId]);
    await tx.query('DELETE FROM idempotency_keys WHERE principal_id = $1', [customerId]);
    await tx.query('DELETE FROM customers WHERE id = $1', [customerId]);
    await db.recordAudit(tx, { action: 'customer.deleted', entityId: customerId });
  });
  clearSessionCookie(ctx);
  return { status: 204 };
}

// Estado da sessão para a tela ao abrir: 200 com data null quando ninguém entrou (sem 401 no console).
async function sessionStatus(ctx) {
  await rateLimit(ctx, 'read', clientIp(ctx), 'read');
  const session = await loadSession(ctx);
  const user = session && session.role !== 'anonymous' ? await currentUser(ctx, session) : null;
  return { status: 200, body: { data: user } };
}

// Admin define login/senha de um membro da equipe (ex.: barbeiro). Revoga as sessões dele.
async function setCredentials(ctx) {
  await requireCsrf(ctx);
  const session = await requireRole(ctx, ['admin']);
  const body = onlyFields(await readJson(ctx.request), ['login', 'password'], ['login', 'password']);
  const loginName = stringField(body.login, 'login', 3, 100);
  const password = stringField(body.password, 'password', 12, 128);
  await db.setStaffCredentials(ctx.pool, ctx.params.id, { login: loginName, passwordHash: await hashPassword(password) });
  await db.recordAudit(ctx.pool, { actorId: session.staffId, action: 'staff.credentials', entityId: ctx.params.id });
  return { status: 204 };
}

// Primeiro administrador a partir do ambiente (ADMIN_LOGIN/ADMIN_PASSWORD), sem senha no código.
// Só cria se o login ainda não existir; nunca sobrescreve senha já cadastrada.
export async function ensureAdmin(pool, { login: loginName, password }) {
  if (typeof loginName !== 'string' || !/^[a-z0-9._-]{3,100}$/.test(loginName)) {
    throw new TypeError('ADMIN_LOGIN deve ter 3..100 caracteres: a-z 0-9 . _ -');
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new TypeError('ADMIN_PASSWORD deve ter 12..128 caracteres.');
  }
  const { rows } = await pool.query('SELECT 1 FROM staff WHERE login = $1', [loginName]);
  if (rows.length) return false;
  const shop = await db.getShop(pool);
  const passwordHash = await hashPassword(password);
  await db.transaction(pool, async (tx) => {
    const staff = await db.createStaff(tx, { shopId: shop.id, name: 'Administrador', role: 'admin' });
    await db.setStaffCredentials(tx, staff.id, { login: loginName, passwordHash });
  });
  return true;
}

export const authRoutes = [
  ['GET', '/api/auth/csrf', csrf],
  ['POST', '/api/auth/register', register],
  ['POST', '/api/auth/challenges', requestChallenge],
  ['POST', '/api/auth/challenges/verify', verifyChallenge],
  ['GET', '/api/auth/session', sessionStatus],
  ['POST', '/api/auth/session', login],
  ['DELETE', '/api/auth/session', logout],
  ['GET', '/api/me', me],
  ['GET', '/api/me/export', exportMyData],
  ['DELETE', '/api/me', deleteMyData],
  ['PUT', '/api/admin/staff/:id/credentials', setCredentials],
];
