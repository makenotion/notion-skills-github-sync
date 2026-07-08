import * as p from "@clack/prompts";
import pc from "picocolors";
import { SKILLS_DB_DEFAULT_NAME } from "../skills-db.ts";
import type { WizardLogger } from "../logger.ts";
import type { PreflightResult } from "./preflight.ts";

/**
 * The destructive-action confirmation for pointing the sync at an existing repo
 * requires typing the exact `owner/name`. Extracted (and exported) so the guard
 * logic is unit-testable without driving the interactive prompt.
 */
export function overwriteConfirmationMatches(
  input: string | undefined,
  repo: string,
): boolean {
  return (input ?? "").trim() === repo.trim();
}

export interface Decisions {
  /** Name for the Notion Skills DB. Picked automatically; renameable in Notion. */
  dbName: string;
  /** The repo the sync publishes plugins into (the plugin marketplace). */
  skillsRepo: {
    repo: string; // "owner/name"
    isNew: boolean;
    visibility: "private" | "public";
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

  // --- Skills repo ---
  // Chosen in a loop so that a mis-selection (e.g. picking "existing" by
  // accident) or a declined overwrite-confirmation returns here to re-choose,
  // instead of aborting the whole setup and forcing a restart.
  let skillsRepo: Decisions["skillsRepo"] | undefined;
  while (!skillsRepo) {
    p.log.message(
      pc.bold("Skills repo") +
        `\nSkills are published here as Claude plugins — your team never touches it,\n` +
        `and it must be ${pc.bold("private or internal")} to register with your Claude org.`,
    );

    const skillsRepoChoice = await p.select({
      message: "Skills repo — create new or use existing?",
      initialValue: "new",
      options: [
        {
          value: "new",
          label: "Create a new repository (recommended)",
          hint: "safest — a fresh repo dedicated to the sync",
        },
        {
          value: "existing",
          label: "Use an existing repository",
          hint: pc.yellow("⚠ destructive — the sync overwrites the repo's contents"),
        },
      ],
    });
    if (p.isCancel(skillsRepoChoice)) return cancelled();

    if (skillsRepoChoice === "existing") {
      const repoInput = await p.text({
        message: "Skills repo (owner/name format):",
        placeholder: `${preflight.ghUser}/notion-skills`,
        validate: (v) => {
          if (!v || !v.includes("/")) return "Must be in owner/name format";
          if (v.trim().length < 3) return "Repository name too short";
          return undefined;
        },
      });
      // Backing out here (Esc) returns to the choice rather than aborting.
      if (p.isCancel(repoInput)) {
        p.log.info("No problem — let's pick again.");
        continue;
      }
      const repo = String(repoInput).trim();

      // Destructive-action guard. The sync publishes the generated plugin
      // marketplace into this repo on a schedule and will overwrite/remove the
      // content it manages — there is no separate warning later. Require the
      // user to type the exact repo name so this can never be confirmed by an
      // accidental Enter.
      p.log.warn(
        pc.bold(
          pc.yellow("Heads up: this will overwrite the contents of an existing repo."),
        ) +
          `\nThe sync commits the generated plugin marketplace into ${pc.cyan(repo)} on a\n` +
          `schedule and will ${pc.bold("overwrite or delete")} files that collide with what it\n` +
          `manages (including ${pc.cyan(".claude-plugin/marketplace.json")}). Only continue if\n` +
          `you're OK handing ${pc.cyan(repo)} over to the sync. If in doubt, create a new repo.`,
      );

      const typed = await p.text({
        message: `To confirm, type the repo name (${pc.cyan(repo)}) — or press Esc to go back:`,
        validate: (v) =>
          overwriteConfirmationMatches(v, repo)
            ? undefined
            : `Type "${repo}" exactly to confirm, or press Esc to choose again`,
      });
      // Esc / mismatch-then-cancel loops back to the choice — no restart needed.
      if (p.isCancel(typed)) {
        p.log.info("Cancelled — let's pick again.");
        continue;
      }

      logger.event("existing-skills-repo-confirmed", { repo });
      skillsRepo = { repo, isNew: false, visibility: "private" };
      continue;
    }

    // --- Create a new repo (recommended path) ---
    // Owner picker: personal account + orgs.
    const ownerOptions: Array<{ value: string; label: string; hint?: string }> = [];
    if (preflight.ghUser) {
      ownerOptions.push({
        value: preflight.ghUser,
        label: preflight.ghUser,
        hint: "personal account",
      });
    }
    for (const org of preflight.ghOrgs) {
      ownerOptions.push({ value: org, label: org, hint: "organization" });
    }

    let owner: string;
    if (ownerOptions.length > 1) {
      const ownerChoice = await p.select({
        message: "Skills repo owner:",
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

    const visibility = await p.select({
      message: "Skills repo visibility:",
      options: [
        {
          value: "private",
          label: "Private (recommended)",
          hint: "required for Claude org-level registration",
        },
        { value: "public", label: "Public" },
      ],
    });
    if (p.isCancel(visibility)) return cancelled();

    skillsRepo = {
      repo: `${owner}/${String(repoName).trim()}`,
      isNew: true,
      visibility: visibility as "private" | "public",
    };
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
      initialValue: preflight.ghUser
        ? `${preflight.ghUser}/notion-skills-github-sync`
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
      (skillsRepo.isNew
        ? ` (${skillsRepo.visibility})`
        : pc.yellow(" (existing — the sync will overwrite its contents)")) +
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
