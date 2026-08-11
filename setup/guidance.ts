/**
 * Plain-text guidance shared across setup steps.
 *
 * These are the "hard-won gotchas" from real setup calls — Notion workspace
 * admin settings that silently block the flow, GitHub token pitfalls, and the
 * Claude-side registration requirements. Keeping them here (as pure string
 * builders) makes them reusable across steps and unit-testable, and keeps the
 * step files focused on control flow.
 *
 * The setup renders these with `pc.dim(...)`; the strings themselves stay
 * un-styled so they're also usable in logs, docs, and tests.
 */

const ADMIN_CONNECTIONS_LOCATION = "Admin Center → Connections → Manage";

/**
 * Claude's official "manage plugins for your organization" guide. This is the
 * one piece of the setup we don't own and can't keep in lockstep — Claude's
 * plugin admin UI changes often and is sometimes A/B tested — so every
 * Claude-side instruction points back here as the source of truth.
 */
export const CLAUDE_PLUGINS_GUIDE =
  "https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization";

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

/**
 * The Claude-side "register the marketplace" steps.
 *
 * Deliberately written as an intent-level outline, not a click-by-click script:
 * Claude's plugin admin UI changes often and is sometimes A/B tested (two admins
 * on the same day can see different screens), so a screenshot-accurate walkthrough
 * would be stale within weeks. The likely labels are quoted as landmarks, but the
 * linked official guide is the source of truth whenever one has moved.
 *
 * It also folds in the two snags seen on real setup calls / documented by Claude:
 *   • the first GitHub connect can bounce you through a sign-in and drop you back
 *     on the plugins list without adding anything — retrying "Add plugin" works;
 *   • enabling automatic sync has its own access requirements (repo admin + the
 *     Claude GitHub App's Webhooks permission), and, per Claude's docs, auto-sync
 *     fires on a version-bumped PR merge to the default branch — so "Update" /
 *     the next scheduled sync is how you pull changes in on demand.
 */
export function claudeMarketplaceRegistrationHelp(skillsRepo: string): string {
  return (
    `Register ${skillsRepo} as a plugin marketplace in Claude. Claude's plugin UI\n` +
    `changes often (and is sometimes A/B tested, so your screens may differ) — treat\n` +
    `the labels below as landmarks and the linked guide as the source of truth:\n` +
    `  1. As an org Owner, open Organization settings → "Plugins".\n` +
    `  2. Add a marketplace from a GitHub source (look for "Add plugin" → "GitHub")\n` +
    `     and enter the repository in owner/repo format: ${skillsRepo}.\n` +
    `  3. Authorize with your GitHub account when prompted. Known snag: the first\n` +
    `     connect can send you through a GitHub sign-in and then return you to the\n` +
    `     plugins list without adding anything — if that happens, just start\n` +
    `     "Add plugin" again; the second pass goes through now that GitHub is linked.\n` +
    `  4. Optionally turn on automatic updates for the marketplace (its "···" /\n` +
    `     overflow menu → "Sync automatically"). That needs admin access to\n` +
    `     ${skillsRepo} plus the Claude GitHub App's Webhooks permission approved,\n` +
    `     and it re-syncs on a version-bumped PR merge to the default branch — you\n` +
    `     can always click "Update" to pull the latest skills on demand.\n` +
    `  5. Set how each plugin is distributed to your org (installed by default,\n` +
    `     available to install, required, or hidden).\n` +
    `Requires a Team or Enterprise plan, an Owner role, and Cowork + Skills enabled\n` +
    `for the org. Full guide: ${CLAUDE_PLUGINS_GUIDE}`
  );
}
