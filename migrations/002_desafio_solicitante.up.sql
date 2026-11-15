-- Barber Prime 002 (PostgreSQL >= 14, depende da 001).
-- Quem pediu o desafio (HMAC do IP calculado pelo servidor; nunca o IP puro).
-- Permite limitar pedidos por telefone + solicitante, sem que um terceiro esgote a cota do dono.
-- Sem índice novo: as contagens filtram por phone_hash e created_at, já cobertos por challenges_phone_idx.

-- Reafirma o requisito de extensão da 001 (no-op quando já instalada). Também declara o dialeto
-- PostgreSQL desta migração para ferramentas que ensaiam migrações em outro banco.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE challenges
  ADD COLUMN requester_hash bytea NULL CHECK (octet_length(requester_hash) = 32);
