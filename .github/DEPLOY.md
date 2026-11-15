# Entrega, CI/CD e reversão — Barber Prime

## Comandos locais
| Etapa | Comando |
|---|---|
| Instalar | `npm ci` |
| Sintaxe | `npm run check` |
| Testes | `npm test` |
| Build da versão HTML pública | `npm run build` → `dist/pages/` (ignorado pelo Git via `dist/.gitignore`) |
| Tudo, falhando cedo | `npm run ci` |
| Servidor | `npm start` (porta 3000; `HOST`, `PORT`, `DATABASE_URL`, `DATA_DIR`, `ADMIN_LOGIN`/`ADMIN_PASSWORD`) |

## Pipelines (`.github/workflows/`)
- `ci.yml`: em push/PR — `npm ci` → `check` → `npm test` → `build` em Ubuntu e Windows; `npm audit` (alta+); depois constrói a imagem Docker e confere `/api/health`.
- `pages.yml`: em push na `main` — repete check/testes/build e publica `dist/pages` no GitHub Pages.
- Ações fixadas por SHA de commit (versão em comentário); `scripts/workflows.test.mjs` reprova tag móvel. O `dependabot.yml` abre PR semanal para atualizar SHAs e dependências npm.

## Versão HTML pública (GitHub Pages)
É a demonstração autônoma (`app-autonomo.html`): arquivo único, sem rede, dados no `localStorage` do visitante, com aviso "DEMONSTRAÇÃO". Não recebe agendamentos reais.

Publicar (ação pública, exige confirmação do dono):
```powershell
pwsh scripts/publicar-github-pages.ps1 -Repositorio barber-prime            # só verifica
pwsh scripts/publicar-github-pages.ps1 -Repositorio barber-prime -Confirmar # cria repo, push, liga Pages
```
URL prevista: `https://<usuario>.github.io/barber-prime/`.

## Backend (sistema operacional com banco)
```bash
docker build -t barber-prime .
docker run -d -p 3000:3000 -v bp-data:/app/data \
  -e ADMIN_LOGIN=gerente -e ADMIN_PASSWORD='<senha forte>' barber-prime
```
Sem `DATABASE_URL` usa PostgreSQL embutido (PGlite) no volume `bp-data`. Em produção, defina `DATABASE_URL` de um PostgreSQL gerenciado. Segredos só por variável de ambiente ou secrets do provedor, nunca no repositório. Hospedagem pública do backend (Render, Fly.io, Railway etc.) exige conta e cartão/credenciais do dono.

## Reversão
- **Pages, voltar versão**: `git revert <commit>` e `git push` na `main` (o workflow republica a versão anterior), ou reexecute um deploy antigo: `gh run rerun <id-do-run-anterior>`.
- **Pages, tirar do ar**: `gh api -X DELETE repos/<usuario>/barber-prime/pages`.
- **Repositório inteiro**: `gh repo edit <usuario>/barber-prime --visibility private --accept-visibility-change-consequences` ou `gh repo delete` (irreversível).
- **Backend Docker**: `docker rm -f <container>` e suba a tag anterior (`docker run ... barber-prime:<tag-anterior>`). Banco: `node db/cli.mjs rollback 1` com `DATABASE_URL` (migração 001 é reversível; faça backup antes).
