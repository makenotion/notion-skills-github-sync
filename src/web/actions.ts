/**
 * Server-side setup actions for the visual web wizard.
 *
 * Each action maps to one wizard screen and reuses the existing building-block
 * helpers (`createSkillsDb`, `populateSampleSkills`, `buildPatUrl`,
 * `tokenCanReadDataSource`, `loggedExec`, `WizardLogger`, `guidance.ts`) so the
 * web flow can't drift far from the CLI. Unlike the CLI steps, actions never
 * call `process.exit`/`abortWithHandoff` — they return a structured result so
 * the server stays alive and the UI can surface failures (and the eject hatch).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WizardLogger } from "../wizard/logger.ts";
import { loggedExec, commandExists } from "../wizard/exec.ts";
import {
  createSkillsDb,
  populateSampleSkills,
  tokenCanReadDataSource,
} from "../wizard/skills-db.ts";
import { buildPatUrl } from "../wizard/steps/credentials.ts";
import {
  claudeGithubAppHelp,
  githubPatApprovalHelp,
  notionConnectionSettingHelp,
  notionPatSettingHelp,
} from "../wizard/guidance.ts";
import { NOTION_API_VERSION } from "../notion/ntn.ts";

export interface SetupState {
  notionEnv: string;
  ghUser?: string;
  ghOrgs?: string[];
  detectedOrigin?: string | null;
  dbName?: string;
  dataSourceId?: string;
  databaseId?: string;
  databaseUrl?: string;
  skillsRepo?: string;
  skillsRepoIsNew?: boolean;
  skillsRepoUrl?: string;
  syncRepo?: string;
  syncRepoIsNew?: boolean;
  syncRepoDefaultBranch?: string;
}

export interface ActionResult {
  ok: boolean;
  /** Short human-friendly message for the UI. */
  message?: string;
  /** One/two sentences on what went wrong (shown to the user + used for eject). */
  error?: string;
  /** Raw stderr / extra context, shown dimmed. */
  detail?: string;
  /** Arbitrary structured payload for the client. */
  data?: Record<string, unknown>;
}

function parseGithubRepo(remoteUrl: string): string | null {
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.\s]+)/);
  return match?.[1]?.replace(/\.git$/, "") ?? null;
}

/**
 * One in-memory setup session: the diagnostic logger, the accumulated state,
 * and the tokens (held in memory only, never written to disk — the logger
 * redacts them from every record).
 */
export class SetupSession {
  readonly logger = new WizardLogger();
  readonly state: SetupState;
  /** Held in memory for the deploy step; never logged. */
  private notionToken = "";
  private githubToken = "";
  /** Latest step key, for the eject prompt's context line. */
  currentStep = "welcome";

  constructor(notionEnv: string) {
    this.state = { notionEnv };
  }

  setStep(step: string): void {
    this.currentStep = step;
    this.logger.setStep(step);
  }

  hasNotionToken(): boolean {
    return this.notionToken.length > 0;
  }
  hasGithubToken(): boolean {
    return this.githubToken.length > 0;
  }

  // --- Phase 1: preflight -------------------------------------------------

