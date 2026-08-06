// Manual smoke probes against a real Graph mailbox. Verifies the live-tenant
// behaviors MailMCP's GraphBackend depends on:
//   P1  internetMessageHeaders on list endpoints via $select
//   P2  timestamp precision; equality filter miss; one-second range hit
//   P3  /me/messages range filter reaches Junk
//   P4  drafts resolve via createdDateTime range in the drafts folder
//   P5  Prefer: IdType="ImmutableId" keeps ids stable across /move
//
// Usage:
//   env GRAPH_TENANT_ID=<tenant> GRAPH_CLIENT_ID=<app id> node scripts/graph-smoke.mjs
//
// Scopes: Mail.Read Mail.ReadWrite offline_access (P5 moves a message).
// Token cache: .graph-token-cache/smoke.json (git-ignored, mode 600).

import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const AUTHORITY = (tenant) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPE = "Mail.Read Mail.ReadWrite offline_access";
const CACHE_DIR = new URL("../.graph-token-cache/", import.meta.url).pathname;
const CACHE_PATH = `${CACHE_DIR}smoke.json`;

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`Missing env var ${name}.`);
    console.error("Run: env GRAPH_TENANT_ID=<tenant> GRAPH_CLIENT_ID=<app id> node scripts/graph-smoke.mjs");
    process.exit(1);
  }
  return value;
}

const TENANT_ID = requireEnv("GRAPH_TENANT_ID");
const CLIENT_ID = requireEnv("GRAPH_CLIENT_ID");

async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await res.json();
  return { ok: res.ok, status: res.status, body };
}

