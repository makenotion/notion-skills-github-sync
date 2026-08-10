// Vercel serverless entrypoint for the cron sync.
//
// ⚠ Caveat: this path is scaffolding — written but never deployed. Both sides
// of the sync are now plain HTTPS (the Notion Skills API and the GitHub Git
// Data API), so there is no longer a CLI dependency blocking a serverless
// runtime. What's left to verify: provide NOTION_API_TOKEN + GITHUB_TOKEN as
// Vercel environment variables, and confirm the Notion API host is reachable
// from the deployment (the dev workspace in particular may not be).
//
// Configuration is environment-only, which suits a serverless deployment: the
// same variables the workflow sets become Vercel env vars.
import { buildSync } from "../src/wire.ts";
import { loadConfig } from "../src/config.ts";
import { runSync } from "../src/sync/engine.ts";

interface Req {
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  // Protect the endpoint: require the configured cron secret if one is set.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }

  try {
    const config = loadConfig();
    const result = await runSync(buildSync(config));
    res.status(200).json({
      committed: result.committed,
      commitSha: result.revision ?? null,
      branch: config.github.branch,
      plugins: result.plan.pluginSlugs,
      pruned: result.plan.prunedSlugs,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
