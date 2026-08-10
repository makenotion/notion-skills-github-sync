// An interface rather than a bare string because an OAuth-derived credential
// has to refresh — hence resolving the token per request, not at construction.

/** Resolves the bearer token to send. Called once per request. */
export interface Credential {
  getToken(): string | Promise<string>;
}

/** A fixed token: an integration token, or an OAuth `access_token`. */
export function staticToken(token: string): Credential {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Notion credential: token is empty.");
  return { getToken: () => trimmed };
}

/** Accept either a raw token string or a full `Credential`. */
export function toCredential(auth: string | Credential): Credential {
  return typeof auth === "string" ? staticToken(auth) : auth;
}
