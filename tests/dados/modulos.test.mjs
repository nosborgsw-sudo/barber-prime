// Testes unitários dos módulos de dados, sem banco.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translatePgError, DataError } from '../../db/erros.mjs';
import { listMigrations } from '../../db/migrar.mjs';
import { transaction } from '../../db/transacao.mjs';
import { createAppointment, registerCustomer } from '../../db/repositorios.mjs';

test('erros: SQLSTATE vira código estável, sem vazar SQL nem valores', () => {
  assert.equal(translatePgError({ code: '23P01' }).code, 'SLOT_CONFLICT');
  assert.equal(translatePgError({ code: '23P01' }).status, 409);
  assert.equal(translatePgError({ code: '23P01', constraint: 'working_hours_sem_sobreposicao' }).code, 'VALIDATION_ERROR');
  assert.equal(translatePgError({ code: '23505' }).code, 'DUPLICATE');
  assert.equal(translatePgError({ code: '23514', constraint: 'appointments_status_transition' }).code, 'BUSINESS_RULE');
  assert.equal(translatePgError({ code: 'ECONNREFUSED' }).status, 503);
  const internal = translatePgError(Object.assign(new Error('syntax error at "SELECT secret"'), { code: '42601' }));
  assert.equal(internal.code, 'INTERNAL');
  assert.ok(!internal.message.includes('SELECT'));
  assert.ok(internal instanceof DataError);
});

test('migrar: migrações em sequência, cada uma com up e down', async () => {
  const list = await listMigrations();
  assert.ok(list.length >= 1);
  list.forEach((m, i) => {
    assert.equal(m.version, i + 1);
    assert.match(m.up, /\.up\.sql$/);
    assert.match(m.down, /\.down\.sql$/);
  });
});

function fakePool(failOn) {
  const log = [];
  const released = [];
  return {
    log, released,
    connect: async () => ({
      query: async (sql) => {
        log.push(sql);
        if (sql === failOn) throw new Error(`falha em ${sql}`);
        return { rows: [], rowCount: 0 };
      },
      release: (destroy) => released.push(destroy ?? false),
    }),
  };
}

test('transacao: COMMIT no sucesso, ROLLBACK no erro e conexão sempre devolvida', async () => {
  const ok = fakePool();
  assert.equal(await transaction(ok, async (tx) => { await tx.query('X'); return 7; }), 7);
  assert.deepEqual(ok.log, ['BEGIN', 'X', 'COMMIT']);
  assert.deepEqual(ok.released, [false]);

  const bad = fakePool('X');
  await assert.rejects(transaction(bad, (tx) => tx.query('X')), /falha em X/);
  assert.deepEqual(bad.log, ['BEGIN', 'X', 'ROLLBACK']);

  const broken = fakePool('ROLLBACK');
  await assert.rejects(transaction(broken, () => { throw new Error('original'); }), /original/);
  assert.deepEqual(broken.released, [true], 'conexão quebrada é descartada');
});

test('repositorios: entrada inválida é recusada antes de abrir conexão', async () => {
  const pool = { connect: () => assert.fail('não deveria conectar'), query: () => assert.fail('não deveria consultar') };
  await assert.rejects(registerCustomer(pool, { name: 'A', phone: '11987654321' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(registerCustomer(pool, { name: 'Nome', phone: '11987654321', role: 'admin' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(createAppointment(pool, { customerId: "x'; DROP TABLE appointments;--", staffId: 'y', serviceId: 'z', startAt: 'agora' }),
    (e) => e.code === 'VALIDATION_ERROR' && 'customerId' in e.fields);
});
