/**
 * Two Notion workspace admin settings silently block guided setup, each needing
 * a workspace admin to flip it mid-setup:
 *
 *   1. "Limit who can create personal access tokens" — blocks `ntn login`
 *      (the CLI can't mint a PAT). The failure is silent: no browser, no clear
 *      error.
 *   2. "Limit who can create internal connections" — blocks creating the
 *      internal connection + access token the sync uses.
 *
 * Both live under Admin Center → Connections → Manage. This module centralizes
 * the exact wording (setting name, location, who can change it) so preflight and
 * the credentials checkpoint surface identical, actionable guidance instead of a
 * silent stall.
 */

/** Where both settings live in the Notion admin UI. */
export const ADMIN_CONNECTIONS_PATH = "Admin Center → Connections → Manage";

/** The setting that gates `ntn login` (personal access token creation). */
export const PAT_SETTING_NAME = "Limit who can create personal access tokens";

/** The setting that gates creating the internal connection + its access token. */
export const INTERNAL_CONNECTION_SETTING_NAME =
  "Limit who can create internal connections";

/**
 * The PAT is only needed by the `ntn` CLI during setup — the ongoing sync uses
 * the internal connection's token — so it's safe to re-restrict right after.
 */
export const PAT_RERESTRICT_NOTE =
  "The personal access token is only needed by the ntn CLI during setup " +
  "(the ongoing sync uses the internal connection's token instead), so an admin " +
  "can re-restrict this setting right after setup without breaking the sync.";

/** Actionable message for when `ntn login` fails because PAT creation is restricted. */
export function patRestrictionHelp(): string {
  return [
    `The Notion CLI couldn't create a personal access token, which \`ntn login\` needs.`,
    ``,
    `This is almost always the workspace setting:`,
    `  "${PAT_SETTING_NAME}"`,
    `A workspace admin needs to allow it (at least for you, at least during setup):`,
    `  ${ADMIN_CONNECTIONS_PATH}`,
    ``,
    `Note: ${PAT_RERESTRICT_NOTE}`,
  ].join("\n");
}

/** Actionable message for when the internal connection / access token can't be created. */
export function internalConnectionRestrictionHelp(): string {
  return [
    `If you can't create the connection or its access token (the option is`,
    `missing, greyed out, or creation is blocked), it's almost always the`,
    `workspace setting:`,
    `  "${INTERNAL_CONNECTION_SETTING_NAME}"`,
    `A workspace admin needs to allow it:`,
    `  ${ADMIN_CONNECTIONS_PATH}`,
  ].join("\n");
}
