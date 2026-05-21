import { SignJWT, jwtVerify, type JWTPayload } from "jose";

const ALG = "HS256";
export const ACCESS_TTL_SECONDS = 3600;

function getSecret(): Uint8Array {
  const secret = process.env.OAUTH_JWT_SECRET;
  if (!secret) {
    throw new Error("OAUTH_JWT_SECRET nao definido");
  }
  return new TextEncoder().encode(secret);
}

function getIssuer(): string {
  const issuer = process.env.OAUTH_ISSUER;
  if (!issuer) {
    throw new Error("OAUTH_ISSUER nao definido");
  }
  return issuer;
}

export interface AccessTokenClaims extends JWTPayload {
  sub: string;       // email do usuario
  azp: string;       // client_id do cliente MCP
  email: string;     // duplicado para conveniencia
}

export async function signAccessToken(claims: {
  email: string;
  clientId: string;
}): Promise<string> {
  const issuer = getIssuer();
  return new SignJWT({ email: claims.email, azp: claims.clientId })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.email)
    .setIssuer(issuer)
    .setAudience(issuer)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const issuer = getIssuer();
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer,
    audience: issuer,
    algorithms: [ALG],
  });
  if (typeof payload.sub !== "string" || typeof payload.azp !== "string") {
    throw new Error("JWT sem claims obrigatorios (sub, azp)");
  }
  return payload as AccessTokenClaims;
}
