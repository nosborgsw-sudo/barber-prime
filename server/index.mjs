import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createApp, configFromEnv } from './app.mjs';
import { ensureAdmin } from './auth/rotas.mjs';
import { openDatabase } from './db.mjs';
import { purgeExpired } from '../db/index.mjs';

// Adaptador do provedor de prova de posse (frente RPA: SMS pela API da Twilio, configurado por ambiente).
// Sem o módulo ou sem configuração completa, as rotas de desafio respondem 503.
const CHALLENGE_ADAPTER = new URL('../automation/challenge-provider.mjs', import.meta.url);

export async function loadSendChallenge(env = process.env) {
  if (!existsSync(CHALLENGE_ADAPTER)) return null;
  const mod = await import(CHALLENGE_ADAPTER.href);
  const config = mod.loadSmsConfig(env);
  return config ? mod.createSmsProvider({ config }).sendChallenge : null;
}

const PURGE_INTERVAL_MS = 60 * 60 * 1000;

// Limpeza de sessões, desafios, chaves de idempotência e limites vencidos; falha só vai ao log.
async function purge(pool, log) {
  try {
    await purgeExpired(pool);
  } catch (error) {
    log.error(`Falha na limpeza de registros vencidos (${error?.code ?? error?.name ?? 'erro'}).`);
  }
}

export function startServer({
  port = process.env.PORT ?? '3000',
  host = process.env.HOST ?? '127.0.0.1',
  databaseUrl = process.env.DATABASE_URL,
  dataDir = process.env.DATA_DIR,
  adminLogin = process.env.ADMIN_LOGIN,
  adminPassword = process.env.ADMIN_PASSWORD,
  config = configFromEnv(),
  log = console,
} = {}) {
  const numericPort = Number(port);
  if (!/^\d+$/.test(String(port)) || !Number.isInteger(numericPort) || numericPort < 0 || numericPort > 65535) {
    throw new TypeError('PORT deve ser um inteiro entre 0 e 65535.');
  }
  if (typeof host !== 'string' || host.trim().length === 0) {
    throw new TypeError('HOST deve ser um endereço não vazio.');
  }
  if (Boolean(adminLogin) !== Boolean(adminPassword)) {
    throw new TypeError('Defina ADMIN_LOGIN e ADMIN_PASSWORD juntos.');
  }
  const ready = (async () => {
    const pool = await openDatabase({ databaseUrl, dataDir });
    if (adminLogin) await ensureAdmin(pool, { login: adminLogin, password: adminPassword });
    return pool;
  })();
  ready.catch(() => {}); // o erro é tratado abaixo; evita rejeição não tratada antes do listen
  const sendChallenge = ready.then(() => loadSendChallenge()).catch(() => null);
  const server = createApp({ pool: ready, config, log, sendChallenge });
  let purgeTimer = null;
  ready
    .then(async (pool) => {
      await sendChallenge;
      await purge(pool, log);
      purgeTimer = setInterval(() => purge(pool, log), PURGE_INTERVAL_MS);
      purgeTimer.unref();
      server.listen(numericPort, host, () => {
        const kind = databaseUrl ? 'PostgreSQL (DATABASE_URL)' : 'PostgreSQL embutido (PGlite)';
        log.info(`Barber Prime ativo na porta ${server.address().port}; banco: ${kind}.`);
      });
    })
    .catch((error) => server.emit('error', error));
  server.on('close', () => {
    clearInterval(purgeTimer);
    ready.then((pool) => pool.end()).catch(() => {});
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = startServer();
  server.on('error', (error) => {
    const detail = error instanceof TypeError ? `: ${error.message}` : '';
    console.error(`Falha ao iniciar servidor (${error.code ?? error.name ?? 'STARTUP_ERROR'})${detail}`);
    process.exitCode = 1;
    server.close();
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => {
      server.closeAllConnections();
      process.exitCode = 1;
    }, 5000);
    timer.unref();
    server.close(() => clearTimeout(timer));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
