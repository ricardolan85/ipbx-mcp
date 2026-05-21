// Cliente HTTP da API de portabilidade da provedora.
//
// Substitui o acesso direto ao MySQL (stored procedure consultaTN) -
// a provedora cortou o acesso ao banco e expoe a consulta via API
// interna autenticada por x-api-key.

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} nao definido`);
  return v;
}

export interface PortabilidadeInfo {
  idoperadora: number;
  operadora: string;
  cio: number;
  portado: boolean;
}

interface ApiResponse {
  numero: string;
  encontrado: boolean;
  idoperadora?: number;
  operadora?: string;
  cio?: number;
  portado?: boolean;
}

export async function consultarPortabilidade(
  numero: string,
): Promise<PortabilidadeInfo | null> {
  const base = requireEnv("PORTABILIDADE_API_URL").replace(/\/$/, "");
  const apiKey = requireEnv("PORTABILIDADE_API_KEY");

  const res = await fetch(
    `${base}/portabilidade/${encodeURIComponent(numero)}`,
    { headers: { "x-api-key": apiKey } },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `API portabilidade retornou ${res.status}: ${body.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as ApiResponse;
  if (!data.encontrado) return null;

  if (
    typeof data.idoperadora !== "number" ||
    typeof data.operadora !== "string" ||
    typeof data.cio !== "number" ||
    typeof data.portado !== "boolean"
  ) {
    throw new Error("API retornou encontrado=true com payload incompleto");
  }
  return {
    idoperadora: data.idoperadora,
    operadora: data.operadora,
    cio: data.cio,
    portado: data.portado,
  };
}
