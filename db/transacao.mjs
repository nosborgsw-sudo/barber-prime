// Transação sobre um pool compatível com `pg` (pool.connect() → client.query/release).
export async function transaction(pool, callback) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // conexão inutilizável: devolve ao pool marcada para descarte
    }
    throw err;
  } finally {
    client.release(broken || undefined);
  }
}
