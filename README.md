# ipbx-mcp

Servidor [MCP](https://modelcontextprotocol.io) do IPBX em TypeScript. Transporte **Streamable HTTP** em modo stateless, autenticação por **bearer estático** e/ou **OAuth 2.1 + Google Workspace**, persistência local em SQLite (clients OAuth, refresh tokens, audit log). Herdado do scaffold `base-mcp`, expõe os dados do PABX (MySQL) como tools tipadas.

URL pública em produção: `https://mcp.ipbx.vivavox.com.br`.

## Requisitos

- Node.js **>= 22** (`better-sqlite3` v12 precisa)
- Para OAuth: OAuth Client no Google Cloud Console em modo **Internal**

## Instalação

```bash
npm install
cp .env.example .env   # depois preencha os valores reais
npm run build
```

## Configuração

Carregue o `.env` no processo (systemd `EnvironmentFile=`, docker `env_file:`, ou `node --env-file=.env` na hora do start).

### Obrigatórias

**Pelo menos um** dos caminhos de auth:

| Variável            | Quando usar                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| `MCP_AUTH_TOKEN`    | Bearer estático — Claude Desktop, CLI, API, scripts, cron                |
| `OAUTH_JWT_SECRET` + `OAUTH_ISSUER` | OAuth — clientes via claude.ai (web/mobile)              |

### OAuth (opcional, mas necessário pra claude.ai)

| Variável                | Descrição                                                                 |
| ----------------------- | ------------------------------------------------------------------------- |
| `OAUTH_ISSUER`          | URL canônica do servidor (ex: `https://mcp.ipbx.vivavox.com.br`)          |
| `OAUTH_JWT_SECRET`      | Chave HS256 dos JWTs (32 bytes hex)                                       |
| `GOOGLE_CLIENT_ID`      | Do OAuth Client no Google Cloud Console                                   |
| `GOOGLE_CLIENT_SECRET`  | Do OAuth Client no Google Cloud Console                                   |
| `ALLOWED_GOOGLE_HD`     | Domínio Workspace permitido (default: `vivavox.com.br`)                   |

Quando todas estão presentes, as rotas `/authorize`, `/oauth/google/callback`, `/token` e `/register` (DCR) são montadas. Sem elas, só o bearer estático funciona.

### Outras

| Variável             | Default        | Descrição                                       |
| -------------------- | -------------- | ----------------------------------------------- |
| `PORT`               | `3000`         | Porta HTTP                                      |
| `HOST`               | `0.0.0.0`      | Interface (use `127.0.0.1` em dev local)        |
| `MCP_ALLOWED_HOSTS`  | —              | Lista CSV de hosts aceitos no header `Host`     |
| `SQLITE_PATH`        | `./data/app.db`| Caminho do arquivo SQLite                       |

### MySQL (fonte de dados do IPBX)

| Variável            | Default | Descrição                                          |
| ------------------- | ------- | -------------------------------------------------- |
| `MYSQL_HOST`        | —       | Host do MySQL                                      |
| `MYSQL_PORT`        | `3306`  |                                                    |
| `MYSQL_USER`        | —       | Use um usuário dedicado com `GRANT SELECT` apenas  |
| `MYSQL_PASSWORD`    | —       |                                                    |
| `MYSQL_DATABASE`    | —       |                                                    |
| `MYSQL_POOL_LIMIT`  | `5`     | Tamanho do pool (`mysql2`)                         |
| `MYSQL_SSL`         | vazio   | Qualquer valor liga TLS com verificação de cert    |
| `IPBX_ID`           | —       | Tenant que esta instância atende (ver abaixo)      |

O banco é multi-tenant — uma instância Asterisk por cliente, tabela `ipbx` — mas **cada instância do MCP atende um tenant só**. Todas as queries filtram por `IPBX_ID`, e nenhuma tool aceita esse id como parâmetro: assim o isolamento entre clientes não depende do que o modelo passa na chamada. Um container e um subdomínio por tenant.

Gere tokens aleatórios com:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Endpoints

| Método | Path                                              | Auth     | Descrição                            |
| ------ | ------------------------------------------------- | -------- | ------------------------------------ |
| POST   | `/mcp`                                            | bearer   | JSON-RPC do MCP via Streamable HTTP  |
| GET    | `/mcp`                                            | bearer   | `405`                                |
| DELETE | `/mcp`                                            | bearer   | `405`                                |
| GET    | `/health`                                         | público  | `{"status":"ok"}`                    |
| GET    | `/.well-known/oauth-authorization-server`         | público  | RFC 8414 metadata                    |
| GET    | `/.well-known/oauth-protected-resource`           | público  | RFC 9728 metadata                    |
| POST   | `/register`                                       | público  | Dynamic Client Registration (RFC 7591) |
| GET    | `/authorize`                                      | público  | Redireciona pro Google                |
| GET    | `/oauth/google/callback`                          | público  | Recebe o redirect do Google           |
| POST   | `/token`                                          | público  | `authorization_code` / `refresh_token` |

`401` no `/mcp` inclui `WWW-Authenticate: Bearer realm=..., resource_metadata=...` — sem isso claude.ai não descobre o AS no primeiro contato.

## Tools disponíveis

Nome das tools segue `ipbx_<model>_<action>`, com `<action>` no vocabulário `list` / `get` / `search` / `count`.

### `ipbx_instance_get`

Dados de cadastro da instância IPBX que este servidor atende — nome, IP e portas SIP/AMI.

**Parâmetros:** nenhum. A instância é fixa, definida por `IPBX_ID` no ambiente.

**Retorno:**

```json
{
  "id": 1,
  "shortname": "vivavox",
  "fullname": "Vivavox Telecom",
  "ipaddr": "138.94.55.155",
  "sipport": 5601,
  "amiport": 6501,
  "created": "2024-06-17T16:37:59.000Z",
  "updated": "2024-06-17T16:37:59.000Z"
}
```

Devolve `isError` se o `IPBX_ID` configurado não existir na tabela `ipbx`.

### `ipbx_branch_list`

Lista os ramais da instância.

**Parâmetros:**

- `search` (string, opcional): busca parcial por número do ramal ou nome
- `limit` (number, opcional): 1–500, default `100`

**Retorno:**

```json
{
  "total": 27,
  "truncated": false,
  "branches": [
    {
      "id": 2,
      "exten": "23",
      "name": "Ricardo Landim",
      "group": "Suporte",
      "record": true,
      "webrtc": false,
      "dtmf": "rfc4733",
      "forward_busy": "035988023317",
      "forward_noanswer": "035988023317",
      "forward_noanswer_wait": 5
    }
  ]
}
```

**Não retorna as credenciais SIP.** As colunas `password` (senha em claro) e `username` (identificador de autenticação, diferente do número do ramal) ficam de fora por design — juntas permitem registrar um softphone e originar chamadas na conta do cliente. A lista de colunas no `SELECT` é explícita justamente para que nenhuma delas entre por descuido.

### `ipbx_user_list`

Lista os usuários do painel da instância.

**Parâmetros:**

- `search` (string, opcional): busca parcial por nome ou email
- `limit` (number, opcional): 1–500, default `100`

**Retorno:**

```json
{
  "total": 6,
  "truncated": false,
  "users": [
    {
      "id": 11,
      "name": "Suporte",
      "email": "suporte@vivavox.com.br",
      "created": "2024-07-10T13:56:41.000Z",
      "updated": "2024-07-10T13:56:41.000Z"
    }
  ]
}
```

**Não retorna a senha de acesso.** A coluna `secret` fica de fora: é a senha de login do painel, guardada **em texto puro** no banco (sem hash). Expor isso entregaria acesso administrativo ao PABX.

### `ipbx_group_list`

Lista os grupos de ramais da instância, com quantos ramais cada um tem.

**Parâmetros:**

- `search` (string, opcional): busca parcial por nome ou descrição
- `limit` (number, opcional): 1–500, default `100`

**Retorno:**

```json
{
  "total": 6,
  "truncated": false,
  "groups": [
    {
      "id": 1,
      "name": "Suporte",
      "description": "Grupo do suporte",
      "branches": 11
    }
  ]
}
```

A tabela `groups` não guarda credenciais — ao contrário de `branch` e `users`, aqui todas as colunas são expostas.

### `ipbx_trunk_list`

Lista os troncos da instância.

**Parâmetros:**

- `search` (string, opcional): busca parcial por nome ou host
- `limit` (number, opcional): 1–500, default `100`

**Retorno:**

```json
{
  "total": 2,
  "truncated": false,
  "trunks": [
    {
      "id": 1,
      "name": "Vivavox",
      "host": "sip.vivavox.com.br",
      "port": "5060",
      "register": true,
      "record": true,
      "auth": "credentials"
    }
  ]
}
```

**Não retorna as credenciais da operadora.** `username` e `password` ficam de fora — são a credencial mais valiosa do banco, já que permitem originar chamadas direto pela operadora, tarifadas na conta. No lugar delas vai `auth`, que diz apenas *como* o tronco autentica: `"credentials"` (usuário/senha) ou `"ip"` (allowlist de IP, sem senha).

### `ipbx_queue_list`

Lista as filas de atendimento, com a estratégia de distribuição e quantos membros cada uma tem.

**Parâmetros:** `search` (string, opcional), `limit` (1–500, default `100`)

```json
{
  "total": 5,
  "queues": [
    { "id": 1, "name": "Suporte", "strategy": "ringall", "members": 8 },
    { "id": 5, "name": "Teste", "strategy": "leastrecent", "members": 1 }
  ]
}
```

### `ipbx_queue_member_list`

Lista os membros das filas, na ordem de toque.

**Parâmetros:**

- `queue_id` (number, opcional): filtra uma fila; omita para trazer todas
- `limit` (number, opcional): 1–500, default `200`

**Retorno:**

```json
{
  "total": 8,
  "members": [
    {
      "queue_id": 1,
      "queue": "Suporte",
      "position": 1,
      "type": "branch",
      "exten": "29",
      "name": "Mateus Damaceno",
      "ref": "branch-10"
    }
  ]
}
```

A coluna `queue_member.member` guarda uma referência no formato `<tipo>-<id>` — `branch-10` aponta para o `branch.id` 10, que é o ramal `29`. **Não é o número do ramal.** A tool resolve isso para `exten` + `name` quando o membro é um ramal. Nem todo membro é: existem entradas `redirect-N`, que voltam com `type: "redirect"` e `exten`/`name` nulos.

### `ipbx_ivr_list`

Lista as URAs, com o áudio associado e a transcrição do que é falado para quem liga.

**Parâmetros:** `search` (string, opcional — casa no nome **ou** no texto da transcrição), `limit` (1–500, default `100`)

```json
{
  "total": 1,
  "ivrs": [
    {
      "id": 5,
      "name": "URA Rompimento",
      "audio": "URA Rompimento",
      "transcription": "Olá, se você está com falta de conexão e o LED Loss do seu modem óptico...",
      "options": 1
    }
  ]
}
```

A transcrição é o campo mais útil: permite achar uma URA pelo que ela diz, não só pelo nome.

### `ipbx_ivr_option_list`

Lista as opções das URAs — qual tecla leva a qual destino.

**Parâmetros:**

- `ivr_id` (number, opcional): filtra uma URA; omita para trazer todas
- `limit` (number, opcional): 1–500, default `200`

**Retorno:**

```json
{
  "total": 7,
  "options": [
    {
      "ivr_id": 1,
      "ivr": "URA Principal - Horario comercial",
      "digit": "1",
      "goto": { "type": "queue", "name": "Financeiro", "exten": null, "ref": "queue-3" }
    },
    {
      "ivr_id": 1,
      "ivr": "URA Principal - Horario comercial",
      "digit": "7X",
      "goto": { "type": "internal", "name": null, "exten": null, "ref": "internal" }
    }
  ]
}
```

`ivr_option.goto` é **polimórfico**: aponta para 5 tabelas diferentes (`branch`, `queue`, `ivr`, `redirect`, `app`) no formato `<tipo>-<id>`, e ainda aceita literais sem id (`internal`). A tool resolve o nome do destino em todos os casos; literais voltam com `name` nulo e o `ref` preservado.

O campo `digit` nem sempre é um dígito: `t` é timeout e padrões como `7X` casam faixas de ramal.


Toda chamada gera uma linha em `audit_log` com a identidade do chamador: email Google se JWT, `service:static` se bearer estático.

## Comandos

```bash
npm run build      # tsc
npm run check      # tsc --noEmit (sem emitir)
npm run dev        # tsc --watch
npm start          # node dist/index.js
npm run inspect    # MCP Inspector
```

Smoke test local:

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/.well-known/oauth-authorization-server
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Deploy

### Docker (recomendado)

`Dockerfile` multi-stage (`node:22-slim`), runtime como user não-root `mcp`, expõe `/data` como volume pro SQLite, healthcheck via `/health`. Em produção o deploy é automático via `.github/workflows/deploy.yml` (push de tag `vX.Y.Z` → build no GHCR → `docker run` na VPS). Manualmente:

```bash
docker image build . -t ipbx-mcp:1.0

docker container run -d --env-file .env -p 50020:3000 \
  -v ipbx_data:/data --restart unless-stopped --name ipbx-mcp ipbx-mcp:1.0

docker stop ipbx-mcp && docker rm ipbx-mcp
docker logs -f ipbx-mcp
```

Backup do SQLite:

```bash
docker run --rm \
  -v ipbx_data:/data \
  -v $PWD:/backup \
  alpine tar czf /backup/sqlite-bkp.tgz -C /data .
```

### systemd

```ini
[Unit]
Description=ipbx-mcp
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/local/ipbx-mcp
ExecStart=/usr/bin/node dist/index.js
EnvironmentFile=/var/local/ipbx-mcp/.env
User=mcp
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

`EnvironmentFile=` é o equivalente nativo do systemd para `.env`. Use um usuário dedicado (`mcp`) em vez de `root`.

## Configurando em um cliente MCP

### Claude Desktop / CLI (bearer estático)

```json
{
  "mcpServers": {
    "ipbx": {
      "type": "http",
      "url": "https://mcp.ipbx.vivavox.com.br/mcp",
      "headers": {
        "Authorization": "Bearer SEU_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

### claude.ai (OAuth)

Adicionar como Custom Connector usando `https://mcp.ipbx.vivavox.com.br/mcp`. O flow OAuth dispara automaticamente — claude.ai descobre o AS via `WWW-Authenticate`, registra um client via DCR, redireciona pro Google, recebe o code e troca por um access token.

## Estrutura

```
src/
  index.ts            # bootstrap HTTP, leitura de env, registro de rotas
  server.ts           # createServer() registra as tools (ipbx_*)
  mysql.ts            # pool mysql2 + queries do IPBX (tenant fixo)
  sqlite.ts           # better-sqlite3 + apply schemas
  audit.ts            # logToolCall() -> audit_log
  auth/
    jwt.ts            # sign/verify HS256 (jose)
    middleware.ts     # requireAuth: JWT -> fallback bearer estático
  oauth/
    routes.ts         # registerOAuthRoutes()
    store.ts          # DCR clients, codes, refresh, authorize-tx
    google.ts         # OAuth do Google (authorize URL + token exchange)
    pkce.ts           # verificação S256 em tempo constante
sql/
  001_oauth_schema.sql           # oauth_clients, oauth_codes, oauth_refresh_tokens, audit_log
  002_oauth_authorize_tx.sql     # oauth_authorize_tx (state Google <-> params)
Dockerfile
.github/workflows/deploy.yml     # build GHCR + deploy SSH na VPS
```
