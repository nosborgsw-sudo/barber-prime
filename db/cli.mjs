// Uso: DATABASE_URL=postgres://... node db/cli.mjs migrate|rollback [passos]|seed
// Requer o pacote `pg` instalado pela frente backend/devops. A URL vem só do ambiente e nunca é impressa.
import { migrate, rollback, seed } from './index.mjs';

const [command, arg] = process.argv.slice(2);
if (!['migrate', 'rollback', 'seed'].includes(command)) {
  console.error('Uso: node db/cli.mjs migrate | rollback [passos] | seed');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não definida.');
  process.exit(2);
}
let pg;
try {
  pg = (await import('pg')).default;
} catch {
  console.error('Pacote "pg" ausente: instale com npm install pg (frente backend/devops).');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  if (command === 'migrate') console.log('Migrações aplicadas:', await migrate(pool));
  if (command === 'rollback') console.log('Migrações revertidas:', await rollback(pool, arg ? Number(arg) : 1));
  if (command === 'seed') console.log('Seed:', await seed(pool));
} catch (err) {
  console.error(`Falha em ${command}: ${err.code ?? ''} ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
