/**
 * Plain-text guidance shared across setup steps.
 *
 * These are the "hard-won gotchas" from real setup calls — Notion workspace
 * admin settings that silently block the flow and GitHub token pitfalls.
 * Keeping them here (as pure string builders) makes them reusable across steps
 * and unit-testable, and keeps the step files focused on control flow.
 *
 * The setup renders these with `pc.dim(...)`; the strings themselves stay
 * un-styled so they're also usable in logs, docs, and tests.
 */

/**
 * "Limit who can create personal access tokens" silently blocks `ntn login`
 * during setup (no browser opens, no clear error). Names the recovery steps.
 */
export function notionPatSettingHelp(): string {
  return (
    `If no browser opened and no clear error appeared, a Notion workspace admin\n` +
    `setting is likely blocking personal access tokens. To fix:\n` +
    `  • Open settings\n` +
    `  • Go to Connections > Manage\n` +
    `  • Update "Limit who can create personal access tokens (PATs)" to "All workspace members"`
  );
}

/**
 * "Limit who can create internal connections" silently blocks creating the
 * internal connection + access token later in the flow.
 */
export function notionConnectionSettingHelp(): string {
  return (
    `If you can't create the connection or its access token, a Notion workspace admin\n` +
    `setting is likely blocking internal connections. You'll need to have an admin follow\n` +
    `the steps above to create a token for you.`
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
    `This token is scoped to only the ${skillsRepo} repository (Contents: read/write).`
  );
}
