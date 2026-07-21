# CLAUDE.md

Guia para o Claude Code ao trabalhar neste repositório.

## Visão geral

Servidor MCP do IPBX em TypeScript (módulo ESM, transporte **Streamable
HTTP** em modo stateless). Nasceu do scaffold `base-mcp`, que já traz a
infra reaproveitável — validação de input, autenticação de usuários
(bearer estático + OAuth) e auditoria. Expõe os dados do PABX
(MySQL, ver `src/mysql.ts`) como tools tipadas em `src/server.ts`.

URL pública canônica: `https://mcp.ipbx.vivavox.com.br`.

## Stack

- `@modelcontextprotocol/sdk` — `McpServer` + `StreamableHTTPServerTransport`
  + `createMcpExpressApp` (Express embutido no SDK)
- `better-sqlite3` — persistência local (OAuth + audit)
- `jose` — assinatura/validação de JWTs
- `zod` — schemas de input das tools
- TypeScript estrito, alvo `ES2022`, `module: Node16`

## Infra de produção

- **URL canônica:** `https://mcp.ipbx.vivavox.com.br`
- **Reverse proxy:** Nginx Proxy Manager em Docker, IP público
  `191.252.178.174` (compartilhado pelos MCPs `*.vivavox.com.br`).
  Termina TLS com Let's Encrypt.
- **Backend Node:** host:porta internos do container `ipbx-mcp`
  (deploy mapeia `50020:3000`). NPM faz `proxy_pass` direto —
  subdomínio mapeia pra raiz, sem reescrita de path.
- **Streamable HTTP no NPM:** a aba Advanced do Proxy Host precisa de
  `proxy_buffering off; proxy_read_timeout 24h; proxy_send_timeout 24h;`.
  O resto (`Connection`, `Upgrade`, `proxy_http_version`) o template
  do NPM já injeta — duplicar dá erro de validação.
- **Decisão arquitetural — um subdomínio por MCP, nunca subpath:**
  spec OAuth do MCP busca `/.well-known/oauth-*` na raiz do host.
  Subpath quebra discovery e mistura cookies entre MCPs. Convenção
  de nomes: `mcp.<servico>.vivavox.com.br` (ex: próximo MCP nasce
  como `mcp.outroservico.vivavox.com.br`).

## Arquitetura

- `src/index.ts` — bootstrap HTTP. Lê `PORT`, `HOST`, `MCP_ALLOWED_HOSTS`,
  cria o app Express via `createMcpExpressApp`, expõe `POST /mcp`,
  `GET /health` e `405` para `GET|DELETE /mcp`.
- `src/server.ts` — `createServer()` instancia o `McpServer` e registra
  cada tool. Chamado **uma vez por requisição** (modo stateless), então
  evite estado mutável no escopo do módulo.
- `src/sqlite.ts` — `getDb()` lazy. Abre `SQLITE_PATH` (default
  `./data/app.db`), aplica pragmas (`journal_mode=WAL`,
  `foreign_keys=ON`) e roda todos os `sql/*.sql` em ordem alfabética
  (idempotente — schemas usam `IF NOT EXISTS`).
- `src/mysql.ts` — acesso ao MySQL do IPBX (fonte de dados das tools).
  Pool singleton lazy (`getPool()`), envs lidas sob demanda, helper
  `query()` usando `execute` (prepared statement, nunca interpolação).
  `getIpbxId()` lê e valida o tenant. Tipos de linha e funções de
  consulta ficam aqui; as tools em `server.ts` só orquestram.
- `src/audit.ts` — `logToolCall()` grava cada chamada de tool em
  `audit_log` com identidade, duração e resultado. Falha de audit
  não derruba a chamada da tool (loga e segue).
- `src/auth/jwt.ts` — assinatura/verificação de access tokens HS256
  via `jose`. TTL exposto em `ACCESS_TTL_SECONDS`.
- `src/auth/middleware.ts` — `requireAuth`: tenta JWT primeiro, cai
  pro bearer estático. 401 inclui `WWW-Authenticate` com
  `resource_metadata` (necessário pro discovery do claude.ai).
- `src/oauth/routes.ts` — registra todos os endpoints OAuth.
  Coordena `store.ts` (clients/codes/refresh/tx), `pkce.ts` e
  `google.ts`. Só é montado se o flow OAuth estiver completo
  (`OAUTH_FLOW_READY` em `index.ts`).
