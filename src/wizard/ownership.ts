/**
 * Repo-ownership defaults for the setup wizard.
 *
 * When someone belongs to a GitHub org, both the skills repo and the sync
 * script repo should default to living under that org — that's what lets admins
 * manage them and teammates (including the Claude org admin) actually see them.
 * Defaulting to the driver's *personal* account is a footgun we hit on a live
 * setup call, so personal ownership must be an explicit choice, never the
 * silent default.
 *
 * These helpers are pure so the ordering/recommendation logic is unit-testable
 * without driving the interactive prompts.
 */

export interface OwnerOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * The owner to pre-select/pre-fill. Prefers an org over the personal account;
 * when the user belongs to multiple orgs the first one is recommended (they can
 * still pick another). Falls back to the personal account only when there are
 * no orgs.
 */
export function recommendedOwner(ghUser: string, ghOrgs: string[]): string {
  const org = ghOrgs.find(Boolean);
  return org ?? ghUser;
}

/** True when an org default is available (i.e. the user belongs to any org). */
export function hasOrgDefault(ghOrgs: string[]): boolean {
  return ghOrgs.some(Boolean);
}

/**
 * Owner choices for the repo-owner picker, ordered so the recommended owner
 * comes first (orgs before the personal account). The recommended org is
 * tagged; the personal account is explicitly labeled as such so choosing it is
 * a deliberate act.
 */
export function buildOwnerOptions(ghUser: string, ghOrgs: string[]): OwnerOption[] {
  const orgs = ghOrgs.filter(Boolean);
  const options: OwnerOption[] = [];

  orgs.forEach((org, i) => {
    options.push({
      value: org,
      label: org,
      hint: i === 0 ? "organization (recommended)" : "organization",
    });
  });

  if (ghUser) {
    options.push({
      value: ghUser,
      label: ghUser,
      hint: "personal account",
    });
  }

  return options;
}

/**
 * The owner to default the *sync script* repo to. Both repos should live
 * together, so mirror whatever owner was chosen for the skills repo when it's
 * an org; otherwise fall back to the recommended owner (org, else personal).
 */
export function syncRepoDefaultOwner(
  ghUser: string,
  ghOrgs: string[],
  skillsRepoOwner?: string,
): string {
  if (skillsRepoOwner && ghOrgs.includes(skillsRepoOwner)) return skillsRepoOwner;
  return recommendedOwner(ghUser, ghOrgs);
}

/** Parse the `owner` from an `owner/name` repo string. */
export function ownerOf(repo: string): string {
  return repo.split("/")[0] ?? "";
}
