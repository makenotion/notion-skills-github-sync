"use strict";

/* ------------------------------------------------------------------ *
 * Notion Skills Sync — visual setup wizard (front-end).
 * Plain JS, no build step. Each screen maps to one server action in
 * src/web/actions.ts; all side effects happen server-side.
 * ------------------------------------------------------------------ */

const state = {
  token: new URLSearchParams(location.search).get("token") || "",
  stepIndex: 0,
  steps: [
    { key: "welcome", label: "Welcome" },
    { key: "database", label: "Notion DB" },
    { key: "repos", label: "GitHub repos" },
    { key: "tokens", label: "Access tokens" },
    { key: "deploy", label: "Deploy" },
    { key: "claude", label: "Connect Claude" },
  ],
  data: {},
};

/* ---- tiny helpers ---- */

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-setup-token": state.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

function esc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function linkify(text) {
  return esc(text).replace(
    /(https?:\/\/[^\s)]+)/g,
    '<a class="link" href="$1" target="_blank" rel="noopener">$1</a>',
  );
}

const stage = document.getElementById("stage");

function setStage(html) {
  stage.innerHTML = html;
}

function $(sel) {
  return stage.querySelector(sel);
}

function renderChrome() {
  document.getElementById("stepcount").textContent =
    `Step ${state.stepIndex + 1} of ${state.steps.length}`;
  const stepper = document.getElementById("stepper");
  stepper.innerHTML = state.steps
    .map((_, i) => {
      const cls =
        i < state.stepIndex ? "seg done" : i === state.stepIndex ? "seg active" : "seg";
      return `<div class="${cls}"></div>`;
    })
    .join("");
}

