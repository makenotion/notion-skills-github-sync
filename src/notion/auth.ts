// How a request gets its bearer token.
//
// The only credential implemented today is a static access token — an internal
// integration token, or the `access_token` a completed OAuth exchange handed
// back. It's an interface rather than a bare string for one reason: an
// OAuth-derived credential has to be able to *refresh*, which means resolving
// the token per request rather than once at construction.
//
// That's the whole seam. `Credential.getToken()` is called on every request, so
// an implementation is free to consult a token store, notice a rotation, or
// repair a revoked token, and the HTTP layer never has to know.

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