  async preflight(): Promise<ActionResult> {
    this.setStep("preflight");
    const env = this.state.notionEnv;

    // Notion CLI: install if needed, then verify auth via the users/me probe.
    if (!(await commandExists("ntn"))) {
      const install = await loggedExec(this.logger, "preflight", "bash", [
        "-c",
        "curl -fsSL https://ntn.dev | bash",
      ]);
      if (install.code !== 0) {
        return {
          ok: false,
          error: "Could not install the Notion CLI (ntn).",
          detail: install.stderr,
        };
      }
    }
    const notionAuth = await loggedExec(this.logger, "preflight", "ntn", [
      "--env", env,
      "api", "-X", "GET", "/v1/users/me",
      "--notion-version", NOTION_API_VERSION,
    ]);
    let notionWho = "";
    if (notionAuth.code === 0) {
      try {
        const me = JSON.parse(notionAuth.stdout);
        notionWho = me?.bot?.owner?.user?.name || me?.name || "";
      } catch { /* non-JSON — report success without a name */ }
    }

    // GitHub CLI: must be installed + authenticated.
    const hasGh = await commandExists("gh");
    let ghUser = "";
    let ghOrgs: string[] = [];
    let ghAuthed = false;
    if (hasGh) {
      const authStatus = await loggedExec(this.logger, "preflight", "gh", [
        "auth", "status",
      ]);
      ghAuthed = authStatus.code === 0;
      if (ghAuthed) {
        const whoami = await loggedExec(this.logger, "preflight", "gh", [
          "api", "user", "--jq", ".login",
        ]);
        ghUser = whoami.code === 0 ? whoami.stdout.trim() : "";
        const orgs = await loggedExec(this.logger, "preflight", "gh", [
          "api", "user/orgs", "--jq", ".[].login",
        ]);
        ghOrgs =
          orgs.code === 0 ? orgs.stdout.trim().split("\n").filter(Boolean) : [];
      }
    }

    const remote = await loggedExec(this.logger, "preflight", "git", [
      "remote", "get-url", "origin",
    ]);
    const detectedOrigin =
      remote.code === 0 ? parseGithubRepo(remote.stdout) : null;

    this.state.ghUser = ghUser;
    this.state.ghOrgs = ghOrgs;
    this.state.detectedOrigin = detectedOrigin;
    this.logger.event("preflight-complete", { ghUser, ghOrgs, detectedOrigin });

    return {
      ok: notionAuth.code === 0 && hasGh && ghAuthed,
      data: {
        notion: { authed: notionAuth.code === 0, who: notionWho },
        github: { installed: hasGh, authed: ghAuthed, user: ghUser, orgs: ghOrgs },
        detectedOrigin,
        notionHelp: notionPatSettingHelp(),
      },
    };
  }

  // --- Phase 3: create the Notion Skills DB -------------------------------

  async createDatabase(dbName: string): Promise<ActionResult> {
    this.setStep("resources");
    const env = this.state.notionEnv;
    const result = await createSkillsDb(this.logger, "resources", env, { dbName });
    if (!result.ok) {
      return {
        ok: false,
        error: "Creating the Notion Skills DB failed.",
        detail: result.error,
      };
    }
    const { dataSourceId, databaseId, databaseUrl } = result.db;
    this.state.dbName = dbName;
    this.state.dataSourceId = dataSourceId;
    this.state.databaseId = databaseId;
    this.state.databaseUrl = databaseUrl;

    const { created, total, zipsAttached, zipsTotal } = await populateSampleSkills(
      this.logger,
      "resources",
      env,
      dataSourceId,
    );

    return {
      ok: true,
      message: `Created "${dbName}" with ${created}/${total} sample skills.`,
      data: { databaseUrl, dataSourceId, created, total, zipsAttached, zipsTotal },
    };
  }

  // --- Phase 3: create the GitHub repos -----------------------------------

