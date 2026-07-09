/**
 * Plain-text guidance shared across setup steps.
 *
 * These are the "hard-won gotchas" from real setup calls — Notion workspace
 * admin settings that silently block the flow, GitHub token pitfalls, and the
 * Claude-side registration requirements. Keeping them here (as pure string
 * builders) makes them reusable across steps and unit-testable, and keeps the
 * step files focused on control flow.
 *
 * The wizard renders these with `pc.dim(...)`; the strings themselves stay
 * un-styled so they're also usable in logs, docs, and tests.
 */

const ADMIN_CONNECTIONS_LOCATION = "Admin Center → Connections → Manage";

/**
 * "Limit who can create personal access tokens" silently blocks `ntn login`
 * during setup (no browser opens, no clear error). Names the exact setting,
 * where it lives, and that PAT creation can be re-restricted afterward.
 */
export function notionPatSettingHelp(): string {
  return (
    `If no browser opened and no clear error appeared, a Notion workspace admin\n` +
    `setting is likely blocking personal access tokens:\n` +
    `  • Setting:  "Limit who can create personal access tokens"\n` +
    `  • Location: ${ADMIN_CONNECTIONS_LOCATION}\n` +
    `  • Fix:      a workspace admin sets it to "all workspace members" (temporarily)\n` +
    `This PAT is only needed for the ntn CLI during setup — the ongoing sync uses\n` +
    `the Notion connection token, so PAT creation can be re-restricted right after.`
  );
}

/**
 * "Limit who can create internal connections" silently blocks creating the
 * internal connection + access token later in the flow.
 */
export function notionConnectionSettingHelp(): string {
  return (
    `If you can't create the connection or its access token, a Notion workspace\n` +
    `admin setting is likely blocking internal connections:\n` +
    `  • Setting:  "Limit who can create internal connections"\n` +
    `  • Location: ${ADMIN_CONNECTIONS_LOCATION}\n` +
    `  • Fix:      a workspace admin sets it to "all workspace members"`
  );
}

/**
 * Orgs frequently require an admin to approve a newly created fine-grained PAT
 * before it works. Nobody remembers where that lives.
 */
export function githubPatApprovalHelp(skillsRepo: string): string {
  return (
    `If your ${skillsRepo.split("/")[0]} organization requires approval for fine-grained\n` +
    `tokens, the token won't work until a GitHub org admin approves it:\n` +
    `  • Location: Organization Settings → Personal access tokens → Pending requests\n` +
    `This token is scoped to only the ${skillsRepo} repository (Contents: read/write),\n` +
    `which is exactly what an admin is approving — minimal blast radius.`
  );
}

/**
 * When the org's Claude GitHub app is installed for "selected repositories",
 * the newly created private skills repo won't appear until it's added to the
 * app installation (and it must be visible to the person doing the setup).
 */
export function claudeGithubAppHelp(skillsRepo: string): string {
  return (
    `If ${skillsRepo} doesn't appear as a choice ("Repo missing? Install the Claude\n` +
    `GitHub app in a private repository to access it here"), the org's Claude GitHub\n` +
    `app is likely set to "Only select repositories". Add ${skillsRepo} to that app\n` +
    `installation (GitHub → the org's Claude app → Configure → Repository access).\n` +
    `The repo must also be visible to whoever is doing the Claude-side setup — if\n` +
    `org repo visibility is restricted, add them as a collaborator on ${skillsRepo}.`
  );
}
