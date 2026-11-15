// Aplicação HTTP do Barber Prime: roteador da API (/api/**), arquivos do frontend e erros no formato do contrato.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { authRoutes } from './auth/rotas.mjs';
import { bookingRoutes } from './booking/rotas.mjs';
import { catalogRoutes } from './catalog/rotas.mjs';
import { httpError, sendError, sendJson } from './http.mjs';
import { serveStatic } from './static.mjs';

export const DEFAULT_LIMITS = {
  register: { windowSeconds: 15 * 60, max: 5 },
  auth: { windowSeconds: 15 * 60, max: 5 },
  read: { windowSeconds: 60, max: 300 },
  booking: { windowSeconds: 15 * 60, max: 30 },
};

export function configFromEnv(env = process.env) {
  return {
    cookieSecure: env.NODE_ENV === 'production' || env.COOKIE_SECURE === '1',
    trustProxy: env.TRUST_PROXY === '1',
    allowedOrigins: String(env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim().toLowerCase()).filter(Boolean),
    // Sem PHONE_HASH_KEY, chave aleatória do processo: desafios (TTL 5 min) só valem até reiniciar.
    phoneHashKey: env.PHONE_HASH_KEY && env.PHONE_HASH_KEY.length >= 32 ? env.PHONE_HASH_KEY : randomBytes(32),
    limits: DEFAULT_LIMITS,
  };
}

function compile(routes) {
  return routes.map(([method, path, handler]) => {
    const names = [];
    const pattern = path.replace(/:([a-zA-Z]+)/g, (_, name) => { names.push(name); return '([^/]+)'; });
    return { method, regex: new RegExp(`^${pattern}$`), names, handler };
  });
}

const ROUTES = compile([...authRoutes, ...catalogRoutes, ...bookingRoutes]);

// Assinaturas "MÉTODO /caminho" atendidas pela API (conferidas contra docs/contrato-api.json nos testes).
export const API_ROUTES = ['GET /api/health', ...[...authRoutes, ...catalogRoutes, ...bookingRoutes].map(([m, p]) => `${m} ${p}`)];

function match(method, pathname) {
  let allowed = [];
  for (const route of ROUTES) {
    const found = route.regex.exec(pathname);
    if (!found) continue;
    if (route.method !== method) { allowed.push(route.method); continue; }
    const params = {};
    route.names.forEach((name, i) => {
      try {
        params[name] = decodeURIComponent(found[i + 1]);
      } catch {
        params[name] = '';
      }
    });
    return { route, params };
  }
  return { allowed };
}

async function health(pool, response) {
  try {
    if (!pool) throw new Error('sem banco');
    await (await pool).query('SELECT 1', []);
    sendJson(response, 200, { status: 'ok', stage: 'operational', operational: true, database: 'ok' });
  } catch {
    sendJson(response, 503, { status: 'error', stage: 'operational', operational: false, database: 'unavailable' });
  }
}

/**
 * Cria o servidor HTTP. `pool`: pool compatível com `pg` (ou Promise dele). `sendChallenge`: adaptador
 * do provedor de mensagens para prova de posse (ou Promise dele); ausente → 503 nas rotas de desafio.
 */
export function createApp({ pool, config = configFromEnv(), sendChallenge = null, log = console } = {}) {
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    // HSTS só quando o deploy é HTTPS (cookie Secure): em http local o navegador ignoraria de todo modo.
    if (config.cookieSecure) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      sendError(response, httpError(400, 'BAD_REQUEST', 'URL inválida.'), log);
      return;
    }
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/') && pathname !== '/api') {
      if ((request.method === 'GET' || request.method === 'HEAD') && await serveStatic(request, response, pathname)) return;
      response.setHeader('Cache-Control', 'no-store');
      sendError(response, httpError(404, 'NOT_FOUND', 'Página não encontrada.'), log);
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    try {
      if (pathname === '/api/health') {
        if (request.method !== 'GET') throw httpError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.', { headers: { Allow: 'GET' } });
        await health(pool, response);
        return;
      }
      const found = match(request.method, pathname);
      if (!found.route) {
        if (found.allowed.length) {
          throw httpError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.', { headers: { Allow: found.allowed.join(', ') } });
        }
        throw httpError(404, 'NOT_FOUND', 'Rota não encontrada.');
      }
      if (!pool) throw httpError(503, 'DB_UNAVAILABLE', 'Serviço temporariamente indisponível.');
      const ctx = { request, response, url, params: found.params, pool: await pool, config, sendChallenge: await sendChallenge, log };
      const result = await found.route.handler(ctx);
      sendJson(response, result.status, result.body);
    } catch (err) {
      sendError(response, err, log);
    }
  });
}