  async createRepos(input: {
    skillsRepo: string;
    skillsRepoIsNew: boolean;
    syncRepo: string;
    syncRepoIsNew: boolean;
  }): Promise<ActionResult> {
    this.setStep("resources");
    const { skillsRepo, skillsRepoIsNew, syncRepo, syncRepoIsNew } = input;
    const skillsRepoUrl = `https://github.com/${skillsRepo}`;

    if (skillsRepoIsNew) {
      const create = await loggedExec(this.logger, "resources", "gh", [
        "repo", "create", skillsRepo,
        "--private",
        "--description", "Skills marketplace synced from Notion",
      ]);
      if (create.code !== 0 && !create.stderr.includes("already exists")) {
        return {
          ok: false,
          error: `Could not create the skills repo ${skillsRepo}.`,
          detail: create.stderr,
        };
      }
      const name = skillsRepo.split("/")[1] ?? skillsRepo;
      await loggedExec(this.logger, "resources", "gh", [
        "api", `repos/${skillsRepo}/contents/README.md`,
        "-X", "PUT",
        "-f", "message=Initial commit",
        "-f", `content=${Buffer.from(`# ${name}\n\nSkills marketplace synced from Notion.\n`).toString("base64")}`,
      ]);
    } else {
      const check = await loggedExec(this.logger, "resources", "gh", [
        "api", `repos/${skillsRepo}`, "--jq", ".full_name",
      ]);
      if (check.code !== 0) {
        return {
          ok: false,
          error: `The skills repo ${skillsRepo} doesn't exist or isn't accessible with your gh login.`,
          detail: check.stderr,
        };
      }
    }

    if (syncRepoIsNew) {
      const create = await loggedExec(this.logger, "resources", "gh", [
        "repo", "create", syncRepo,
        "--private",
        "--description", "Syncs skills from Notion into a Claude plugin marketplace",
      ]);
      if (create.code !== 0 && !create.stderr.includes("already exists")) {
        return {
          ok: false,
          error: `Could not create the sync script repo ${syncRepo}.`,
          detail: create.stderr,
        };
      }
      // Point origin at the new repo; keep any previous origin as `upstream`.
      const hadOrigin =
        (await loggedExec(this.logger, "resources", "git", ["remote", "get-url", "origin"]))
          .code === 0;
      if (hadOrigin) {
        const rename = await loggedExec(this.logger, "resources", "git", [
          "remote", "rename", "origin", "upstream",
        ]);
        if (rename.code !== 0) {
          await loggedExec(this.logger, "resources", "git", ["remote", "remove", "origin"]);
        }
      }
      const addRemote = await loggedExec(this.logger, "resources", "git", [
        "remote", "add", "origin", `https://github.com/${syncRepo}.git`,
      ]);
      if (addRemote.code !== 0) {
        return {
          ok: false,
          error: `Created ${syncRepo}, but could not point the origin remote at it.`,
          detail: addRemote.stderr,
        };
      }
    }

    const defaultBranch = await loggedExec(this.logger, "resources", "gh", [
      "api", `repos/${syncRepo}`, "--jq", ".default_branch",
    ]);
    const syncRepoDefaultBranch =
      defaultBranch.code === 0 && defaultBranch.stdout.trim()
        ? defaultBranch.stdout.trim()
        : "main";

    this.state.skillsRepo = skillsRepo;
    this.state.skillsRepoIsNew = skillsRepoIsNew;
    this.state.skillsRepoUrl = skillsRepoUrl;
    this.state.syncRepo = syncRepo;
    this.state.syncRepoIsNew = syncRepoIsNew;
    this.state.syncRepoDefaultBranch = syncRepoDefaultBranch;
    this.logger.event("resources-created", { skillsRepo, syncRepo, syncRepoDefaultBranch });

    return {
      ok: true,
      message: `Skills repo ${skillsRepo} and sync repo ${syncRepo} ready.`,
      data: { skillsRepoUrl, syncRepoUrl: `https://github.com/${syncRepo}`, syncRepoDefaultBranch },
    };
  }

  // --- Phase 4: access tokens ---------------------------------------------

  patInfo(): ActionResult {
    this.setStep("credentials");
    const skillsRepo = this.state.skillsRepo;
    if (!skillsRepo) return { ok: false, error: "Create the skills repo first." };
    return {
      ok: true,
      data: {
        patUrl: buildPatUrl(skillsRepo),
        approvalHelp: githubPatApprovalHelp(skillsRepo),
        skillsRepo,
      },
    };
  }

  notionConnectionInfo(): ActionResult {
    const env = this.state.notionEnv;
    const host = env === "prod" ? "www.notion.so" : `${env}.notion.so`;
    return {
      ok: true,
      data: {
        integrationsUrl: `https://${host}/my-integrations`,
        databaseUrl: this.state.databaseUrl,
        dbName: this.state.dbName,
        connectionHelp: notionConnectionSettingHelp(),
      },
    };
  }

  async validateGithubToken(token: string): Promise<ActionResult> {
    this.setStep("credentials");
    const skillsRepo = this.state.skillsRepo;
    if (!skillsRepo) return { ok: false, error: "Create the skills repo first." };
    const trimmed = token.trim();
    this.logger.registerSecret(trimmed);
    const result = await loggedExec(
      this.logger,
      "credentials",
      "gh",
      ["api", `repos/${skillsRepo}`, "--jq", ".permissions.push"],
      { env: { GH_TOKEN: trimmed } },
    );
    const canPush = result.code === 0 && result.stdout.trim() === "true";
    this.logger.event("pat-validated", { canPush });
    if (canPush) this.githubToken = trimmed;
    return {
      ok: canPush,
      message: canPush ? "Push access to the skills repo confirmed." : undefined,
      error: canPush
        ? undefined
        : "That token can't push to the skills repo. Check the repo selection, the Contents: read/write permission, or a pending org approval.",
      data: { canPush },
    };
  }

