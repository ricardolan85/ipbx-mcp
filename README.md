# ipbx-mcp

Servidor [MCP](https://modelcontextprotocol.io) do IPBX em TypeScript. Transporte **Streamable HTTP** em modo stateless, autenticação por **bearer estático** e/ou **OAuth 2.1 + Google Workspace**, persistência local em SQLite (clients OAuth, refresh tokens, audit log). Herdado do scaffold `base-mcp` — hoje expõe só a tool `ping`; as capacidades do IPBX entram como novas tools.

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

### `ping`

Health check simples de exemplo: responde `pong`.

**Parâmetros:**

- `message` (string, opcional): mensagem ecoada de volta na resposta

**Retorno:**

```json
{
  "pong": true,
  "message": null
}
```

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
  server.ts           # createServer() registra as tools (ping)
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
