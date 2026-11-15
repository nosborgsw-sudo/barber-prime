-- Reverte 001: remove todo o esquema do Barber Prime (apaga os dados dessas tabelas).
-- A extensão btree_gist é mantida, pois pode ser usada por outros esquemas do banco.
DROP TABLE IF EXISTS audit_events, outbox, rate_limits, idempotency_keys, challenges, sessions,
  occupations, blocks, appointments, working_hours, services, customers, staff, shops;
DROP FUNCTION IF EXISTS sync_appointment_occupation(), sync_block_occupation(), guard_appointment_status();
