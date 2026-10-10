import * as p from "@clack/prompts";
import pc from "picocolors";
import { normalizeNotionPageId, SKILLS_DB_DEFAULT_NAME } from "../skills-db.ts";
import type { SetupLogger } from "../logger.ts";
import type { PreflightResult } from "./preflight.ts";

export interface Decisions {
  /** Name for the Notion Skills DB. Picked automatically; renameable in Notion. */
  dbName: string;
  /** An editable page that will contain the Skills DB. */
  parentPageId: string;
  /** The repo the sync publishes plugins into (the plugin marketplace). */
  skillsRepo: {
    repo: string; // "owner/name"
  };
  /** The repo this sync code lives in — where the hourly Action runs. */
  syncScriptRepo: {
    repo: string; // "owner/name"
  };
}

/**
 * Phase 2: collect every decision up front, then confirm the whole plan once.
 * After this, the only remaining interaction is the access-tokens checkpoint.
 */
export async function stepDecisions(
  logger: SetupLogger,
  preflight: PreflightResult,
  dbNameOverride?: string,
  testRun?: boolean,
  parentPageOverride?: string,
): Promise<Decisions | null> {
  p.log.step(pc.bold("Step 2 of 6: A few decisions"));

  p.log.info(`Let's start by confirming some decisions about your setup.`);

  const dbName = dbNameOverride || SKILLS_DB_DEFAULT_NAME;

  p.log.info(
    "Choose an editable Notion page to contain the Skills DB. This keeps the " +
      "database visible to you in Notion so you can add the sync connection later.",
  );
  const parentPageId = await pickParentPageId(parentPageOverride);
  if (parentPageId === null) return cancelled();

  // For org rollouts the repos should live under the org (so admins can manage
  // them and teammates can access them), not a personal account — so prefer an
  // org as the default owner wherever we suggest one.
  const defaultOwner = preflight.ghOrgs[0] ?? preflight.ghUser;

  // --- Skills repo ---
  const skillsOwner = await pickRepoOwner(preflight, "Skills repo owner");
  if (skillsOwner === null) return cancelled();

  const repoName = await p.text({
    message: "Skills repo name:",
    initialValue: "notion-skills",
    validate: validateRepoName,
  });
  if (p.isCancel(repoName)) return cancelled();

  const skillsRepo: Decisions["skillsRepo"] = {
    repo: `${skillsOwner}/${String(repoName).trim()}`,
  };

  // --- Sync script repo ---
  p.log.message(
    `We will also create a repo to host your own fork of this code.\n` +
      `This repo will be where the hourly GitHub Actions workflow runs.`,
  );

  // Same owner→name flow as the skills repo, defaulting to the owner just
  // picked for it — both repos of one rollout should land together.
  const syncOwner = await pickRepoOwner(
    preflight,
    "Sync script repo owner",
    skillsRepo.repo.split("/")[0],
  );
  if (syncOwner === null) return cancelled();

  const syncRepoName = await p.text({
    message: "Sync script repo name:",
    initialValue: "notion-skills-github-sync",
    validate: validateRepoName,
  });
  if (p.isCancel(syncRepoName)) return cancelled();

  const syncScriptRepo: Decisions["syncScriptRepo"] = {
    repo: `${syncOwner}/${String(syncRepoName).trim()}`,
  };

  // --- Plan summary: the single go/no-go ---
  const decisions: Decisions = { dbName, parentPageId, skillsRepo, syncScriptRepo };
  logger.event("decisions", decisions as unknown as Record<string, unknown>);

  p.note(
    `1. Create the Notion Skills DB ${pc.cyan(`"${dbName}"`)} inside your selected Notion page, with sample skills\n` +
      `2. Create the skills repo ${pc.cyan(skillsRepo.repo)}\n` +
      `3. Create the sync script repo ${pc.cyan(syncScriptRepo.repo)}.\n` +
      `4. Create two access tokens for GitHub and Notion.\n` +
      `5. Push the sync script and initiate the GitHub Actions workflow.\n` +
      `6. Run a test sync.` +
      (testRun
        ? `\n7. ${pc.yellow("Test run:")} at the end, help you delete the GitHub repos created above`
        : ``),
    "Here's what we'll do",
  );

  const proceed = await p.confirm({
    message: "Proceed?",
    initialValue: true,
  });
  logger.event("plan-confirm", {
    cancelled: p.isCancel(proceed),
    value: p.isCancel(proceed) ? null : proceed,
  });
  if (p.isCancel(proceed) || !proceed) return cancelled();

  return decisions;
}

async function pickParentPageId(override?: string): Promise<string | null> {
  if (override !== undefined) return normalizeNotionPageId(override);

  const page = await p.text({
    message: "Notion parent page URL or ID:",
    placeholder: "https://www.notion.so/Your-team-home-...",
    validate: (value) =>
      normalizeNotionPageId(value ?? "")
        ? undefined
        : "Paste the URL or ID of a Notion page you can edit.",
  });
  if (p.isCancel(page)) return null;
  return normalizeNotionPageId(String(page));
}

/**
 * Owner picker shared by the skills-repo and sync-script-repo prompts: orgs
 * first (an org is the recommended default for team rollouts), personal
 * account last and never the default. `preferredOwner` — e.g. the owner
 * already picked for the skills repo — takes the default slot when it's one
 * of the choices. Returns null if the user cancelled.
 */
async function pickRepoOwner(
  preflight: PreflightResult,
  message: string,
  preferredOwner?: string,
): Promise<string | null> {
  const ownerOptions: Array<{ value: string; label: string; hint?: string }> = [];
  for (const org of preflight.ghOrgs) {
    ownerOptions.push({
      value: org,
      label: org,
      hint: "organization (recommended for teams)",
    });
  }
  if (preflight.ghUser) {
    ownerOptions.push({
      value: preflight.ghUser,
      label: preflight.ghUser,
      hint: "personal account",
    });
  }

  if (ownerOptions.length > 1) {
    const ownerChoice = await p.select({
      message: `${message}:`,
      initialValue:
        preferredOwner && ownerOptions.some((o) => o.value === preferredOwner)
          ? preferredOwner
          : ownerOptions[0]!.value,
      options: ownerOptions,
    });
    if (p.isCancel(ownerChoice)) return null;
    return String(ownerChoice);
  }
  if (ownerOptions.length === 1) return ownerOptions[0]!.value;

  const ownerInput = await p.text({
    message: `${message} (user or organization):`,
    initialValue: preferredOwner ?? "",
  });
  if (p.isCancel(ownerInput)) return null;
  return String(ownerInput).trim();
}

function validateRepoName(v: string | undefined): string | undefined {
  if (!v || v.trim().length === 0) return "Name cannot be empty";
  if (!/^[a-zA-Z0-9._-]+$/.test(v.trim()))
    return "Invalid repo name (use letters, numbers, hyphens, dots, underscores)";
  return undefined;
}

function cancelled(): null {
  p.cancel("Setup cancelled. Run this command again when you're ready.");
  return null;
}
