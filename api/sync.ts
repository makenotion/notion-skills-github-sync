// Vercel serverless entrypoint for the cron sync.
//
// ⚠ Caveat: this path is scaffolding. The default Notion adapter shells out to
// the `ntn` CLI, which is NOT available in Vercel's serverless runtime, and the
// dev Notion workspace is likely unreachable from external hosts. To run on
// Vercel you must (1) implement a direct-REST `NotionClient` (see
// src/notion/types.ts) against a reachable API, and (2) provide GITHUB_TOKEN +
// the Notion creds as Vercel environment variables. The GitHub write path
// already works anywhere (plain HTTPS + token).
import { loadConfig } from "../src/config.ts";
import { runSync } from "../src/sync.ts";

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
    const result = await runSync(loadConfig());
    res.status(200).json({
      committed: result.committed,
      commitSha: result.commitSha ?? null,
      branch: result.branch,
      skills: result.plan.desiredSlugs,
      pruned: result.plan.prunedSlugs,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