function go(index) {
  state.stepIndex = Math.max(0, Math.min(state.steps.length - 1, index));
  renderChrome();
  SCREENS[state.steps[state.stepIndex].key]();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function wireNav(onNext) {
  const back = $("#nav-back");
  if (back) back.onclick = () => go(state.stepIndex - 1);
  const next = $("#nav-next");
  if (next && onNext) next.onclick = onNext;
}

/* ================================================================== *
 * Screens
 * ================================================================== */

const SCREENS = {};

/* ---- Welcome + preflight checks ---- */
SCREENS.welcome = function () {
  setStage(`
    <div class="card">
      <p class="eyebrow">Welcome</p>
      <h1 class="title">Sync your team's Notion skills into Claude</h1>
      <div class="flow">
        <div class="node">Notion Skills DB<small>source of truth</small></div>
        <div class="arrow">→</div>
        <div class="node">Skills repo<small>plugin marketplace</small></div>
        <div class="arrow">→</div>
        <div class="node">Claude / Cowork<small>your team</small></div>
      </div>
      <p class="lede">
        Your team writes skills in Notion. This wizard sets up an hourly sync so
        those skills show up in Claude for everyone — no code required from your
        teammates. Takes about 10 minutes; you'll create two access tokens midway.
      </p>
      <div id="checks"></div>
      <div class="actions">
        <div class="spacer"></div>
        <button class="btn btn-primary" id="do-check">Check my setup</button>
      </div>
    </div>
  `);
  $("#do-check").onclick = runPreflight;
};

async function runPreflight() {
  const checks = $("#checks");
  checks.innerHTML = `<div class="working"><span class="spinner"></span> Checking your tools (Notion CLI, GitHub CLI)…</div>`;
  $("#do-check").disabled = true;
  const res = await api("/api/preflight", {});
  state.data.preflight = res.data || {};
  const d = res.data || {};
  const notion = d.notion || {};
  const github = d.github || {};

  const row = (ok, label, detail) => `
    <div class="status-row">
      <span class="status-ico ${ok ? "ok" : "err"}">${ok ? "✓" : "✕"}</span>
      <div><strong>${esc(label)}</strong>${detail ? ` — <span class="muted">${esc(detail)}</span>` : ""}</div>
    </div>`;

  let html = `<div class="summary" style="margin-top:6px">
    ${row(notion.authed, "Notion CLI", notion.authed ? (notion.who ? `signed in as ${notion.who}` : "authenticated") : "not authenticated")}
    ${row(github.installed && github.authed, "GitHub CLI", github.authed ? `signed in as ${github.user || "you"}` : github.installed ? "not authenticated" : "not installed")}
  </div>`;

  if (!notion.authed && d.notionHelp) {
    html += `<div class="callout warn">${linkify(d.notionHelp)}</div>`;
  }
  if (!github.installed) {
    html += `<div class="callout warn">Install the GitHub CLI from https://cli.github.com, run <code>gh auth login</code>, then re-check.</div>`;
  } else if (!github.authed) {
    html += `<div class="callout warn">Run <code>gh auth login</code> in your terminal, then re-check.</div>`;
  }

  checks.innerHTML = html;

  const actions = $(".actions");
  const allGood = notion.authed && github.installed && github.authed;
  actions.innerHTML = `
    <button class="btn" id="recheck">Re-check</button>
    <div class="spacer"></div>
    <button class="btn btn-primary" id="nav-next">${allGood ? "Continue" : "Continue anyway"}</button>`;
  $("#recheck").onclick = runPreflight;
  $("#nav-next").onclick = () => go(1);
}

/* ---- Notion database ---- */
SCREENS.database = function () {
  const created = state.data.database;
  setStage(`
    <div class="card">
      <p class="eyebrow">Step 2 · Notion database</p>
      <h1 class="title">Create your Skills database</h1>
      <p class="lede">
        We'll create a Notion database (with a few sample skills) where your team
        writes and edits skills. It's the source of truth for everything that syncs.
      </p>
      <div class="field">
        <label class="lbl" for="dbname">Database name <span class="hint">— you can rename it later in Notion</span></label>
        <input type="text" id="dbname" value="${esc(created ? state.data.dbName : "Skills")}" ${created ? "disabled" : ""} />
      </div>
      <div id="db-result"></div>
      <div class="actions">
        <button class="btn btn-ghost" id="nav-back">Back</button>
        <div class="spacer"></div>
        ${created ? '<button class="btn btn-primary" id="nav-next">Continue</button>' : '<button class="btn btn-primary" id="do-create-db">Create database</button>'}
      </div>
    </div>
  `);
  $("#nav-back").onclick = () => go(0);
  if (created) {
    renderDbResult(state.data.database);
    wireNav(() => go(2));
  } else {
    $("#do-create-db").onclick = createDb;
  }
};

async function createDb() {
  const name = $("#dbname").value.trim() || "Skills";
  state.data.dbName = name;
  const btn = $("#do-create-db");
  btn.disabled = true;
  $("#dbname").disabled = true;
  $("#db-result").innerHTML = `<div class="working"><span class="spinner"></span> Creating "${esc(name)}" and adding sample skills…</div>`;
  const res = await api("/api/create-db", { dbName: name });
  if (res.ok) {
    state.data.database = res.data;
    renderDbResult(res.data);
    const actions = $(".actions");
    actions.innerHTML = `<button class="btn btn-ghost" id="nav-back">Back</button><div class="spacer"></div><button class="btn btn-primary" id="nav-next">Continue</button>`;
    wireNav(() => go(2));
  } else {
    $("#db-result").innerHTML = `<div class="callout err"><strong>${esc(res.error || "Failed to create the database.")}</strong>${res.detail ? `\n\n${esc(res.detail)}` : ""}</div>`;
    btn.disabled = false;
    $("#dbname").disabled = false;
  }
}

function renderDbResult(data) {
  $("#db-result").innerHTML = `
    <div class="callout ok">✓ Database ready with ${esc(data.created)}/${esc(data.total)} sample skills.</div>
    <div class="summary"><div class="row"><span class="k">Notion Skills DB</span><span class="v">${linkify(data.databaseUrl)}</span></div></div>`;
}

/* ---- GitHub repos ---- */
SCREENS.repos = function () {
  const pf = state.data.preflight || {};
  const gh = pf.github || {};
  const defaultOwner = (gh.orgs && gh.orgs[0]) || gh.user || "your-org";
  const origin = pf.detectedOrigin;
  const done = state.data.repos;

  setStage(`
    <div class="card">
      <p class="eyebrow">Step 3 · GitHub</p>
      <h1 class="title">Create your repositories</h1>
      <p class="lede">
        Two private repos: the <strong>skills repo</strong> (where plugins are published — your
        team never touches it) and the <strong>sync script repo</strong> (this code + config, where
        the hourly workflow runs).
      </p>

      <div class="field">
        <label class="lbl">Skills repo</label>
        <label class="choice sel" data-group="skills" data-val="new">
          <input type="radio" name="skills-mode" value="new" checked />
          <div class="choice-body"><div class="choice-title">Create a new repo</div><div class="choice-hint">Recommended</div></div>
        </label>
        <label class="choice" data-group="skills" data-val="existing">
          <input type="radio" name="skills-mode" value="existing" />
          <div class="choice-body"><div class="choice-title">Use an existing repo</div><div class="choice-hint">⚠ the sync overwrites its contents every run</div></div>
        </label>
        <input type="text" id="skills-repo" value="${esc(defaultOwner)}/notion-skills" style="margin-top:8px" />
      </div>

      <div class="field">
        <label class="lbl">Sync script repo</label>
        <label class="choice sel" data-group="sync" data-val="new">
          <input type="radio" name="sync-mode" value="new" checked />
          <div class="choice-body"><div class="choice-title">Create a new repo</div><div class="choice-hint">Recommended</div></div>
        </label>
        ${
          origin
            ? `<label class="choice" data-group="sync" data-val="origin">
                 <input type="radio" name="sync-mode" value="origin" />
                 <div class="choice-body"><div class="choice-title">Use current origin</div><div class="choice-hint">${esc(origin)} — only if it's your own copy</div></div>
               </label>`
            : ""
        }
        <input type="text" id="sync-repo" value="${esc(defaultOwner)}/notion-skills-github-sync" style="margin-top:8px" />
      </div>

      <div id="repos-result"></div>
      <div class="actions">
        <button class="btn btn-ghost" id="nav-back">Back</button>
        <div class="spacer"></div>
        ${done ? '<button class="btn btn-primary" id="nav-next">Continue</button>' : '<button class="btn btn-primary" id="do-create-repos">Create repositories</button>'}
      </div>
    </div>
  `);

  // choice selection styling
  stage.querySelectorAll(".choice").forEach((c) => {
    c.onclick = () => {
      const group = c.getAttribute("data-group");
      stage
        .querySelectorAll(`.choice[data-group="${group}"]`)
        .forEach((x) => x.classList.remove("sel"));
      c.classList.add("sel");
      c.querySelector("input").checked = true;
      if (group === "sync") {
        $("#sync-repo").style.display =
          c.getAttribute("data-val") === "origin" ? "none" : "";
      }
    };
  });

  if (done) {
    renderReposResult(state.data.repos);
    wireNav(() => go(3));
  } else {
    $("#do-create-repos").onclick = createRepos;
    $("#nav-back").onclick = () => go(1);
  }
};

async function createRepos() {
  const skillsMode = stage.querySelector('input[name="skills-mode"]:checked').value;
  const syncMode = stage.querySelector('input[name="sync-mode"]:checked').value;
  const skillsRepo = $("#skills-repo").value.trim();
  const origin = (state.data.preflight || {}).detectedOrigin;
  const syncRepo = syncMode === "origin" ? origin : $("#sync-repo").value.trim();

  if (!skillsRepo.includes("/") || !syncRepo || !syncRepo.includes("/")) {
    $("#repos-result").innerHTML = `<div class="callout err">Repositories must be in <code>owner/name</code> format.</div>`;
    return;
  }

  const btn = $("#do-create-repos");
  btn.disabled = true;
  $("#repos-result").innerHTML = `<div class="working"><span class="spinner"></span> Creating repositories on GitHub…</div>`;
  const res = await api("/api/create-repos", {
    skillsRepo,
    skillsRepoIsNew: skillsMode === "new",
    syncRepo,
    syncRepoIsNew: syncMode === "new",
  });
  if (res.ok) {
    state.data.repos = { ...res.data, skillsRepo, syncRepo };
    renderReposResult(state.data.repos);
    const actions = $(".actions");
    actions.innerHTML = `<button class="btn btn-ghost" id="nav-back">Back</button><div class="spacer"></div><button class="btn btn-primary" id="nav-next">Continue</button>`;
    wireNav(() => go(3));
  } else {
    $("#repos-result").innerHTML = `<div class="callout err"><strong>${esc(res.error || "Could not create the repositories.")}</strong>${res.detail ? `\n\n${esc(res.detail)}` : ""}</div>`;
    btn.disabled = false;
  }
}

function renderReposResult(data) {
  $("#repos-result").innerHTML = `
    <div class="callout ok">✓ Repositories ready.</div>
    <div class="summary">
      <div class="row"><span class="k">Skills repo</span><span class="v">${linkify(data.skillsRepoUrl)}</span></div>
      <div class="row"><span class="k">Sync script repo</span><span class="v">${linkify(data.syncRepoUrl)}</span></div>
    </div>`;
}

/* ---- Access tokens ---- */
SCREENS.tokens = async function () {
  setStage(`
    <div class="card">
      <p class="eyebrow">Step 4 · Access tokens</p>
      <h1 class="title">Create two access tokens</h1>
      <p class="lede">
        Each is scoped as tightly as possible: a GitHub token that can push only to
        your skills repo, and a Notion token that can read only your Skills DB.
      </p>
      <div id="pat-block" class="field"></div>
      <div id="notion-block" class="field"></div>
      <div class="actions">
        <button class="btn btn-ghost" id="nav-back">Back</button>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="nav-next" ${state.data.ghTokenOk && state.data.notionTokenOk ? "" : "disabled"}>Continue</button>
      </div>
    </div>
  `);
  $("#nav-back").onclick = () => go(2);
  $("#nav-next").onclick = () => go(4);

  const pat = await api("/api/pat-info");
  renderPatBlock(pat.data || {});
  const nc = await api("/api/notion-connection-info");
  renderNotionBlock(nc.data || {});
};

function updateTokensNext() {
  const next = $("#nav-next");
  if (next) next.disabled = !(state.data.ghTokenOk && state.data.notionTokenOk);
}

function renderPatBlock(d) {
  const ok = state.data.ghTokenOk;
  $("#pat-block").innerHTML = `
    <label class="lbl">GitHub fine-grained PAT ${ok ? '<span class="pill">✓ verified</span>' : ""}</label>
    <p class="muted">
      Open the pre-filled token page, under <strong>Repository access</strong> choose
      <strong>Only select repositories → ${esc(d.skillsRepo || "")}</strong>, set
      <strong>Contents: read and write</strong>, generate, and paste it here.
    </p>
    <p><a class="link" href="${esc(d.patUrl)}" target="_blank" rel="noopener">Open the GitHub token page ↗</a></p>
    ${d.approvalHelp ? `<div class="callout">${linkify(d.approvalHelp)}</div>` : ""}
    <div style="display:flex; gap:8px; align-items:flex-start">
      <input type="password" id="gh-token" class="mono" placeholder="github_pat_… or ghp_…" ${ok ? "disabled" : ""} style="flex:1" />
      <button class="btn" id="verify-gh" ${ok ? "disabled" : ""}>Verify</button>
    </div>
    <div id="gh-token-result"></div>`;
  if (!ok) $("#verify-gh").onclick = verifyGithubToken;
}

async function verifyGithubToken() {
  const token = $("#gh-token").value.trim();
  if (!token) return;
  const btn = $("#verify-gh");
  btn.disabled = true;
  $("#gh-token-result").innerHTML = `<div class="working"><span class="spinner"></span> Checking push access…</div>`;
  const res = await api("/api/validate-github-token", { token });
  if (res.ok) {
    state.data.ghTokenOk = true;
    renderPatBlock({ ...(await api("/api/pat-info")).data });
    updateTokensNext();
  } else {
    $("#gh-token-result").innerHTML = `<div class="callout err">${esc(res.error || "Could not verify the token.")}</div>`;
    btn.disabled = false;
  }
}

function renderNotionBlock(d) {
  const ok = state.data.notionTokenOk;
  $("#notion-block").innerHTML = `
    <label class="lbl">Notion access token ${ok ? '<span class="pill">✓ verified</span>' : ""}</label>
    <p class="muted">
      On the connections page click <strong>New connection</strong>, pick
      <strong>Access token</strong> as the method, create it, and copy the token.
      Then open your database and add the connection under
      <strong>··· → Connections → Add connection</strong>.
    </p>
    <p>
      <a class="link" href="${esc(d.integrationsUrl)}" target="_blank" rel="noopener">Open Notion connections ↗</a>
      ${d.databaseUrl ? ` &nbsp;·&nbsp; <a class="link" href="${esc(d.databaseUrl)}" target="_blank" rel="noopener">Open your database ↗</a>` : ""}
    </p>
    ${d.connectionHelp ? `<div class="callout">${linkify(d.connectionHelp)}</div>` : ""}
    <div style="display:flex; gap:8px; align-items:flex-start">
      <input type="password" id="notion-token" class="mono" placeholder="ntn_… / secret_…" ${ok ? "disabled" : ""} style="flex:1" />
      <button class="btn" id="verify-notion" ${ok ? "disabled" : ""}>Verify</button>
    </div>
    <div id="notion-token-result"></div>`;
  if (!ok) $("#verify-notion").onclick = verifyNotionToken;
}

async function verifyNotionToken() {
  const token = $("#notion-token").value.trim();
  if (!token) return;
  const btn = $("#verify-notion");
  btn.disabled = true;
  $("#notion-token-result").innerHTML = `<div class="working"><span class="spinner"></span> Checking access to the database…</div>`;
  const res = await api("/api/validate-notion-token", { token });
  if (res.ok) {
    state.data.notionTokenOk = true;
    renderNotionBlock({ ...(await api("/api/notion-connection-info")).data });
    updateTokensNext();
  } else {
    $("#notion-token-result").innerHTML = `<div class="callout err">${esc(res.error || "Could not verify the token.")}</div>`;
    btn.disabled = false;
  }
}

/* ---- Deploy & verify ---- */
SCREENS.deploy = function () {
  const done = state.data.deploy;
  setStage(`
    <div class="card">
      <p class="eyebrow">Step 5 · Deploy</p>
      <h1 class="title">Deploy &amp; verify</h1>
      <p class="lede">
        This writes your <code>config.json</code>, pushes the sync script, stores the
        two tokens as encrypted secrets, runs a test sync, and triggers a real
        GitHub Actions run to prove the whole path works.
      </p>
      <div id="deploy-result"></div>
      <div class="actions">
        <button class="btn btn-ghost" id="nav-back">Back</button>
        <div class="spacer"></div>
        ${done ? '<button class="btn btn-primary" id="nav-next">Continue</button>' : '<button class="btn btn-primary" id="do-deploy">Deploy now</button>'}
      </div>
    </div>
  `);
  $("#nav-back").onclick = () => go(3);
  if (done) {
    renderDeployResult(state.data.deploy);
    wireNav(() => go(5));
  } else {
    $("#do-deploy").onclick = deploy;
  }
};

async function deploy() {
  const btn = $("#do-deploy");
  btn.disabled = true;
  $("#deploy-result").innerHTML = `<div class="working"><span class="spinner"></span> Deploying and watching a live Actions run — this can take a couple of minutes…</div>`;
  const res = await api("/api/deploy", {});
  if (res.ok) {
    state.data.deploy = res.data;
    renderDeployResult(res.data);
    const actions = $(".actions");
    actions.innerHTML = `<button class="btn btn-ghost" id="nav-back">Back</button><div class="spacer"></div><button class="btn btn-primary" id="nav-next">Continue</button>`;
    $("#nav-back").onclick = () => go(3);
    wireNav(() => go(5));
  } else {
    $("#deploy-result").innerHTML = `
      <div class="callout err"><strong>${esc(res.error || "Deploy failed.")}</strong>${res.detail ? `\n\n${esc(res.detail)}` : ""}</div>
      <p class="faint">Stuck? Use the <strong>?</strong> button in the corner to get a ready-to-paste prompt (with your setup log) for a coding agent.</p>`;
    btn.disabled = false;
  }
}

function renderDeployResult() {
  $("#deploy-result").innerHTML = `<div class="callout ok">✓ Deployed and verified end to end. The workflow will now run hourly on its own.</div>`;
}

/* ---- Wrap-up: connect to Claude ---- */
SCREENS.claude = async function () {
  setStage(`
    <div class="card">
      <p class="eyebrow">Step 6 · Connect to Claude</p>
      <h1 class="title">You're all set 🎉</h1>
      <p class="lede">One last thing — register your new marketplace in Claude so the skills reach your team.</p>
      <div id="wrap"></div>
    </div>
  `);
  const res = await api("/api/wrapup");
  const d = res.data || {};
  $("#wrap").innerHTML = `
    <ol class="steps-list">
      <li>In Claude (as an org admin), go to <strong>Organization settings → Plugins</strong>.</li>
      <li>Click <strong>Add plugin</strong> and choose <strong>GitHub</strong> as the source.</li>
      <li>Enter your skills repo${d.skillsRepo ? `: <strong>${esc(d.skillsRepo)}</strong>` : ""} and verify access.</li>
      <li>Optional: open the marketplace's ··· menu and turn on <strong>Sync automatically</strong>.</li>
    </ol>
    ${d.claudeHelp ? `<div class="callout">${linkify(d.claudeHelp)}</div>` : ""}
    <div class="summary">
      ${d.databaseUrl ? `<div class="row"><span class="k">Notion Skills DB</span><span class="v">${linkify(d.databaseUrl)}</span></div>` : ""}
      ${d.skillsRepoUrl ? `<div class="row"><span class="k">Skills repo</span><span class="v">${linkify(d.skillsRepoUrl)}</span></div>` : ""}
      ${d.syncRepoUrl ? `<div class="row"><span class="k">Sync script repo</span><span class="v">${linkify(d.syncRepoUrl)}</span></div>` : ""}
    </div>
    <p class="muted">Team members write skills in Notion and check <strong>Published</strong> — the sync picks them up within the hour, and they appear in Claude for everyone.</p>
    ${d.logPath ? `<p class="faint">Setup log: ${esc(d.logPath)}</p>` : ""}
    <div class="actions"><div class="spacer"></div><button class="btn btn-ghost" id="nav-back">Back</button></div>`;
  $("#nav-back").onclick = () => go(4);
};

/* ================================================================== *
 * Eject to coding agent
 * ================================================================== */

const ejectModal = document.getElementById("eject-modal");
document.getElementById("help-fab").onclick = openEject;
document.getElementById("eject-close").onclick = () => (ejectModal.hidden = true);
ejectModal.onclick = (e) => {
  if (e.target === ejectModal) ejectModal.hidden = true;
};

async function openEject() {
  const text = document.getElementById("eject-text");
  text.value = "Gathering your setup log…";
  ejectModal.hidden = false;
  const res = await api("/api/eject");
  const d = (res && res.data) || {};
  text.value = d.prompt || "Could not build a prompt.";
  document.getElementById("eject-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(text.value);
      const b = document.getElementById("eject-copy");
      b.textContent = "Copied!";
      setTimeout(() => (b.textContent = "Copy prompt"), 1500);
    } catch {
      text.select();
    }
  };
  document.getElementById("eject-download").onclick = () => {
    const blob = new Blob([d.logContents || ""], { type: "application/x-ndjson" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "notion-sync-setup.log.jsonl";
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

/* ---- boot ---- */
go(0);