  async validateNotionToken(token: string): Promise<ActionResult> {
    this.setStep("credentials");
    const dataSourceId = this.state.dataSourceId;
    if (!dataSourceId) return { ok: false, error: "Create the Notion Skills DB first." };
    const trimmed = token.trim();
    const validPrefixes = ["ntn_", "secret_", "development_ntn_"];
    if (!validPrefixes.some((prefix) => trimmed.startsWith(prefix))) {
      return {
        ok: false,
        error: "Token should start with ntn_, secret_, or development_ntn_.",
      };
    }
    this.logger.registerSecret(trimmed);
    const canRead = await tokenCanReadDataSource(
      this.logger,
      "credentials",
      this.state.notionEnv,
      trimmed,
      dataSourceId,
    );
    this.logger.event("notion-token-validated", { canRead });
    if (canRead) this.notionToken = trimmed;
    return {
      ok: canRead,
      message: canRead ? "The token can read the Notion Skills DB." : undefined,
      error: canRead
        ? undefined
        : "That token can't read the database yet. Finish adding the \"Skills Sync\" connection to the DB in Notion, then retry.",
      data: { canRead },
    };
  }

  // --- Phase 5: deploy + verify -------------------------------------------

  async deploy(): Promise<ActionResult> {
    this.setStep("deploy");
    const s = this.state;
    if (!s.skillsRepo || !s.syncRepo || !s.dataSourceId || !s.databaseId) {
      return { ok: false, error: "Finish the earlier steps before deploying." };
    }
    if (!this.hasNotionToken() || !this.hasGithubToken()) {
      return { ok: false, error: "Both access tokens must be verified before deploying." };
    }
    this.logger.registerSecret(this.notionToken);
    this.logger.registerSecret(this.githubToken);

    // 1. Write config.json
    const config = {
      notionEnv: s.notionEnv,
      skillsDataSourceId: s.dataSourceId,
      skillsDatabaseId: s.databaseId,
      githubRepo: s.skillsRepo,
      githubBranch: "main",
      pluginsDir: "plugins",
      authorName: "notion-skills-sync",
      authorEmail: "notion-skills-sync@users.noreply.github.com",
    };
    const configPath = join(process.cwd(), "config.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    this.logger.log({
      timestamp: new Date().toISOString(),
      step: "deploy",
      command: `write ${configPath}`,
      exitCode: 0,
      stdout: JSON.stringify(config),
      duration_ms: 0,
    });

    // 2. Commit + push to the sync repo's configured default branch.
    const branch = s.syncRepoDefaultBranch || "main";
    const status = await loggedExec(this.logger, "deploy", "git", [
      "status", "--porcelain", "--", "config.json",
    ]);
    if (status.stdout.trim()) {
      await loggedExec(this.logger, "deploy", "git", ["add", "config.json"]);
      const commit = await loggedExec(this.logger, "deploy", "git", [
        "commit", "-m", "Configure Notion skills sync", "--", "config.json",
      ]);
      if (commit.code !== 0) {
        return { ok: false, error: "Could not commit config.json.", detail: commit.stderr };
      }
    }
    const push = await loggedExec(this.logger, "deploy", "git", [
      "push", "-u", "origin", `HEAD:${branch}`,
    ]);
    if (push.code !== 0) {
      return {
        ok: false,
        error: `Could not push to ${s.syncRepo} (branch ${branch}).`,
        detail: push.stderr,
      };
    }

    // 3. Set the two secrets on the sync repo (values via env, never argv).
    const notionSecret = await loggedExec(
      this.logger, "deploy", "bash",
      ["-c", `printf '%s' "$SECRET_VALUE" | gh secret set NOTION_API_TOKEN --repo "${s.syncRepo}"`],
      { env: { SECRET_VALUE: this.notionToken } },
    );
    const ghSecret = await loggedExec(
      this.logger, "deploy", "bash",
      ["-c", `printf '%s' "$SECRET_VALUE" | gh secret set GH_PUSH_TOKEN --repo "${s.syncRepo}"`],
      { env: { SECRET_VALUE: this.githubToken } },
    );
    if (notionSecret.code !== 0 || ghSecret.code !== 0) {
      return {
        ok: false,
        error: `Could not set the workflow secrets on ${s.syncRepo}.`,
        detail: (notionSecret.code !== 0 ? notionSecret : ghSecret).stderr,
      };
    }

