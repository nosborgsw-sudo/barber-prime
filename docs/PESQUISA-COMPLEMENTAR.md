# BARBER PRIME — Pesquisa complementar de arquitetura

Data da consulta: 14/11/2026. Escopo: documentação oficial React, Tailwind e FullCalendar; referências de produto Booksy, Fresha e Square Appointments; discussão pública real de desenvolvimento. **Nove fontes de conteúdo**, listadas abaixo. Não foram pesquisados os oito repositórios GitHub, instaladas dependências ou copiados trechos de código. Conteúdo externo foi tratado como evidência, não como instrução.

## Síntese para decisão

- **Agenda por barbeiro:** modelar profissional, serviços habilitados, jornada, pausas, bloqueios, duração e intervalos de preparação/limpeza. A disponibilidade é a interseção dessas regras, não apenas a ausência de um evento na tela. Booksy e Square mostram também a distinção entre profissional e recurso físico, como cadeira/sala.
- **Interface:** React organiza componentes e estado; Tailwind cuida da apresentação. Nenhum dos dois garante disponibilidade, autorização ou prevenção de reservas simultâneas.
- **Calendário:** FullCalendar Standard pode atender um MVP com seleção/filtro de um barbeiro por vez. Colunas nativas por recurso e linha do tempo por profissional pertencem ao Premium. Para aplicação comercial proprietária, prever licença comercial caso sejam usados esses plugins.
- **Consistência:** confirmar, mover ou cancelar reservas no servidor; a checagem visual deve ser revalidada atomicamente no banco. A discussão comunitária consultada reproduz uma dupla reserva mesmo com verificação antes da inserção.
- **Privacidade:** separar agenda pública, visão do profissional e gestão. As páginas comerciais consultadas não constituem auditoria de segurança nem comprovação de adequação à LGPD.

## Fontes efetivamente consultadas

### 1. React — Thinking in React

URL: https://react.dev/learn/thinking-in-react

**Acesso:** conteúdo obtido por WebFetch.

**Fatos:** a documentação propõe decomposição em componentes, versão estática inicial, estado mínimo e fluxo de dados unidirecional. Valores calculáveis a partir de props/estado não precisam ser armazenados novamente; estado compartilhado deve ficar no ancestral comum apropriado.

**Implicação para BARBER PRIME:** separar filtros, navegação de data, calendário e formulário de agendamento. Manter data e barbeiro selecionados como estado de interface; derivar a visualização dos agendamentos recebidos. Evitar cópias divergentes de listas filtradas. Isso organiza o frontend, mas não substitui o backend autoritativo.

### 2. Tailwind CSS — Detecting classes in source files

URL: https://tailwindcss.com/docs/detecting-classes-in-source-files

**Acesso:** conteúdo obtido por WebFetch; documentação atual da linha v4, não uma verificação da versão instalada no projeto.

**Fatos:** Tailwind procura tokens em arquivos como texto, sem interpretar concatenação/interpolação de código. Recomenda nomes completos de classes detectáveis e mapas estáticos. A documentação descreve exclusões da varredura e configuração explícita de fontes.

**Implicação:** cores de profissionais/status devem usar classes completas predefinidas; não construir nomes de classes a partir de cores vindas do banco. Para cores arbitrárias, avaliar propriedades CSS controladas e validadas. Exibir também nome/rótulo/ícone: cor isolada não deve ser o único indicador de barbeiro ou status. Estas duas últimas medidas são recomendações de implementação, não garantias da biblioteca.

### 3. Booksy — Features of Booksy

URL: https://biz.booksy.com/en-us/features

**Acesso:** conteúdo obtido por WebFetch; página comercial dos Estados Unidos.

**Fatos:** descreve perfis individuais de funcionários, serviços atribuídos, horários e gestão de agendamentos; turnos/ausências; antecedência para reservas/remarcações, buffers e períodos de processamento. Também apresenta reservas online, lembretes, lista de espera, recursos como salas/equipamentos e cinco níveis de permissão de funcionários. Os registros de clientes podem incluir contatos, histórico, notas, fotos e formulários.