- `src/oauth/store.ts` — DCR clients, authorization codes (single-use
  atômico), refresh tokens (rotação), authorize-tx (state Google
  ↔ params do cliente).
- `src/oauth/google.ts` — cliente do IdP: monta URL de authorize,
  troca code, valida `id_token` contra a JWKS do Google.
- `src/oauth/pkce.ts` — verificação S256 em tempo constante.

## Modo stateless e ciclo de vida

Cada `POST /mcp` faz: `createServer()` → novo `StreamableHTTPServerTransport`
com `sessionIdGenerator: undefined` → `server.connect(transport)` →
`transport.handleRequest`. No `res.on("close")` fechamos transport e server.
Não cacheie o `McpServer` no escopo do módulo: o ciclo é por requisição.
A conexão SQLite (`getDb()`) é singleton — better-sqlite3 já é seguro
pra uso concorrente leitor/escritor no mesmo processo (WAL).

## Segurança

Dois caminhos de auth coexistem em `/mcp` (POST/GET/DELETE) — pelo
menos um precisa estar configurado, o servidor não inicia sem
nenhum. `/health` e as rotas OAuth (`/.well-known/*`, `/register`,
`/authorize`, `/oauth/google/callback`, `/token`) são públicas.

**1. Bearer estático** (cobre Claude Desktop, CLI, API, scripts):

