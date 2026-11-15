// Sessão opaca em cookie (só o hash SHA-256 vai ao banco), CSRF, senha scrypt e limites persistentes.
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import * as db from '../../db/index.mjs';
import { httpError, parseCookies } from '../http.mjs';

const scrypt = promisify(scryptCb);
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;
export const SESSION_IDLE_SECONDS = 12 * 3600;

export const sha256 = (value) => createHash('sha256').update(value).digest();
export const newToken = () => randomBytes(32).toString('base64url');

export function cookieName(config) {
  return config.cookieSecure ? '__Host-bp_session' : 'bp_session';
}

function sessionCookie(config, token, maxAge) {
  const attrs = [`${cookieName(config)}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (config.cookieSecure) attrs.push('Secure');
  return attrs.join('; ');
}

// Sessão do cookie, se válida. Carregada uma vez por requisição.
export async function loadSession(ctx) {
  if (ctx.sessionLoaded) return ctx.session;
  ctx.sessionLoaded = true;
  ctx.session = null;
  const token = parseCookies(ctx.request.headers.cookie)[cookieName(ctx.config)];
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    ctx.session = await db.findActiveSession(ctx.pool, sha256(token), { idleSeconds: SESSION_IDLE_SECONDS });
  }
  return ctx.session;
}

// Emite sessão nova (revogando a anterior: impede fixação de sessão) e devolve o token CSRF dela.
export async function issueSession(ctx, { role, customerId = null, staffId = null }) {
  const previous = await loadSession(ctx);
  if (previous) await db.revokeSession(ctx.pool, previous.id);
  const token = newToken();
  const csrfToken = newToken();
  const created = await db.createSession(ctx.pool, {
    tokenHash: sha256(token), role, customerId, staffId, csrfHash: sha256(csrfToken), ttlSeconds: SESSION_TTL_SECONDS,
  });
  ctx.session = { id: created.id, role, customerId, staffId, csrfHash: sha256(csrfToken) };
  ctx.response.setHeader('Set-Cookie', sessionCookie(ctx.config, token, SESSION_TTL_SECONDS));
  return csrfToken;
}

export function clearSessionCookie(ctx) {
  ctx.response.setHeader('Set-Cookie', sessionCookie(ctx.config, '', 0));
}

// Renova o token CSRF da sessão atual (ou cria sessão anônima).
export async function refreshCsrf(ctx) {
  const session = await loadSession(ctx);
  if (!session) return issueSession(ctx, { role: 'anonymous' });
  const csrfToken = newToken();
  await db.setSessionCsrf(ctx.pool, session.id, sha256(csrfToken));
  session.csrfHash = sha256(csrfToken);
  return csrfToken;
}

function expectedOrigin(ctx) {
  const host = ctx.request.headers.host;
  if (typeof host !== 'string' || !/^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host)) return null;
  const forwarded = ctx.config.trustProxy ? lastForwarded(ctx.request.headers['x-forwarded-proto']) : '';
  const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : (ctx.request.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}`.toLowerCase();
}

// Proteção CSRF de toda mutação (inclusive cadastro e login):
// - corpo só em application/json (formulário de outro site não consegue enviar sem preflight, e não há CORS);
// - Origin, quando presente, precisa ser a própria origem ou uma da allowlist;
// - Sec-Fetch-Site cross-site é recusado;
// - requisição de navegador (Origin ou Sec-Fetch-Site presentes) exige X-CSRF-Token igual ao da sessão.
// Clientes sem esses cabeçalhos não são navegadores e não carregam cookie de vítima.
export async function requireCsrf(ctx) {
  const headers = ctx.request.headers;
  const origin = typeof headers.origin === 'string' ? headers.origin.toLowerCase() : null;
  const fetchSite = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'] : null;
  const allowed = origin !== null && (origin === expectedOrigin(ctx) || ctx.config.allowedOrigins.includes(origin));
  if (origin !== null && !allowed) throw httpError(403, 'CSRF_ORIGIN', 'Origem não permitida.');
  if (fetchSite === 'cross-site' && !allowed) throw httpError(403, 'CSRF_ORIGIN', 'Origem não permitida.');
  if (origin === null && fetchSite === null) return;
  const token = headers['x-csrf-token'];
  const session = await loadSession(ctx);
  if (typeof token !== 'string' || token.length > 100 || !session?.csrfHash
      || !timingSafeEqual(sha256(token), session.csrfHash)) {
    throw httpError(403, 'CSRF_INVALID', 'Token CSRF ausente ou inválido. Recarregue a página.');
  }
}

export async function requireRole(ctx, roles) {
  const session = await loadSession(ctx);
  if (!session || session.role === 'anonymous') throw httpError(401, 'UNAUTHENTICATED', 'Faça login para continuar.');
  if (!roles.includes(session.role)) throw httpError(403, 'FORBIDDEN', 'Seu perfil não tem acesso a esta ação.');
  return session;
}

// Escopo de dados derivado só da sessão; nunca de telefone ou id enviado pelo cliente.
export function scopeOf(session) {
  if (session.role === 'customer') return { role: 'customer', customerId: session.customerId };
  if (session.role === 'barber') return { role: 'barber', staffId: session.staffId };
  if (session.role === 'admin') return { role: 'admin' };
  throw httpError(401, 'UNAUTHENTICATED', 'Faça login para continuar.');
}

// Atrás de proxy confiável (TRUST_PROXY=1) vale a ÚLTIMA entrada do X-Forwarded-For: é a que o próprio
// proxy acrescentou; as anteriores vêm do cliente e podem ser forjadas para fugir dos limites.
function lastForwarded(value) {
  const parts = String(value ?? '').split(',');
  return parts[parts.length - 1].trim();
}

export function clientIp(ctx) {
  if (ctx.config.trustProxy) {
    const last = lastForwarded(ctx.request.headers['x-forwarded-for']);
    if (isIP(last)) return last;
  }
  return ctx.request.socket.remoteAddress ?? 'desconhecido';
}

// Limite persistente (tabela rate_limits): vale entre reinícios e entre instâncias.
export async function rateLimit(ctx, name, key, limitName) {
  const limit = ctx.config.limits[limitName];
  const bucket = `${name}:${createHash('sha256').update(String(key)).digest('base64url').slice(0, 32)}`;
  const { allowed, retryAfterSeconds } = await db.hitRateLimit(ctx.pool, bucket, limit);
  if (!allowed) {
    throw httpError(429, 'RATE_LIMITED', 'Muitas tentativas. Aguarde e tente novamente.', {
      headers: { 'Retry-After': String(Math.max(1, retryAfterSeconds)) },
    });
  }
}

export function phoneHash(config, phone) {
  return createHmac('sha256', config.phoneHashKey).update(phone).digest();
}

// HMAC com chave do servidor: o código de 6 dígitos não é recuperável por força bruta só com o banco.
export function codeHash(config, code) {
  return createHmac('sha256', config.phoneHashKey).update(`code:${code}`).digest();
}

// scrypt (OWASP: N=2^15, r=8, p=3) com salt aleatório de 16 bytes.
const SCRYPT = { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Hash fictício para gastar o mesmo tempo quando o login não existe (evita descobrir logins pelo tempo).
let dummyHash;
export async function verifyPassword(password, stored) {
  dummyHash ??= await hashPassword(newToken());
  const parts = String(stored ?? dummyHash).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, expected] = parts;
  const want = Buffer.from(expected, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return stored != null && timingSafeEqual(got, want);
}
