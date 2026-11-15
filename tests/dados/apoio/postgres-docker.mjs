// Sobe um PostgreSQL 16 descartável em Docker, só em 127.0.0.1, para os testes de dados.
// Sem Docker disponível, retorna { motivo } para o teste ser pulado com a razão explícita
// (DADOS_EXIGIR_PG=1 transforma isso em falha).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool, connect } from './pg-minimo.mjs';

const exec = promisify(execFile);
const IMAGE = 'postgres:16-alpine';

async function docker(...args) {
  const { stdout } = await exec('docker', args, { timeout: 120_000, windowsHide: true });
  return stdout.trim();
}

async function waitReady(port, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      const c = await connect({ port });
      await c.query('SELECT 1');
      c.close();
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`PostgreSQL não ficou pronto: ${last?.message}`);
}

export async function startPostgres() {
  try {
    await docker('version', '--format', '{{.Server.Version}}');
  } catch {
    return { motivo: 'Docker indisponível: testes de PostgreSQL real não executados.' };
  }
  const name = `bp-dados-teste-${randomBytes(4).toString('hex')}`;
  await docker('run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
    '-p', '127.0.0.1::5432', IMAGE);
  const mapped = await docker('port', name, '5432/tcp');
  const port = Number(mapped.split('\n')[0].split(':').pop());
  await waitReady(port);
  const state = { name, port, pool: new Pool({ port }) };
  state.restart = async () => {
    await state.pool.end();
    await docker('restart', name);
    const again = Number((await docker('port', name, '5432/tcp')).split('\n')[0].split(':').pop());
    state.port = again;
    await waitReady(again);
    state.pool = new Pool({ port: again });
    return state.pool;
  };
  state.stop = async () => {
    await state.pool.end();
    await docker('rm', '-f', name).catch(() => {});
  };
  return state;
}
