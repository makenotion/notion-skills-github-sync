import * as p from "@clack/prompts";
import pc from "picocolors";
import { SKILLS_DB_DEFAULT_NAME } from "../skills-db.ts";
import type { WizardLogger } from "../logger.ts";
import type { PreflightResult } from "./preflight.ts";

export interface Decisions {
  /** Name for the Notion Skills DB. Picked automatically; renameable in Notion. */
  dbName: string;
  /** The repo the sync publishes plugins into (the plugin marketplace). */
  skillsRepo: {
    repo: string; // "owner/name"
    isNew: boolean;
    // Always private — a public skills repo doesn't make sense for internal
    // org content, and private is required for Claude org-level registration.
  };
  /** The repo this sync code + config live in — where the hourly Action runs. */
  syncScriptRepo: {
    repo: string; // "owner/name"
    isNew: boolean; // false = push to the existing origin remote
  };
}

/**
 * Phase 2: collect every decision up front, then confirm the whole plan once.
 * After this, the only remaining interaction is the access-tokens checkpoint.
 */
export async function stepDecisions(
  logger: WizardLogger,
  preflight: PreflightResult,
  dbNameOverride?: string,
): Promise<Decisions | null> {
  p.log.step(pc.bold("Step 2 of 6: A few decisions"));

  p.log.info(`Let's start by confirming some decisions about your setup.`);

  const dbName = dbNameOverride || SKILLS_DB_DEFAULT_NAME;

  // For org rollouts the repos should live under the org (so admins can manage
  // them and teammates can access them), not a personal account — so prefer an
  // org as the default owner wherever we suggest one.
  const defaultOwner = preflight.ghOrgs[0] ?? preflight.ghUser;

  // --- Skills repo ---
  p.log.message(
    pc.bold("Skills repo") +
      `\nSkills are published here as Claude plugins — your team never touches it,\n` +
      `and it must be ${pc.bold("private")} to register with your Claude org.`,
  );

  // Loop so mis-selecting "existing" (which the sync would overwrite) can be
  // undone by declining the confirmation, without killing the whole setup.
  let skillsRepo: Decisions["skillsRepo"] | null = null;
  while (!skillsRepo) {
    const skillsRepoChoice = await p.select({
      message: "Skills repo — create new or use existing?",
      initialValue: "new",
      options: [
        { value: "new", label: "Create a new repository (recommended)" },
        {
          value: "existing",
          label: "Use an existing repository",
          hint: "⚠ the sync OVERWRITES its contents on every run",
        },
      ],
    });
    if (p.isCancel(skillsRepoChoice)) return cancelled();

    if (skillsRepoChoice === "existing") {
      const repoInput = await p.text({
        message: "Skills repo (owner/name format):",
        placeholder: `${defaultOwner}/notion-skills`,
        validate: (v) => {
          if (!v || !v.includes("/")) return "Must be in owner/name format";
          if (v.trim().length < 3) return "Repository name too short";
          return undefined;
        },
      });
      if (p.isCancel(repoInput)) return cancelled();
      const repo = String(repoInput).trim();

      // The sync is destructive toward the target repo — force the user to
      // acknowledge that before reusing an existing one.
      p.log.warn(
        pc.bold("This sync overwrites the target repo.") +
          `\nEvery run rewrites ${pc.cyan(repo)} to match Notion: managed plugin files\n` +
          `are overwritten and unpublished/removed skills are pruned. Any colliding\n` +
          `content already in the repo will be lost. Only reuse a repo that's\n` +
          `dedicated to this sync — otherwise create a new one.`,
      );
      const confirmExisting = await p.confirm({
        message: `Use ${repo} anyway, knowing the sync will overwrite its contents?`,
        initialValue: false,
      });
      if (p.isCancel(confirmExisting)) return cancelled();
      if (!confirmExisting) {
        p.log.info("No problem — let's choose again. Creating a new repo is safest.");
        continue;
      }
      skillsRepo = { repo, isNew: false };
    } else {
      // Owner picker: orgs first (an org is the recommended default for team
      // rollouts), personal account last and never the default.
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

      let owner: string;
      if (ownerOptions.length > 1) {
        const ownerChoice = await p.select({
          message: "Skills repo owner:",
          // Defaults to the first org when the user has one, so org rollouts
          // don't accidentally land under a personal account.
          initialValue: ownerOptions[0]!.value,
          options: ownerOptions,
        });
        if (p.isCancel(ownerChoice)) return cancelled();
        owner = String(ownerChoice);
      } else if (ownerOptions.length === 1) {
        owner = ownerOptions[0]!.value;
      } else {
        const ownerInput = await p.text({
          message: "Skills repo owner (user or organization):",
        });
        if (p.isCancel(ownerInput)) return cancelled();
        owner = String(ownerInput).trim();
      }

      const repoName = await p.text({
        message: "Skills repo name:",
        initialValue: "notion-skills",
        validate: (v) => {
          if (!v || v.trim().length === 0) return "Name cannot be empty";
          if (!/^[a-zA-Z0-9._-]+$/.test(v.trim()))
            return "Invalid repo name (use letters, numbers, hyphens, dots, underscores)";
          return undefined;
        },
      });
      if (p.isCancel(repoName)) return cancelled();

      skillsRepo = {
        repo: `${owner}/${String(repoName).trim()}`,
        isNew: true,
      };
    }
  }

  // --- Sync script repo ---
  p.log.message(
    pc.bold("Sync script repo") +
      `\nThis code plus your ${pc.cyan("config.json")}, where the hourly workflow runs — you own\n` +
      `it, so the default is a new repo under your account` +
      (preflight.detectedOrigin
        ? pc.dim(` (the current origin\nis kept as \`upstream\`).`)
        : `.`),
  );

  const syncRepoOptions: Array<{ value: string; label: string; hint?: string }> = [
    {
      value: "new",
      label: "Create a new private repo for the sync script (recommended)",
    },
  ];
  if (preflight.detectedOrigin) {
    syncRepoOptions.push({
      value: "origin",
      label: `Push to the current origin: ${preflight.detectedOrigin}`,
      hint: "only if it's your own copy, not the upstream tool repo",
    });
  }

  const syncRepoChoice = await p.select({
    message: "Where should the sync script live?",
    options: syncRepoOptions,
  });
  if (p.isCancel(syncRepoChoice)) return cancelled();

  let syncScriptRepo: Decisions["syncScriptRepo"];
  if (syncRepoChoice === "origin" && preflight.detectedOrigin) {
    syncScriptRepo = { repo: preflight.detectedOrigin, isNew: false };
  } else {
    const syncRepoInput = await p.text({
      message: "Sync script repo (owner/name):",
      // Default under an org (not the personal account) when one exists, so
      // teammates and admins can reach the repo the workflow runs in.
      initialValue: defaultOwner
        ? `${defaultOwner}/notion-skills-github-sync`
        : "",
      validate: (v) =>
        !v || !v.includes("/") ? "Must be in owner/name format" : undefined,
    });
    if (p.isCancel(syncRepoInput)) return cancelled();
    syncScriptRepo = { repo: String(syncRepoInput).trim(), isNew: true };
  }

  // --- Plan summary: the single go/no-go ---
  const decisions: Decisions = { dbName, skillsRepo, syncScriptRepo };
  logger.event("decisions", decisions as unknown as Record<string, unknown>);

  p.note(
    `1. Create the Notion Skills DB ${pc.cyan(`"${dbName}"`)} with sample skills\n` +
      `2. ${skillsRepo.isNew ? "Create" : "Use"} the skills repo ${pc.cyan(skillsRepo.repo)}` +
      (skillsRepo.isNew ? ` (private)` : ` (existing — will be overwritten)`) +
      `\n` +
      `3. ${syncScriptRepo.isNew ? "Create" : "Use"} the sync script repo ${pc.cyan(syncScriptRepo.repo)}\n` +
      `4. Pause once while you create two access tokens:\n` +
      `   a GitHub fine-grained PAT (pre-filled form) + a Notion integration token\n` +
      `5. Push the sync script (with config.json) and set the tokens as secrets\n` +
      `6. Run a local test sync, then a real GitHub Actions run, end to end`,
    "The plan",
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

function cancelled(): null {
  p.cancel("Setup cancelled. Run this command again when you're ready.");
  return null;
}