async function deviceCodeLogin() {
  const dc = await postForm(`${AUTHORITY(TENANT_ID)}/devicecode`, { client_id: CLIENT_ID, scope: SCOPE });
  if (!dc.ok) throw new Error(`devicecode request failed (${dc.status}): ${JSON.stringify(dc.body)}`);
  console.log(`\n>>> Sign in: open ${dc.body.verification_uri} and enter code ${dc.body.user_code}`);
  console.log(">>> Waiting for sign-in to complete...\n");
  const deadline = Date.now() + dc.body.expires_in * 1000;
  let intervalMs = (dc.body.interval + 1) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const tok = await postForm(`${AUTHORITY(TENANT_ID)}/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: CLIENT_ID,
      device_code: dc.body.device_code,
    });
    if (tok.ok) return tok.body;
    if (tok.body.error === "authorization_pending") continue;
    if (tok.body.error === "slow_down") { intervalMs += 5000; continue; }
    throw new Error(`token poll failed (${tok.status}): ${JSON.stringify(tok.body)}`);
  }
  throw new Error("Device code expired before sign-in completed. Re-run the script.");
}

async function refreshLogin(refreshToken) {
  const tok = await postForm(`${AUTHORITY(TENANT_ID)}/token`, {
    grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken, scope: SCOPE,
  });
  if (!tok.ok) {
    console.warn(`Token refresh failed (${tok.status}); falling back to device code.`);
    return null;
  }
  return tok.body;
}

async function getAccessToken() {
  mkdirSync(CACHE_DIR, { recursive: true });
  let cached = null;
  try { cached = JSON.parse(await readFile(CACHE_PATH, "utf8")); } catch { cached = null; }
  if (cached !== null && Date.now() < cached.expires_at - 60_000) return cached.access_token;
  let tokens = null;
  if (cached !== null && cached.refresh_token) tokens = await refreshLogin(cached.refresh_token);
  if (tokens === null) tokens = await deviceCodeLogin();
  await writeFile(CACHE_PATH, JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
  }), { mode: 0o600 });
  return tokens.access_token;
}

const headers = (token) => ({ authorization: `Bearer ${token}`, prefer: 'IdType="ImmutableId"' });

async function graphGet(token, pathAndQuery) {
  const res = await fetch(`${GRAPH}${pathAndQuery}`, { headers: headers(token) });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function graphPost(token, path, payload) {
  const res = await fetch(`${GRAPH}${path}`, {
    method: "POST",
    headers: { ...headers(token), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function report(label, outcome, detail) {
  console.log(`[${outcome}] ${label}${detail ? ` :: ${detail}` : ""}`);
}

const enc = encodeURIComponent;

// Graph stores timestamps at ms precision but renders them truncated to
// seconds; equality on rendered values misses. Always probe with a range.
function secondRange(field, isoTimestamp) {
  const floor = isoTimestamp.replace(/\.\d+Z?$/, "Z").replace(/Z?$/, "Z");
  const ceil = new Date(Date.parse(floor) + 1000).toISOString().replace(/\.\d+Z$/, "Z");
  return `${field} ge ${floor} and ${field} lt ${ceil}`;
}

async function main() {
  const token = await getAccessToken();
  console.log("Authenticated. Running probes.\n");

  const listSelect = "$select=id,subject,receivedDateTime,parentFolderId,internetMessageHeaders&$top=5";
  const allList = await graphGet(token, `/me/messages?${listSelect}`);
  let sample = [];
  if (!allList.ok) {
    report("P1a /me/messages with internetMessageHeaders in $select", "FAIL",
      `${allList.status}: ${JSON.stringify(allList.body.error ?? allList.body)}`);
  } else {
    sample = allList.body.value;
    const withHeaders = sample.filter((m) => Array.isArray(m.internetMessageHeaders) && m.internetMessageHeaders.length > 0);
    report("P1a /me/messages with internetMessageHeaders in $select",
      withHeaders.length === sample.length && sample.length > 0 ? "PASS" : "FAIL",
      `${withHeaders.length}/${sample.length} messages returned headers`);
  }
  const inboxList = await graphGet(token, `/me/mailFolders/inbox/messages?${listSelect}`);
  if (!inboxList.ok) {
    report("P1b /me/mailFolders/inbox/messages with internetMessageHeaders", "FAIL",
      `${inboxList.status}: ${JSON.stringify(inboxList.body.error ?? inboxList.body)}`);
  } else {
    const inboxSample = inboxList.body.value;
    const withHeaders = inboxSample.filter((m) => Array.isArray(m.internetMessageHeaders) && m.internetMessageHeaders.length > 0);
    report("P1b /me/mailFolders/inbox/messages with internetMessageHeaders",
      withHeaders.length === inboxSample.length && inboxSample.length > 0 ? "PASS" : "FAIL",
      `${withHeaders.length}/${inboxSample.length} messages returned headers`);
  }

  if (sample.length === 0) {
    report("P2-P5 probes", "SKIP", "mailbox returned no messages to probe with");
    return;
  }

  const subsecond = sample.filter((m) => /\.\d+/.test(m.receivedDateTime));
  report("P2a receivedDateTime precision", "INFO",
    `${subsecond.length}/${sample.length} listed values carry sub-second digits; raw sample: ${sample[0].receivedDateTime}`);

  const target = sample[0];
  const eqFilter = await graphGet(token,
    `/me/messages?$filter=${enc(`receivedDateTime eq ${target.receivedDateTime}`)}&$select=id`);
  if (!eqFilter.ok) {
    report("P2b equality filter on rendered value (expected to miss)", "INFO",
      `${eqFilter.status}: ${JSON.stringify(eqFilter.body.error ?? eqFilter.body)}`);
  } else {
    const hit = eqFilter.body.value.some((m) => m.id === target.id);
    report("P2b equality filter on rendered value (expected to miss)", hit ? "INFO" : "PASS",
      `${eqFilter.body.value.length} results, target ${hit ? "unexpectedly found" : "missing as expected"}`);
  }
  const rangeFilter = await graphGet(token,
    `/me/messages?$filter=${enc(secondRange("receivedDateTime", target.receivedDateTime))}&$select=id`);
  if (!rangeFilter.ok) {
    report("P2c one-second range filter", "FAIL",
      `${rangeFilter.status}: ${JSON.stringify(rangeFilter.body.error ?? rangeFilter.body)}`);
  } else {
    const hit = rangeFilter.body.value.some((m) => m.id === target.id);
    report("P2c one-second range filter", hit ? "PASS" : "FAIL",
      `${rangeFilter.body.value.length} results, target ${hit ? "found" : "MISSING"}`);
  }

  const junkList = await graphGet(token, "/me/mailFolders/junkemail/messages?$select=id,receivedDateTime&$top=1");
  if (!junkList.ok) {
    report("P3 cross-folder resolution reaches Junk", "FAIL",
      `listing junkemail failed ${junkList.status}: ${JSON.stringify(junkList.body.error ?? junkList.body)}`);
  } else if (junkList.body.value.length === 0) {
    report("P3 cross-folder resolution reaches Junk", "SKIP", "Junk folder is empty; put a message in Junk and re-run");
  } else {
    const junkMsg = junkList.body.value[0];
    const junkFind = await graphGet(token,
      `/me/messages?$filter=${enc(secondRange("receivedDateTime", junkMsg.receivedDateTime))}&$select=id`);
    if (!junkFind.ok) {
      report("P3 cross-folder resolution reaches Junk", "FAIL",
        `${junkFind.status}: ${JSON.stringify(junkFind.body.error ?? junkFind.body)}`);
    } else {
      const hit = junkFind.body.value.some((m) => m.id === junkMsg.id);
      report("P3 cross-folder resolution reaches Junk", hit ? "PASS" : "FAIL",
        `${junkFind.body.value.length} results, junk message ${hit ? "found" : "MISSING"}`);
    }
  }

  const draftList = await graphGet(token, "/me/mailFolders/drafts/messages?$select=id,createdDateTime&$top=1");
  if (!draftList.ok) {
    report("P4 draft resolution via createdDateTime", "FAIL",
      `listing drafts failed ${draftList.status}: ${JSON.stringify(draftList.body.error ?? draftList.body)}`);
  } else if (draftList.body.value.length === 0) {
    report("P4 draft resolution via createdDateTime", "SKIP", "Drafts folder is empty; create any draft and re-run");
  } else {
    const draft = draftList.body.value[0];
    const draftFind = await graphGet(token,
      `/me/mailFolders/drafts/messages?$filter=${enc(secondRange("createdDateTime", draft.createdDateTime))}&$select=id`);
    if (!draftFind.ok) {
      report("P4 draft resolution via createdDateTime", "FAIL",
        `${draftFind.status}: ${JSON.stringify(draftFind.body.error ?? draftFind.body)}`);
    } else {
      const hit = draftFind.body.value.some((m) => m.id === draft.id);
      report("P4 draft resolution via createdDateTime", hit ? "PASS" : "FAIL",
        `${draftFind.body.value.length} results, draft ${hit ? "found" : "MISSING"}`);
    }
  }

  // P5: ImmutableId stability across /move. Mutates the mailbox: moves the
  // newest inbox message to Junk and restores its ORIGINAL folder in finally.
  const p5List = await graphGet(token, "/me/mailFolders/inbox/messages?$select=id,parentFolderId,subject&$top=1");
  if (!p5List.ok || p5List.body.value.length === 0) {
    report("P5 immutable id across move", "SKIP", "no inbox message available");
    return;
  }
  const p5Target = p5List.body.value[0];
  const originalFolder = p5Target.parentFolderId;
  let movedId = null;
  try {
    const moved = await graphPost(token, `/me/messages/${enc(p5Target.id)}/move`, { destinationId: "junkemail" });
    if (!moved.ok) {
      report("P5 immutable id across move", "FAIL",
        `move failed ${moved.status}: ${JSON.stringify(moved.body.error ?? moved.body)}`);
      return;
    }
    movedId = moved.body.id;
    report("P5 immutable id across move", movedId === p5Target.id ? "PASS" : "FAIL",
      `id ${movedId === p5Target.id ? "unchanged" : `CHANGED: ${p5Target.id} -> ${movedId}`}`);
  } finally {
    const idToRestore = movedId ?? p5Target.id;
    const restored = await graphPost(token, `/me/messages/${enc(idToRestore)}/move`, { destinationId: originalFolder });
    if (!restored.ok) {
      report("P5 RESTORATION", "FAIL",
        `could not move '${p5Target.subject}' back to its original folder (${restored.status}); restore it manually`);
    } else {
      report("P5 restoration", "PASS", "message returned to its original folder");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