- Header `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- Comparação em tempo constante (`crypto.timingSafeEqual`).
- Identidade no audit: `auth_kind='service'`, `user_email='service:static'`.

**2. OAuth 2.1 + Google Workspace** (cobre claude.ai web/mobile):

- Discovery via `/.well-known/oauth-authorization-server` e
  `/.well-known/oauth-protected-resource` (RFC 8414 + 9728).
- Dynamic Client Registration (RFC 7591) público em `/register`.
- `/authorize` → redireciona pro Google com `hd=vivavox.com.br`.
- `/oauth/google/callback` → valida `id_token` (JWKS do Google) +
  claim `hd`.
- `/token` → `authorization_code` (PKCE S256 obrigatório) e
  `refresh_token` (rotação a cada uso).
- Access tokens são JWTs HS256 — **não persistidos no DB**. Refresh
  tokens são opacos e ficam em `oauth_refresh_tokens`.
- Audiência: time interno + parceiros/consultorias, todos com email
  `@vivavox.com.br`. Defesa em profundidade: consent screen em modo
  **Internal** (bloqueia logins fora do Workspace na origem) +
  validação do claim `hd` no callback.
- Identidade no audit: `auth_kind='user'`, `user_email=<email Google>`.

O `requireAuth` tenta JWT primeiro e cai pro bearer estático. Quando
todos os clientes migrarem, mata o `MCP_AUTH_TOKEN`.

Resposta 401 do `/mcp` inclui `WWW-Authenticate: Bearer realm=...,
resource_metadata="<issuer>/.well-known/oauth-protected-resource"` —
sem isso claude.ai não descobre o AS no primeiro contato.

**Continua dependendo da infra (NPM):** TLS, rate limiting,
restrição de IP. Documente quando alguma for adicionada na
camada de aplicação.

## Convenções

- Variáveis lidas no bootstrap (`src/index.ts`, fail-fast): pelo menos
  um caminho de auth (`MCP_AUTH_TOKEN` ou `OAUTH_JWT_SECRET +
  OAUTH_ISSUER`). Transporte: `PORT`, `HOST`, `MCP_ALLOWED_HOSTS`.
- Variáveis lidas sob demanda: envs do Google (`GOOGLE_*`,
  `ALLOWED_GOOGLE_HD`) são lidas dentro do código OAuth e lançam erro
  se ausentes na primeira chamada.
- **Nome de tool: `ipbx_<model>_<action>`.** Mesmo padrão dos outros
  MCPs da Vivavox (`voxxer_client_get`, `noc_bgp_list`). `<model>` é a
  entidade (`branch`, `queue`, `trunk`, `cdr`); `<action>` vem do
  vocabulário `list` / `get` / `search` / `count`. A instância em si é
  `instance` — `ipbx_instance_get`, não `ipbx_ipbx_get`.
- Tools devem capturar erros e devolver `{ isError: true, content: [...] }`
  em vez de deixar a exceção propagar pro transporte.
- Validação de input via `zod` é obrigatória para toda tool.
- O retorno padrão de uma tool é um único bloco `text` com JSON
  `JSON.stringify(obj, null, 2)`.
- Logs em `console.error` (vai pro stderr/journald). `console.log` está
  livre agora que não usamos stdio, mas mantenha tudo em stderr para
  consistência.
- Toda chamada de tool gera linha em `audit_log` com identidade do
  chamador (`user_email` quando JWT, `auth_kind='service'` e
  `user_email='service:static'` quando bearer estático).

## Tools

- `ipbx_instance_get` — dados de cadastro do tenant configurado (nome,
  IP, portas SIP/AMI). Sem parâmetros: a instância vem de `IPBX_ID`.
  Serve de template para novas tools.
- `ipbx_branch_list` — ramais do tenant, com nome do grupo resolvido
  por join. Filtro `search` opcional e `limit` 1–500 (default 100).
  Nunca retorna `password` nem `username` (credencial SIP).
- `ipbx_user_list` — usuários do painel (nome, email, datas). Mesmo
  `search`/`limit`. Nunca retorna `secret` (senha do painel, em claro).
- `ipbx_group_list` — grupos de ramais com a contagem de ramais de
  cada um. Mesmo `search`/`limit`. Tabela sem coluna sensível.
- `ipbx_trunk_list` — troncos (nome, host da operadora, porta, se
  registra/grava). Mesmo `search`/`limit`. Nunca retorna `username`
  nem `password`; em lugar deles devolve `auth: "credentials" | "ip"`.
- `ipbx_queue_list` — filas de atendimento com estratégia e contagem
  de membros. Mesmo `search`/`limit`.
- `ipbx_queue_member_list` — membros das filas na ordem de toque,
  com `branch-<id>` resolvido para número e nome do ramal. Filtro
  `queue_id` opcional, `limit` default 200.
- `ipbx_ivr_list` — URAs com áudio associado e a **transcrição** do
  que é falado (`audio.transcription`). `search` casa também no texto
  da transcrição.
- `ipbx_ivr_option_list` — tecla → destino, com o `goto` polimórfico
  resolvido (branch/queue/ivr/redirect/app + literais). Filtro
  `ivr_id` opcional, `limit` default 200.
- `ipbx_redirect_list` — ramais curtos que encaminham pra número
  externo por um tronco. São os `redirect-<id>` que aparecem como
  destino em fila, URA e roteamento. `forward` é telefone pessoal em
  100% das linhas: não logar no `audit_log`.
- `ipbx_routing_list` — planos de roteamento (entrada/saída) com
  contagem de regras e janelas.
- `ipbx_routing_time_list` — janelas de horário, com o `pattern` do
  Asterisk quebrado em lista de faixas. Filtro `routing_id` opcional.
- `ipbx_routing_rule_list` — o dialplan: padrão casado, dígitos
  suprimidos, prefixo e destino resolvido. `goto1` aceita um tipo a
  mais que o da URA (`trunk`), daí seis joins. Filtro `routing_id`
  opcional, `limit` default 200.
- Nova capacidade = uma tool em `src/server.ts` (schema `zod`,
  captura de erro devolvendo `{ isError: true }`, chamada a
  `logToolCall`). Integrações externas com estado/cliente próprio
  ganham um módulo tipado dedicado em `src/` (ex: `src/<servico>.ts`),
  em vez de chamar o SDK solto dentro da tool.

## Armadilhas do schema do PABX

Descobertas ao construir as tools. Valem pra qualquer query nova:

- **Sem foreign keys.** Nenhuma relação é imposta pelo banco. Use
  `LEFT JOIN` nas relações — com `INNER` um registro órfão some da
  lista em silêncio, que é o pior tipo de bug.
- **Palavras reservadas.** As tabelas `groups` e a coluna
  `queue_member.index` precisam de crase no MySQL 8.
- **Referência polimórfica por id embutido em string.** Tanto
  `queue_member.member` quanto `ivr_option.goto` guardam
  `<tipo>-<id>` — `branch-10` é o **`branch.id`** 10 (ramal 29), não o
  número do ramal. O `goto` aponta pra 5 tabelas diferentes
  (`branch`, `queue`, `ivr`, `redirect`, `app`) e ainda aceita literal
  sem id (`internal`). Resolva com um LEFT JOIN por tipo, casando pelo
  prefixo, e trate o literal — nunca assuma um único destino.
  `routing_rule.goto1` segue o mesmo formato e aceita **`trunk`**
  além dos cinco.
- **Colunas mortas.** `routing_rule.goto2` e `goto3` existem e estão
  vazias em 100% das linhas. Não sumir com elas: expor só quando
  preenchidas.
- **Typo no schema.** A coluna é `supress` (um "p") em `routing_rule`
  e `trunk_processing`. As tools expõem como `suppress`.
- **Sujeira nos varchar.** Nomes vêm com espaço sobrando
  (`"Comercial "`, `"Suporte "`) e campos opcionais vêm como `""` em
  vez de `NULL`. Aplique `trim()` e normalize vazio pra `null`.
- **Colunas numéricas em varchar.** `queue_member.index` é
  `varchar(16)`: ordenar sem `CAST` dá ordem lexicográfica
  ("10" antes de "2").
- **`cdr` não tem `ipbx_id`.** É a única tabela com dado de tenant sem
  o discriminador. Antes de expor CDR, descobrir como amarrar a
  chamada ao tenant — senão vaza chamada entre clientes.

## Persistência local (SQLite)

Toda escrita do MCP vai pra um SQLite local: clients OAuth registrados
via DCR, authorization codes, refresh tokens, audit log. Vive em
arquivo apontado por `SQLITE_PATH` (default `./data/app.db` dev,
`/data/app.db` em prod via volume Docker). Acesso via `src/sqlite.ts`
+ `better-sqlite3`.

## Migrations SQL

Schemas adicionais vivem em `sql/NNN_descricao.sql` (numeração
sequencial). Dialeto: **SQLite**. Aplicar manualmente:

```bash
sqlite3 $SQLITE_PATH < sql/001_oauth_schema.sql
```

Em prod (container), executar dentro do container ou via
`docker exec`. O arquivo precisa estar no volume persistente.

Schemas existentes:

- `sql/001_oauth_schema.sql` — `oauth_clients`, `oauth_codes`,
  `oauth_refresh_tokens`, `audit_log`
- `sql/002_oauth_authorize_tx.sql` — `oauth_authorize_tx` (estado
  efêmero do flow Google, single-use)

## Deploy

Em prod o servidor roda em container Docker. `Dockerfile` multi-stage
(`node:22-slim`), runtime como user não-root `mcp`, expõe `/data`
como volume pro SQLite, healthcheck no `/health`. A imagem é publicada
no GHCR (`ghcr.io/<repo>`) e servida na VPS mapeando `50020:3000`.

### CI/CD — `.github/workflows/deploy.yml`

Deploy é automático: dispara no `push` de uma tag semver `vX.X.X`
(pre-release tipo `v1.2.3-rc1` é ignorado pelo filtro). `concurrency`
serializa deploys da mesma tag (sem cancelar o que está em andamento).
Dois jobs:

- **build (GHCR):** `checkout` → resolve a versão (tag `v1.2.3` →
  `1.2.3`, usada na imagem e no deploy) → Buildx → login no GHCR com o
  `GITHUB_TOKEN` do job → build & push com cache GHA. Tags da imagem:
  `{version}`, `{major}.{minor}` e `latest`.
- **deploy (VPS):** roda depois do build (`needs: build`) via
  `appleboy/ssh-action`. Faz login efêmero no GHCR de dentro da VPS
  (usa o `GITHUB_TOKEN` repassado, sem PAT persistido na máquina),
  `docker pull` da imagem versionada, `cd` pro `VPS_APP_DIR` (onde
  vive o `.env` de prod), para/remove o container antigo e sobe o novo
  com `--env-file .env -p 50020:3000 -v ipbx_data:/data --restart
  unless-stopped --name ipbx-mcp`. Depois faz logout + `image prune`
  e fecha com health check: polling em `http://127.0.0.1:50020/health`
  (10 tentativas, 3s cada) — se não responder, dumpa `docker logs` e
  falha o workflow.

