# mcp-portabilidade

Servidor [MCP](https://modelcontextprotocol.io) em TypeScript que expõe consultas de portabilidade de números telefônicos a partir de um banco MySQL com a stored procedure `consultaTN`.

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

| Variável         | Obrigatória | Padrão    |
| ---------------- | ----------- | --------- |
| `MYSQL_HOST`     | sim         | —         |
| `MYSQL_PORT`     | não         | `3306`    |
| `MYSQL_USER`     | sim         | —         |
| `MYSQL_PASSWORD` | não         | —         |
| `MYSQL_DATABASE` | sim         | —         |

## Uso

```bash
npm start          # roda o servidor via stdio
npm run inspect    # abre o MCP Inspector apontado para este servidor
npm run dev        # tsc --watch
```

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
  "CIO": 1,
  "IsPortado": true
}
```

## Configurando em um cliente MCP

Exemplo de bloco para `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "portabilidade": {
      "command": "node",
      "args": [
        "--env-file=C:/Users/VIVAVOX INFRA/workspace/mcp-portabilidade/.env",
        "C:/Users/VIVAVOX INFRA/workspace/mcp-portabilidade/dist/index.js"
      ]
    }
  }
}
```

## Estrutura

```
src/
  index.ts   # registro de tools e bootstrap stdio
  db.ts      # pool mysql2 e wrapper consultaTN()
data/        # datasets auxiliares (ex: idoperadora.txt)
```