**Implicação:** separar cadastro de serviço da habilitação de cada profissional e distinguir expediente de bloqueios excepcionais. A quantidade de dados de cliente oferecida pelo concorrente não justifica coletar tudo no MVP. Aplicar minimização e acesso por função. A página não especifica mecanismos de criptografia, autenticação ou auditoria; não inferir esses controles.

### 4. Fresha — página oficial para negócios

URL: https://www.fresha.com/for-business

**Acesso:** conteúdo obtido por WebFetch após a URL específica de agendamento retornar 404.

**Fatos:** apresenta calendários de agendamentos, gestão de equipe, múltiplas unidades, acesso móvel, reservas online, lembretes por email/SMS, remarcações, depósitos e pagamento antecipado. Perfis de clientes podem reunir preferências e histórico. A página não detalha regras de conflito, níveis de permissão ou mecanismos de autenticação.

**Implicação:** distinguir unidade, profissional e atendimento desde o modelo, mesmo que o MVP use uma só unidade. Registrar preferências de comunicação separadamente da reserva. Depósitos exigem desenho próprio de estados de pagamento e cancelamento; a página não comprova comportamento transacional.

**Limite de segurança:** selos/alegações de conformidade presentes no marketing não foram validados contra certificados, escopo de auditoria ou termos contratuais. Não são evidência suficiente de conformidade da BARBER PRIME.

### 5. Square Appointments — Booking System Features

URL: https://squareup.com/us/en/appointments/features

**Acesso:** conteúdo obtido por WebFetch; oferta dos Estados Unidos.

**Fatos:** apresenta calendários individuais de equipe, múltiplas unidades/fusos, bloqueios por Google Calendar, reservas de serviços com diferentes profissionais, períodos de processamento, salas/equipamentos, lembretes e lista de espera. Descreve permissões por função e códigos individuais de acesso ao ponto de venda.

**Implicação:** modelar capacidade de profissional separadamente de cadeira/sala; avaliar se períodos de processamento realmente liberam o barbeiro no negócio. Uma reserva com vários serviços pode exigir segmentos com profissionais e durações diferentes. Código de acesso de POS não comprova como funciona a autenticação web. A página consultada não estabelece a disponibilidade de cada recurso em cada plano nem sua oferta no Brasil.

### 6. FullCalendar — Premium

URL: https://fullcalendar.io/docs/premium

**Acesso:** conteúdo obtido por WebFetch.

**Fatos:** Premium acrescenta visualizações de recursos: timeline horizontal e visualização vertical com coluna por recurso. A página descreve avaliação sem limite de tempo, mas com restrições que impedem usar a avaliação em produção comercial e distribuir código modificado sob esses termos.

**Implicação:** representar cada barbeiro como recurso é aderente à visão operacional lado a lado. Contudo, avaliação gratuita e ausência/supressão de aviso visual não equivalem a licença de produção. O componente não oferece, por si só, persistência, autorização ou garantia contra conflitos.

### 7. FullCalendar — License

URL: https://fullcalendar.io/license

**Acesso:** conteúdo obtido por WebFetch.

**Fatos e distinções de licença:**

- Plugins não Premium e o bundle Standard usam **MIT**, permitindo uso comercial sem pagamento ao FullCalendar, preservados os avisos exigidos.
- Plugins Premium e o bundle Scheduler têm termos próprios. Para aplicação comercial proprietária, a opção pertinente é a **licença comercial**; verificar o contrato e suas condições de redistribuição antes da adoção.
- A página descreve exceção para entidades sem fins lucrativos registradas, excluindo governos e universidades, sob condições próprias. Uma barbearia comercial não se enquadra por ser pequena ou estar em MVP.
- A página atual informa que, **a partir da v7**, a alternativa copyleft passa de GPLv3 para **AGPLv3**, com obrigações referentes ao código cliente e servidor e acesso ao código para usuários pela rede. Não presumir que uma aplicação proprietária possa usar essa alternativa sem cumprir suas obrigações.