Secrets necessários no repo (GitHub → Settings → Secrets and variables
→ Actions):

- `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` — acesso SSH à VPS.
- `VPS_SSH_PORT` — opcional, default `22`.
- `VPS_APP_DIR` — diretório na VPS que contém o `.env` de produção.
- GHCR usa o `GITHUB_TOKEN` embutido do Actions — sem secret manual.

Publicar uma versão = criar e empurrar a tag:

```bash
git tag v1.2.3 && git push origin v1.2.3
```

### Deploy manual (fallback)

Direto na VPS, sem pipeline (emergência ou primeira subida):

```bash
# build local
docker image build . -t ipbx-mcp:1.0

# run (detached)
docker container run -d --env-file .env -p 50020:3000 \
  -v ipbx_data:/data --restart unless-stopped --name ipbx-mcp ipbx-mcp:1.0

# stop + rm
docker stop ipbx-mcp && docker rm ipbx-mcp

docker logs -f ipbx-mcp
```

Backup do SQLite:

```bash
docker run --rm -v ipbx_data:/data -v $PWD:/backup \
  alpine tar czf /backup/sqlite-bkp.tgz -C /data .
```

Alternativa: rodar como serviço systemd com `EnvironmentFile=.env` e
`ExecStart=/usr/bin/node dist/index.js`.

