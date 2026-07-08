#!/usr/bin/env node
// Prerequisite checker for notion-skills-github-sync.
//
// Deliberately written as plain Node-compatible ESM with no dependencies so it
// can run on a fresh machine that does NOT yet have Bun installed — e.g.
// `node scripts/check-prereqs.mjs` or `npm run check`. Its whole job is to catch
// the "Bun isn't installed" case (and other missing tools) up front, before a
// setup call, instead of discovering it live when `bun install` fails with
// "command not found".

import { spawnSync } from "node:child_process";

const BUN_INSTALL = "curl -fsSL https://bun.sh/install | bash";

/** Run `cmd --version`-style probe; return trimmed stdout or null if missing. */
function probe(cmd, args) {
  try {
    const res = spawnSync(cmd, args, { encoding: "utf8" });
    if (res.error || res.status !== 0) return null;
    return String(res.stdout || res.stderr || "").trim();
  } catch {
    return null;
  }
}

const checks = [
  {
    name: "Bun",
    version: () => probe("bun", ["--version"]),
    required: true,
    fix:
      `Bun is the runtime for this tool (Node.js is not supported). Install it:\n` +
      `      ${BUN_INSTALL}\n` +
      `    Then run the PATH line the installer prints, or open a new terminal, so\n` +
      `    the \`bun\` command is found.`,
  },
  {
    name: "ntn (Notion CLI)",
    version: () => probe("ntn", ["--version"]),
    required: false,
    fix:
      `Notion CLI, used for Notion reads. The guided setup installs it for you,\n` +
      `    or install manually: curl -fsSL https://ntn.dev | bash`,
  },
  {
    name: "gh (GitHub CLI)",
    version: () => probe("gh", ["--version"]),
    required: false,
    fix:
      `GitHub CLI, used to create repos and push during setup. Install from\n` +
      `    https://cli.github.com then run: gh auth login`,
  },
];

console.log("Checking prerequisites for notion-skills-github-sync...\n");

let missingRequired = false;
for (const check of checks) {
  const version = check.version();
  if (version) {
    const firstLine = version.split("\n")[0];
    console.log(`  [ok]      ${check.name}: ${firstLine}`);
  } else {
    const label = check.required ? "[MISSING]" : "[missing]";
    console.log(`  ${label} ${check.name}`);
    console.log(`    ${check.fix}`);
    if (check.required) missingRequired = true;
  }
}

console.log("");
if (missingRequired) {
  console.log(
    "Some required prerequisites are missing. Install them (see above), then re-run this check.",
  );
  process.exit(1);
}

console.log("All required prerequisites are installed. You're ready to run: bun run setup");
