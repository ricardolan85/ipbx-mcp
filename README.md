# mcp-portabilidade

Servidor [MCP](https://modelcontextprotocol.io) em TypeScript que expõe consultas de portabilidade de números telefônicos a partir de um banco MySQL com a stored procedure `consultaTN`. Usa transporte **Streamable HTTP** (modo stateless), apto a rodar como serviço de longa duração.

## Requisitos

- Node.js >= 20.6 (necessário para a flag nativa `--env-file`)
- Acesso a um MySQL com a procedure `consultaTN(numero VARCHAR)` que retorne `idoperadora`, `CIO`, `IsPortado`

## Instalação

```bash
npm install
cp .env.example .env   # depois preencha as credenciais reais
npm run build
```

## Configuração

Variáveis de ambiente (carregadas automaticamente pelo `npm start` via `--env-file=.env`):

| Variável             | Obrigatória | Padrão     | Descrição                                     |
| -------------------- | ----------- | ---------- | --------------------------------------------- |
| `MYSQL_HOST`         | sim         | —          |                                               |
| `MYSQL_PORT`         | não         | `3306`     |                                               |
| `MYSQL_USER`         | sim         | —          |                                               |
| `MYSQL_PASSWORD`     | não         | —          |                                               |
| `MYSQL_DATABASE`     | sim         | —          |                                               |
| `MCP_AUTH_TOKEN`     | **sim**     | —          | Bearer token estático para chamar `/mcp`      |
| `PORT`               | não         | `3000`     | Porta HTTP                                    |
| `HOST`               | não         | `0.0.0.0`  | Interface                                     |
| `MCP_ALLOWED_HOSTS`  | não         | —          | Lista CSV de hosts aceitos no header `Host`   |

O servidor **se recusa a iniciar** se `MCP_AUTH_TOKEN` não estiver definido. Gere um token aleatório com:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Segurança

A única proteção de aplicação é o bearer token. Toda requisição em `/mcp` (POST/GET/DELETE) precisa do header:

```
Authorization: Bearer <MCP_AUTH_TOKEN>
```

Sem ou com token inválido → `401 Unauthorized`. Comparação é feita em tempo constante (`crypto.timingSafeEqual`).

O que **não** está coberto pelo código e fica por sua conta:

- TLS — termine com reverse proxy (nginx/caddy) na frente
- Rate limiting — sem proteção contra varredura/enumeração
- Audit log — não há registro de quem consultou o quê
- Restrição de IP — use firewall ou `MCP_ALLOWED_HOSTS` para limitar origens

`/health` é público (não exige token) por ser usado em healthcheck de orquestrador.

## Uso

```bash
npm start          # sobe o servidor HTTP
npm run check      # tsc --noEmit (validação de tipos)
npm run dev        # tsc --watch
npm run inspect    # MCP Inspector
```

Endpoints:

- `POST /mcp` — fala JSON-RPC do MCP via Streamable HTTP
- `GET /health` — `{"status":"ok"}` para healthcheck
- `GET|DELETE /mcp` — `405`

## Tools disponíveis

### `consultar-portabilidade`

Chama `CALL consultaTN(?)` e retorna o resultado em JSON.

**Parâmetros:**

- `numero` (string, obrigatório): apenas dígitos, 10–13 chars, ex: `553534733100`

**Retorno:**

```json
{
  "numero": "553534733100",
  "idoperadora": 55282,
  "operadora": "ANDRADE",
  "CIO": 1,
  "IsPortado": true
}
```

## Configurando em um cliente MCP

Para clientes que suportam Streamable HTTP (ex: Claude Desktop ≥ versão com `type: "http"`):

```json
{
  "mcpServers": {
    "portabilidade": {
      "type": "http",
      "url": "http://SEU_HOST:3000/mcp",
      "headers": {
        "Authorization": "Bearer SEU_TOKEN_AQUI"
      }
    }
  }
}
```

## Rodando como serviço systemd

```ini
[Unit]
Description=MCP Portabilidade
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/local/mcp-portabilidade
ExecStart=/usr/bin/node dist/index.js
EnvironmentFile=/var/local/mcp-portabilidade/.env
User=mcp
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Notas:

- `EnvironmentFile=` é o equivalente nativo do systemd para `.env` — não precisa de `--env-file` na linha de comando
- Use um usuário dedicado (`User=mcp`) em vez de `root`
- Confirme o caminho do Node com `which node`

## Estrutura

```
src/
  index.ts      # bootstrap HTTP, endpoints, leitura de env de transporte
  server.ts     # createServer() registra as tools (reusável por requisição)
  db.ts         # pool mysql2 e wrapper consultaTN()
  operadoras.ts # carrega data/idoperadora.txt e resolve idoperadora -> nome
data/           # datasets auxiliares (ex: idoperadora.txt)
```