**Decisão recomendada:** MVP de baixo custo pode usar views Standard com filtro por barbeiro, sem afirmar que isso reproduz a view nativa de recursos. Se colunas simultâneas por barbeiro forem requisito indispensável, incluir Premium no orçamento ou comparar outra solução com licença apropriada. Fixar a versão pretendida e conferir seus termos: documentação atual não prova a licença de qualquer versão histórica. Resumo técnico, não parecer jurídico.

### 8. Comunidade — Stack Overflow: Preventing double booking

URL canônica: https://stackoverflow.com/questions/7845160/preventing-double-booking

URLs efetivamente lidas pela API pública, após falha no acesso à página:

- https://api.stackexchange.com/2.3/questions/7845160?site=stackoverflow&filter=withbody
- https://api.stackexchange.com/2.3/questions/7845160/answers?site=stackoverflow&filter=withbody&sort=votes

**Acesso e autenticidade:** WebFetch não conseguiu abrir a página nem o endpoint da pergunta; os dois endpoints acima foram posteriormente consultados com sucesso por HTTPS via curl, sem autenticação. Foram lidos a pergunta e cinco respostas reais, não apenas trechos do buscador. A API indica licença de conteúdo **CC BY-SA 3.0**. Nenhum código foi copiado.

**Discussão:** Clinton descreve em 2011 um caso Oracle 10g em que duas sessões inserem trabalhos sobrepostos para o mesmo funcionário, apesar da checagem de ausência de conflito. Klas Lindbäck sugere bloquear a linha do funcionário antes da inserção, em vez da tabela inteira. Kevin Burton propõe subdividir o tempo e usar chave por funcionário/slot. Tony Andrews sugere materialized views com restrições e alerta sobre custo de desempenho. Há também sugestão de trigger e respostas de qualidade desigual; nenhuma aparece como aceita na API consultada.

**Interpretação, não garantia universal:** é uma discussão histórica, específica de banco e isolamento, não documentação normativa de qualquer banco atual. Um trigger que apenas consulta sobreposição não deve ser considerado prova de segurança concorrente. Slots únicos só resolvem o problema se toda a duração ocupada e os intervalos forem representados coerentemente.

**Implicação:** escolher uma estratégia de integridade adequada ao banco da BARBER PRIME e testar duas confirmações/remarcações concorrentes para o mesmo barbeiro. A estratégia deve abranger todas as rotas de escrita. Não bloquear toda a barbearia se for possível isolar por profissional/recurso.

### 9. DEV Community — Preventing Double-Booking in a Real-Time Appointment System

URL: https://dev.to/technonazmul/preventing-double-booking-in-a-real-time-appointment-system-55l0

**Acesso:** conteúdo obtido por WebFetch. Autor apresentado: Nazmul Khalid. A captura mostra 30 de setembro, sem ano verificável.

**Fatos sobre o relato:** o autor descreve reservas temporárias com unicidade no MongoDB, expiração TTL, transação envolvendo agendamento/pagamento e notificações após commit. É relato comunitário, não comprovação independente dessas garantias.

**Limites:** a captura tem zero comentários; portanto, este artigo **não substitui a discussão real da fonte 8**. Não há testes de concorrência e não fica demonstrado como agendamentos confirmados continuam protegidos depois da exclusão das reservas temporárias. TTL não deve ser tratado como relógio exato de liberação sem validação técnica adicional.

## Implicações de segurança, privacidade e consistência

As medidas seguintes são recomendações de arquitetura derivadas da pesquisa, não funcionalidades já verificadas no projeto:

