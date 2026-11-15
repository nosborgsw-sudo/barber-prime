# Integração das frentes — Barber Prime

Data: 2026-11-15. Etapa de integração do time técnico do Studio (frentes arquitetura, dados, rpa, backend,
frontend e devops, cada uma executada por um agente especialista, com skills do Studio conferindo o resultado).

## Como o sistema se liga

| Peça | Arquivos | Liga em |
|---|---|---|
| Banco PostgreSQL (migração, seed com 4 barbeiros, exclusion constraint contra conflito) | `migrations/`, `db/` | `server/db.mjs` abre `pg` (com `DATABASE_URL`) ou PostgreSQL embutido PGlite (`DATA_DIR`, padrão `data/pglite`) |
| API HTTP (sessão em cookie, CSRF, cadastro, reservas, painel) | `server/` | `docs/contrato-api.json` (conferido por `tests/arquitetura/bootstrap.test.mjs`) |
| Frontend real | `public/index.html`, `public/api.js`, `public/app.js` | servido em `/` pelo próprio servidor, chama `/api/**` na mesma origem |
| HTML autônomo (DEMONSTRAÇÃO, localStorage) | `app-autonomo.html` (gerado por `tests/frontend/gerar-autonomo.mjs`) | mesma tela, adaptador `public/demo.js` no lugar da API |
| RPA | `automation/`, `jobs/outbox-worker.mjs` | SMS pela Twilio (`TWILIO_*`), exportação iCalendar da agenda |
| DevOps | `.github/workflows/`, `Dockerfile`, `scripts/build-pages.mjs` | CI, imagem Docker com teste de saúde, build da versão HTML pública em `dist/pages` |

Subir: `npm install` e `npm start` (porta 3000). Primeiro administrador por ambiente: `ADMIN_LOGIN` e `ADMIN_PASSWORD` (12+ caracteres).

## Prova de ponta a ponta

`npm run e2e` (`scripts/e2e-servidor.mjs`) sobe `node server/index.mjs` em **processo separado**, com banco
temporário e senha de administrador gerada na hora, e confere 22 pontos: saúde, frontend servido, catálogo
(4 barbeiros, serviços com preço e duração, horário de funcionamento), disponibilidade, cadastro só com nome e
telefone, recusa de entrada inválida, telefone duplicado sem sessão, reserva com Idempotency-Key, conflito 409,
isolamento entre clientes (404), reagendamento, painel do administrador, **reinício do processo com sessão e
reserva persistidas**, cancelamento e horário liberado. O teste `tests/integracao/e2e-servidor.test.mjs` roda o
mesmo script dentro de `npm test`.

## Correções feitas na integração

- A tela chamava `GET /api/me` ao abrir; sem sessão, o navegador registrava erro 401 no console. Criada
  `GET /api/auth/session` (200 com `data: null` sem sessão); `/api/me` continua respondendo 401 como no contrato.
- O texto do banner repetia "Escolha o serviço", e a busca por texto no navegador encontrava o parágrafo
  escondido da página inicial. O banner foi reescrito e `app-autonomo.html` regenerado.

## Limitações e pendências reais

- **URL pública não publicada.** Workflow do GitHub Pages e `scripts/publicar-github-pages.ps1` estão prontos;
  criar o repositório público e fazer push dependem de confirmação do dono. A versão publicada seria o HTML
  autônomo (DEMONSTRAÇÃO); a API com banco precisa de hospedagem com conta do dono.
- **SMS não validado no provedor.** Sem `TWILIO_*`, a recuperação de acesso por código responde 503.
- **React, Next.js e Tailwind não adotados.** Foram pesquisados (`docs/PESQUISA*.md`); a interface é HTML, CSS e
  JavaScript sem framework, para rodar sem build e também como arquivo único offline. O banco é PostgreSQL.
- O pedido de homologação listava R1..R40 e citava mais 249 itens que não chegaram ao texto recebido; eles não
  foram inventados.
- O limite de login (5 tentativas em 15 minutos por login, persistente no banco) também conta logins certos:
  rodar o fluxo de login muitas vezes seguidas sobre o mesmo `data/` devolve 429 até a janela passar.