    // 4. Local test sync with the same credentials the workflow will use.
    const syncEnv = { GITHUB_TOKEN: this.githubToken, NOTION_API_TOKEN: this.notionToken };
    const dryRun = await loggedExec(
      this.logger, "deploy", "bun",
      ["run", "src/cli.ts", "sync", "--dry-run"], { env: syncEnv },
    );
    if (dryRun.code !== 0) {
      return { ok: false, error: "The dry-run sync failed.", detail: dryRun.stderr || dryRun.stdout };
    }
    const sync = await loggedExec(
      this.logger, "deploy", "bun",
      ["run", "src/cli.ts", "sync"], { env: syncEnv },
    );
    if (sync.code !== 0) {
      return { ok: false, error: `The sync to ${s.skillsRepo} failed.`, detail: sync.stderr || sync.stdout };
    }

    // 5. Verify the production path: dispatch + watch a real Actions run.
    const actions = await this.verifyActionsRun(s.syncRepo, branch);
    if (!actions.ok) return actions;

    return {
      ok: true,
      message: "Deployed and verified end to end.",
      data: {
        skillsRepoUrl: s.skillsRepoUrl,
        syncRepoUrl: `https://github.com/${s.syncRepo}`,
        databaseUrl: s.databaseUrl,
      },
    };
  }

  private async verifyActionsRun(syncRepo: string, defaultBranch: string): Promise<ActionResult> {
    // Wait for GitHub to register the workflow on the default branch.
    let registered = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const wf = await loggedExec(this.logger, "actions-test", "gh", [
        "api", `repos/${syncRepo}/actions/workflows/sync.yml`, "--jq", ".state",
      ]);
      if (wf.code === 0 && wf.stdout.trim() === "active") {
        registered = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!registered) {
      return {
        ok: false,
        error: `GitHub never registered .github/workflows/sync.yml on ${syncRepo} (must be on ${defaultBranch}, Actions enabled).`,
      };
    }

    const listArgs = [
      "run", "list", "--workflow", "sync.yml", "--repo", syncRepo,
      "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId",
    ];
    const before = await loggedExec(this.logger, "actions-test", "gh", listArgs);
    const previousRunId = before.code === 0 ? before.stdout.trim() : "";

    const dispatch = await loggedExec(this.logger, "actions-test", "gh", [
      "workflow", "run", "sync.yml", "--repo", syncRepo, "--ref", defaultBranch,
    ]);
    if (dispatch.code !== 0) {
      return { ok: false, error: `Dispatching sync.yml on ${syncRepo} failed.`, detail: dispatch.stderr };
    }

    let runId = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 3000));
      const listing = await loggedExec(this.logger, "actions-test", "gh", listArgs);
      const latest = listing.code === 0 ? listing.stdout.trim() : "";
      if (latest && latest !== previousRunId) {
        runId = latest;
        break;
      }
    }
    if (!runId) {
      return { ok: false, error: `The dispatched run never appeared in ${syncRepo}'s run list.` };
    }

    const watch = await loggedExec(this.logger, "actions-test", "gh", [
      "run", "watch", runId, "--repo", syncRepo, "--exit-status", "--interval", "5",
    ]);
    if (watch.code !== 0) {
      return {
        ok: false,
        error: `The workflow run on ${syncRepo} did not succeed. Inspect it with \`gh run view ${runId} --repo ${syncRepo} --log\`.`,
        detail: watch.stderr,
      };
    }
    return { ok: true };
  }

  // --- Phase 6: wrap-up ---------------------------------------------------

  wrapup(): ActionResult {
    this.setStep("wrapup");
    const logPath = this.logger.finalize();
    return {
      ok: true,
      data: {
        databaseUrl: this.state.databaseUrl,
        skillsRepo: this.state.skillsRepo,
        skillsRepoUrl: this.state.skillsRepoUrl,
        syncRepoUrl: this.state.syncRepo ? `https://github.com/${this.state.syncRepo}` : undefined,
        claudeHelp: this.state.skillsRepo ? claudeGithubAppHelp(this.state.skillsRepo) : undefined,
        logPath,
      },
    };
  }
}
