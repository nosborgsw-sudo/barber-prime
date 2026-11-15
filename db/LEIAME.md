# Camada de dados (PostgreSQL)

Interface para o backend: `import * as db from './db/index.mjs'`, passando um `pg.Pool` (o pacote `pg` ainda precisa ser instalado pela frente backend/devops).

- Migrações: `migrations/NNN_nome.up.sql` + `.down.sql`. `migrate(pool)` aplica (lock consultivo, checksum), `rollback(pool, n)` reverte. CLI: `DATABASE_URL=... node db/cli.mjs migrate|rollback|seed`.
- `seed(pool)`: barbearia, 4 barbeiros fictícios, 5 serviços, expediente seg–sáb 09–19. Sem clientes, senhas ou sessões.
- Conflito de horário: tabela `occupations`, mantida só por triggers de `appointments` e `blocks`, com `EXCLUDE USING gist (staff_id WITH =, period WITH &&)`. Conflito → `DataError` `SLOT_CONFLICT` (409).
- Erros: `DataError { code, status, fields? }` com códigos do contrato (`VALIDATION_ERROR` 400, `NOT_FOUND` 404, `SLOT_CONFLICT`/`VERSION_CONFLICT`/`IDEMPOTENCY_CONFLICT`/`SCHEDULE_CONFLICT`/`DUPLICATE` 409, `BUSINESS_RULE` 422, `DB_UNAVAILABLE` 503).
- Escopo de acesso: funções de reserva recebem `{role:'customer', customerId}` | `{role:'barber', staffId}` | `{role:'admin'}`, derivado da sessão. Reserva de terceiro → `NOT_FOUND`.
- `registerCustomer` nunca devolve o cliente já existente (`{created:false, customer:null}`); acesso a cadastro existente só por `createChallenge`/`verifyChallenge`.
- Prova de posse (migração 002): `createChallenge({ ..., requesterHash })` limita a 5 pedidos por telefone + solicitante em 24 h (passe o HMAC do IP, nunca o IP puro) e a 20 pedidos por telefone em 24 h somando todos os solicitantes (vale também sem `requesterHash`). Contra força bruta, `createChallenge` e `verifyChallenge` aplicam teto de 50 palpites ERRADOS por telefone em 24 h, somados entre desafios e solicitantes. Só pedir códigos não bloqueia o dono do telefone. Lock consultivo por telefone; erro `RATE_LIMITED`, HTTP 429.
- `purgeExpired(pool)` apaga sessões, desafios, chaves de idempotência e janelas de limite vencidas há mais de 1 dia; o servidor deve chamá-la periodicamente.
- Sessões e desafios guardam só hashes SHA-256 de 32 bytes (`Buffer`).
- Testes: `node --test tests/dados/` sobe PostgreSQL 16 em Docker (127.0.0.1, porta aleatória). Sem Docker os testes de banco são pulados com o motivo; `DADOS_EXIGIR_PG=1` transforma isso em falha.
