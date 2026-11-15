// Ponto de entrada da camada de dados (frente Dados). O backend cria o pool `pg` e o injeta aqui.
export { DataError, dataError, translatePgError } from './erros.mjs';
export { listMigrations, migrate, rollback } from './migrar.mjs';
export { seed, SEED_SHOP_ID, SEED_BARBERS, SEED_SERVICES, SEED_HOURS } from './seed.mjs';
export { normalizePhoneBR } from './telefone.mjs';
export { transaction } from './transacao.mjs';
export * from './repositorios.mjs';
