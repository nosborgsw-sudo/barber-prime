# Pesquisa técnica — Barber Prime

Data: 2026-11-14. Inspeção documental pública, não auditoria de código nem execução dos repositórios. Nenhum código externo foi copiado. Stack, testes e segurança descritos por autores são alegações, não resultados comprovados aqui. A pesquisa complementar fica em `PESQUISA-COMPLEMENTAR.md`.

## Repositórios pedidos

| Fonte consultada | Arquitetura / recursos declarados | Licença observada / decisão | Qualidade, manutenção, segurança e compatibilidade |
|---|---|---|---|
| https://github.com/BridgeLine-Services/Main-Barber-Template- | Next.js 16, Prisma/PostgreSQL; agenda por barbeiro, pausas, ausência, cancelamento e reagendamento | Proprietária explícita; não reutilizar código | Referência conceitual de agenda e white label. Transações e isolamento precisam de auditoria; testes e produção não foram executados. Não adotar dependências por transcrição do README. |
| https://github.com/morgadothiago/barbershop-scheduling-app | NestJS/Prisma/PostgreSQL, React administrativo e Expo; disponibilidade e remarcação | Não identificada na página; não reutilizar | Boa separação documental por aplicações; MVP declara lacunas em recuperação de acesso e revogação. Comandos de testes não provam aprovação. Arquitetura maior que a instalação inicial necessária. |
| https://github.com/haivlee/barber-book | Next.js 15/React 19/Prisma/SQLite; aprovação manual, disponibilidade e acompanhamento | Não identificada na página; não reutilizar | Referência de fluxo curto; notificações em console não são integração real. Credenciais de desenvolvimento documentadas não devem ser reproduzidas. Migrar SQLite não basta para obter proteção concorrente PostgreSQL. |
| https://github.com/clawnify/OpenSalon | Preact/Vite/Hono/SQLite; agenda por profissional, vários serviços, bloqueios, CSV | Página diverge entre MIT e AGPL; arquivo LICENSE consultado confirma MIT. Sem copiar neste projeto | Sobreposição pode ser liberada pelo operador segundo README: incompatível com proibição absoluta de conflito. Não importar essa regra. Ausência de resultados de testes na página não prova ausência de testes. |
| https://github.com/Ekwugha/barberShop | Next.js 14/TypeScript/Tailwind/Supabase; expediente, duração e reservas | README declara MIT, arquivo completo não verificado; não reutilizar | Referência de UX, não base instalada. Prevenção no banco declarada mas não comprovada. RLS, notificações, dependências e permissões exigem auditoria. |
| https://github.com/77mdias/barbershop-next | Next.js/TypeScript/Prisma/NextAuth; Docker e produção Vercel; papéis e agenda | Não identificada na página; não reutilizar | Configurações Jest/Playwright e CI não equivalem a suíte aprovada. Escopo social/cupons desnecessário para primeira integração. Compatibilidade e vulnerabilidades não verificadas. |
| https://github.com/henry-hai/barber-booking | README aponta Next.js + Express/Sheets, e alternativa AWS/Python; painel e solicitação por email | Licença proprietária identificada na pesquisa anterior repassada; texto atual não reaberto. Não reutilizar | Pedidos de preferência não equivalem a reservas confirmadas; backend e frontend distintos, com caminhos operacionais divergentes na documentação. Contagens de testes declaradas não foram executadas. |
| https://github.com/EliNaduyev/Barbershop | React/Express/MongoDB; cadastro, reservas e painel | Não identificada na página; não reutilizar | Instalação visível incompleta para servidor; sem evidência documental suficiente de concorrência, testes, fusos e autorização por objeto. MongoDB não é o banco alvo. |

A divergência OpenSalon foi conferida no arquivo de licença, fonte primária: https://raw.githubusercontent.com/clawnify/OpenSalon/main/LICENSE — MIT, copyright 2026 Clawnify; eventual cópia substancial exigiria preservar os avisos. A análise do restante do código e de outros ativos ainda seria necessária.

## Fontes adicionais efetivamente abertas

- https://github.com/topics/barbershop — descoberta de GoBarber e outras agendas; presença em Topics não certifica qualidade. Não foram auditados os códigos dos projetos adicionais.
- https://github.com/calcom/cal.diy — Next.js/React/tRPC/Tailwind/Prisma/PostgreSQL, licença MIT declarada; README recomenda uso pessoal fora de produção. Não usar como base comercial sem revisão operacional própria.
- https://nextjs.org/docs/app — App Router é roteamento por arquivos, com Server Components, Suspense e Server Functions. Serve ao frontend alvo, não substitui as regras de autorização por objeto do backend.
- https://www.postgresql.org/docs/current/rangetypes.html — intervalos e `EXCLUDE USING GiST` impedem sobreposição por recurso; adotar `tstzrange` semiaberto `[)` e `btree_gist`, além de transação. Apenas checar disponibilidade antes do INSERT sofre corrida.
- https://nodejs.org/docs/latest-v24.x/api/test.html — descoberta recursiva de arquivos `.test.mjs` com `node --test`, permitindo testes por frente sem editar package.json.
- https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html — tokens imprevisíveis, cookies HttpOnly/Secure/SameSite, renovação e revogação no servidor. A regra de não autorizar por telefone é decisão do produto, não citação específica dessa página.

## Decisões e reaproveitamento

1. Implementação própria: reaproveitar ideias de fluxo e organização, não código, imagens ou marcas.
2. Alvo de produção: React/Next.js/Tailwind no frontend; API Node.js separada e PostgreSQL no servidor. O bootstrap atual usa apenas Node nativo, sem antecipar a implementação das frentes.
3. Invariante no banco: exclusão de intervalos para cada barbeiro, inclusive bloqueios. Reagendamento atômico; resposta 409 em disputa real. A proteção deve ser testada com concorrência e PostgreSQL real, não apenas mocks.
4. Segurança: telefone normalizado e único não é credencial. Recuperação exige prova de posse via provedor; indisponibilidade deve bloquear o fluxo, nunca aceitar código fixo ou login por número.
5. Manutenção: comparar versões suportadas, lockfile, advisories, licença e dependências transitivas quando as frentes adicionarem pacotes. Não foram executados builds, auditorias de dependências ou benchmarks dos projetos pesquisados.

## Limitações

As páginas públicas e READMEs não permitem concluir qualidade global, segurança, manutenção contínua nem compatibilidade de toda a árvore de dependências. Nenhum repositório foi clonado ou executado. Licença ausente ou ambígua impede reaproveitamento até esclarecimento. A URL raw de documentação consultada na execução anterior que retornou 404 não foi usada como evidência. Não existe publicação pública do Barber Prime nesta etapa.