1. **Servidor autoritativo:** validar serviço habilitado, unidade, jornada, duração, buffers e conflito ao gravar. Arrastar um evento na UI solicita uma operação; não confirma sozinho a mudança.
2. **Autorização por função e escopo:** cliente acessa somente suas reservas; barbeiro, a agenda autorizada; recepção/gestão, o escopo necessário. Verificar isso em cada endpoint, inclusive por identificadores de reserva/profissional, sem confiar em filtros do frontend.
3. **Disponibilidade pública minimizada:** devolver horários livres, sem nomes, telefones, notas ou detalhes de outros clientes. Separar payload público de payload administrativo e evitar dados pessoais desnecessários em URLs, logs e notificações.
4. **Concorrência e mudanças:** transação/controle de integridade no banco, tratamento de conflito com mensagem clara e proteção contra duplicação por reenvio. Testar criação, remarcação, cancelamento e eventual expiração de reserva temporária. Atualização em tempo real melhora a experiência, mas não substitui integridade.
5. **Tempo:** definir fuso da unidade, armazenar instantes de maneira consistente e tratar limites de intervalos sem considerar dois atendimentos adjacentes como conflito. Serviços, pausas e buffers precisam entrar no cálculo do tempo ocupado.
6. **LGPD e comunicação:** definir finalidade, base legal adequada, retenção, exclusão e atendimento ao titular. Não presumir consentimento de marketing a partir da reserva nem basear todo tratamento em consentimento. Fotos, notas e formulários exigem necessidade e acesso restrito. Esta pesquisa não consultou orientação jurídica ou regulatória específica.
7. **Pagamentos e fornecedores:** se entrarem no escopo, preferir provedor especializado sem armazenar dados completos de cartão; avaliar contratos, subprocessadores, localização/transferência de dados e políticas de acesso. Não deduzir segurança ou disponibilidade contratual a partir de páginas de marketing.

## Registro de acesso incompleto e tentativas não utilizadas como evidência

Estas tentativas não acrescentam fontes substantivas às nove acima:

| URL/tentativa | Resultado observado |
| --- | --- |
| https://www.fresha.com/for-business/features/appointment-scheduling | HTTP 404; corpo não obtido. Substituída pela página oficial para negócios. |
| https://www.reddit.com/r/webdev/comments/tnwkr9/making_someone_a_website_with_appointment_booking/ | WebFetch informou impossibilidade de buscar o domínio; não foram lidos comentários. |
| https://www.reddit.com/r/webdev/comments/tnwkr9/making_someone_a_website_with_appointment_booking/.json | Mesmo impedimento; não utilizada como discussão comprovada. |
| https://stackoverflow.com/questions/7845160/preventing-double-booking | WebFetch não conseguiu buscar o domínio; conteúdo recuperado posteriormente pela API conforme fonte 8. |
| https://api.stackexchange.com/2.3/questions/7845160?site=stackoverflow&filter=withbody | Falhou no WebFetch; funcionou depois por curl HTTPS. |
| https://www.stackprinter.com/export?question=7845160&service=stackoverflow&language=en&hideAnswers=false&showAll=true&width=640 | Página aberta, mas retornou mensagem de servidor StackExchange ocupado, sem pergunta/respostas. |
| https://stackoverflow.stackprinter.appspot.com/export?format=HTML&service=stackoverflow&question=7845160&printer=false | Falha de correspondência do certificado TLS; não se desabilitou a validação. |
| https://stackprinter.appspot.com/export?format=HTML&service=stackoverflow&question=7845160&printer=false | Página de erro de servidor ocupado; sem conteúdo da discussão. |

Nenhum CAPTCHA foi explicitamente apresentado nas respostas das ferramentas. Falha de ferramenta/domínio não foi reclassificada como CAPTCHA. Páginas autenticadas, fluxos de reserva, contratos comerciais completos, auditorias de segurança e integrações reais não foram abertos/testados. Resultados de busca serviram para descoberta; as conclusões acima se apoiam nos conteúdos efetivamente recuperados e nas limitações declaradas.
