// Conexão com PostgreSQL para o servidor.
// - DATABASE_URL definida: pool `pg` contra um PostgreSQL externo (produção).
// - Sem DATABASE_URL: PGlite (PostgreSQL 17 em WASM, embutido) persistido em DATA_DIR (padrão ./data/pglite).
// As duas opções expõem a interface que db/** espera: query(text, values), connect() → client, end().
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate, seed } from '../db/index.mjs';

// PGlite tem uma única conexão: um mutex serializa consultas e transações, como um pool de tamanho 1.
class PgliteQueue {
  #tail = Promise.resolve();
  acquire() {
    let release;
    const gate = new Promise((r) => { release = r; });
    const ready = this.#tail.then(() => release);
    this.#tail = this.#tail.then(() => gate);
    return ready;
  }
}

function normalizeResult(result) {
  const rows = result?.rows ?? [];
  return { rows, rowCount: result?.affectedRows ?? rows.length };
}

async function runOn(pg, text, values) {
  if (values && values.length) return normalizeResult(await pg.query(text, values));
  // Sem parâmetros pode haver várias instruções (migrações): exec devolve um resultado por instrução.
  const results = await pg.exec(text);
  return normalizeResult(results.at(-1));
}

export function pglitePool(pg) {
  const queue = new PgliteQueue();
  return {
    kind: 'pglite',
    async query(text, values) {
      const release = await queue.acquire();
      try {
        return await runOn(pg, text, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await queue.acquire();
      let released = false;
      return {
        query: (text, values) => runOn(pg, text, values),
        release() {
          if (released) return;
          released = true;
          release();
        },
      };
    },
    async end() {
      await pg.close();
    },
  };
}

export async function openDatabase({ databaseUrl = process.env.DATABASE_URL, dataDir = process.env.DATA_DIR } = {}) {
  let pool;
  if (databaseUrl) {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    pool.kind = 'pg';
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
    let location;
    if (dataDir !== 'memory://') {
      location = resolve(dataDir ?? 'data/pglite');
      mkdirSync(location, { recursive: true });
    }
    const pg = await PGlite.create(location ?? 'memory://', { extensions: { btree_gist } });
    pool = pglitePool(pg);
  }
  await migrate(pool);
  await seed(pool);
  return pool;
}
