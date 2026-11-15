// Runner de migrações: arquivos migrations/NNN_nome.up.sql e NNN_nome.down.sql.
// O diretório é fixo (relativo a este módulo); nenhum caminho vem de entrada externa.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transaction } from './transacao.mjs';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const LOCK_KEY = 482_715_903; // pg_advisory_xact_lock: impede duas instâncias migrando ao mesmo tempo
const FILE_RE = /^(\d{3})_([a-z0-9_]+)\.(up|down)\.sql$/;

export async function listMigrations() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => FILE_RE.test(f)).sort();
  const byVersion = new Map();
  for (const file of files) {
    const [, num, name, dir] = FILE_RE.exec(file);
    const version = Number(num);
    const entry = byVersion.get(version) ?? { version, name };
    if (entry.name !== name) throw new Error(`Migração ${num} com nomes diferentes.`);
    entry[dir] = file;
    byVersion.set(version, entry);
  }
  const list = [...byVersion.values()].sort((a, b) => a.version - b.version);
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Sequência de migrações com buraco em ${m.version}.`);
    if (!m.up || !m.down) throw new Error(`Migração ${m.version} sem par up/down.`);
  });
  return list;
}

async function readSql(file) {
  return readFile(MIGRATIONS_DIR + file, 'utf8');
}

async function ensureTable(tx) {
  await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
}

// Aplica as migrações pendentes, cada uma na sua transação. Recusa se um arquivo já aplicado mudou.
export async function migrate(pool) {
  const applied = [];
  for (const m of await listMigrations()) {
    const sql = await readSql(m.up);
    const checksum = createHash('sha256').update(sql).digest('hex');
    const done = await transaction(pool, async (tx) => {
      await ensureTable(tx);
      const { rows } = await tx.query('SELECT checksum FROM schema_migrations WHERE version = $1', [m.version]);
      if (rows.length) {
        if (rows[0].checksum !== checksum) throw new Error(`Migração ${m.version} alterada depois de aplicada.`);
        return false;
      }
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, checksum]);
      return true;
    });
    if (done) applied.push(m.version);
  }
  return applied;
}

// Reverte as últimas `steps` migrações aplicadas (padrão 1). Apaga dados das tabelas revertidas.
export async function rollback(pool, steps = 1) {
  if (!Number.isInteger(steps) || steps < 1 || steps > 1000) throw new RangeError('steps inválido');
  const all = new Map((await listMigrations()).map((m) => [m.version, m]));
  const reverted = [];
  for (let i = 0; i < steps; i++) {
    const version = await transaction(pool, async (tx) => {
      await ensureTable(tx);
      const { rows } = await tx.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
      if (!rows.length) return null;
      const m = all.get(rows[0].version);
      if (!m) throw new Error(`Arquivo da migração ${rows[0].version} ausente.`);
      await tx.query(await readSql(m.down));
      await tx.query('DELETE FROM schema_migrations WHERE version = $1', [m.version]);
      return m.version;
    });
    if (version === null) break;
    reverted.push(version);
  }
  return reverted;
}