## Comandos úteis

```bash
npm run build      # tsc
npm run check      # tsc --noEmit
npm start          # node dist/index.js (envs vem do ambiente / .env)
npm run dev        # tsc --watch
npm run inspect    # MCP Inspector
```

Smoke test rápido (local):

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/.well-known/oauth-authorization-server
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## O que NÃO fazer

- Não commitar `.env` ou `data/` (ambos no `.gitignore`).
- Não cachear o `McpServer` em escopo de módulo: stateless = um server
  por request.
- Não voltar pro transporte stdio: este servidor foi planejado pra
  rodar como daemon HTTP (Docker/systemd).
- Não bindar em `0.0.0.0` sem ter pelo menos um caminho de auth
  configurado. O bootstrap já recusa subir sem `MCP_AUTH_TOKEN` nem
  `OAUTH_JWT_SECRET+OAUTH_ISSUER`, mas vale o lembrete.
- Não aceitar login com email fora de `@vivavox.com.br`. Restrição da
  liderança. Valida o claim `hd` no callback do Google **mesmo** com
  consent screen Internal (defesa em profundidade).
- Não voltar pra URL subpath (`mcp.vivavox.com.br/ipbx`):
  spec OAuth do MCP exige well-known na raiz do host. Subdomínio por
  MCP é a forma certa.
- Não aceitar `ipbx_id` como parâmetro de tool. O banco é multi-tenant
  (uma instância Asterisk por cliente, tabela `ipbx`), mas cada MCP
  atende um tenant só, vindo de `IPBX_ID` no ambiente. Se virar
  parâmetro, o isolamento entre clientes passa a depender do que o
  modelo manda na chamada. Um container + um subdomínio por tenant.
- Não expor a coluna `password` da tabela `branch` — é a senha SIP do
  ramal em claro. Quem tem ramal + senha registra um softphone e
  origina chamadas. Vale o mesmo pra `username`: é `ext-17-NNN`, não
  o número do ramal, então é a outra metade da credencial.
- Não expor a coluna `secret` da tabela `users` — é a senha de login do
  painel, também **em texto puro** (verificado: 4 a 13 caracteres,
  nenhum padrão de hash). Dá acesso administrativo ao PABX.
- Nas duas: liste colunas explicitamente, nunca `SELECT *`.
- Não consultar `cdr` (~251k linhas) nem `sipcapture` (~1M) sem `LIMIT`
  obrigatório e filtro de período — estoura o contexto e o servidor.
- Não gravar payloads sensíveis / PII de tools no `audit_log` — logue
  só o metadado necessário pra rastrear a chamada. Evita PII no banco
  local.
- Não persistir access tokens (JWTs) no banco — são stateless e
  validados por assinatura. Só refresh tokens (opacos) vão pra
  `oauth_refresh_tokens`.
- Não publicar o OAuth consent screen como **External**: perde a
  restrição automática de domínio do Workspace e exige verificação
  do Google (semanas de espera).
