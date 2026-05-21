import { createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_AUTHZ = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(GOOGLE_JWKS_URL);
  return jwks;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} nao definido`);
  return v;
}

export function getGoogleRedirectUri(): string {
  const issuer = requireEnv("OAUTH_ISSUER").replace(/\/$/, "");
  return `${issuer}/oauth/google/callback`;
}

export function buildGoogleAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: getGoogleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  const hd = process.env.ALLOWED_GOOGLE_HD;
  if (hd) params.set("hd", hd);
  return `${GOOGLE_AUTHZ}?${params.toString()}`;
}

export interface GoogleIdentity {
  email: string;
  hd?: string;
  email_verified: boolean;
}

export async function exchangeGoogleCode(code: string): Promise<GoogleIdentity> {
  const body = new URLSearchParams({
    code,
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
    redirect_uri: getGoogleRedirectUri(),
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google /token retornou ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) throw new Error("Google nao retornou id_token");

  const { payload } = await jwtVerify(data.id_token, getJwks(), {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: requireEnv("GOOGLE_CLIENT_ID"),
  });

  if (typeof payload.email !== "string") {
    throw new Error("id_token sem claim email");
  }
  return {
    email: payload.email,
    hd: typeof payload.hd === "string" ? payload.hd : undefined,
    email_verified: payload.email_verified === true,
  };
}
