#!/usr/bin/env node

/**
 * Fetches hosts with deep monitoring or backing a Kubernetes node,
 * retrieves memory info from each host entity, and outputs a CSV.
 *
 * Usage:
 *   DT_ENV_URL=https://{your-env}.live.dynatrace.com \
 *   DT_API_TOKEN=dt0c01.xxxx \
 *   node get-deep-monitored-hosts.js > hosts.csv
 *
 * Optional env vars:
 *   DT_FROM          – start of timeframe  (default: now-2h)
 *   DT_TO            – end of timeframe    (default: now)
 *   DT_PAGE_SIZE     – page size, max 500  (default: 500)
 *   DT_CONCURRENCY   – max parallel requests (default: 5)
 *   DT_REQ_DELAY_MS  – ms delay between request batches (default: 200)
 */

const DT_ENV_URL = (process.env.DT_ENV_URL || "").replace(/\/+$/, "");
const DT_API_TOKEN = process.env.DT_API_TOKEN || "";
const FROM = process.env.DT_FROM || "now-2h";
const TO = process.env.DT_TO || "now";
const PAGE_SIZE = process.env.DT_PAGE_SIZE || "500";
const CONCURRENCY = parseInt(process.env.DT_CONCURRENCY || "5", 10);
const REQ_DELAY_MS = parseInt(process.env.DT_REQ_DELAY_MS || "200", 10);

if (!DT_ENV_URL || !DT_API_TOKEN) {
  console.error("Error: Set DT_ENV_URL and DT_API_TOKEN environment variables.");
  console.error("  DT_ENV_URL   – e.g. https://abc12345.live.dynatrace.com");
  console.error("  DT_API_TOKEN – API token with entities.read scope");
  process.exit(1);
}

const BASE = `${DT_ENV_URL}/api/v2`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dtFetch(apiPath, params = {}) {
  const url = new URL(`${BASE}${apiPath}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }

  const headers = {
    Authorization: `Api-Token ${DT_API_TOKEN}`,
    Accept: "application/json",
  };

  let res = await fetch(url.toString(), { headers });

  // Handle 429 — back off and retry once
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10);
    console.error(`  ⚠ 429 rate-limited — waiting ${retryAfter}s before retry…`);
    await sleep(retryAfter * 1000);
    res = await fetch(url.toString(), { headers });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dynatrace API ${res.status}: ${body}`);
  }

  return res.json();
}

/**
 * Run async tasks with bounded concurrency and a delay between batches.
 */
async function runWithConcurrency(items, concurrency, delayMs, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);

    if (i + concurrency < items.length) {
      await sleep(delayMs);
    }

    console.error(
      `  Progress: ${Math.min(i + concurrency, items.length)}/${items.length}`
    );
  }
  return results;
}

/**
 * Paginate through /monitoringstate and collect all states.
 */
async function getAllMonitoringStates() {
  const states = [];
  let nextPageKey = null;

  do {
    const params = nextPageKey
      ? { nextPageKey }
      : {
          entitySelector: 'type("PROCESS_GROUP_INSTANCE")',
          from: FROM,
          to: TO,
          pageSize: PAGE_SIZE,
        };

    const data = await dtFetch("/monitoringstate", params);
    if (data.monitoringStates) {
      states.push(...data.monitoringStates);
    }
    nextPageKey = data.nextPageKey || null;

    console.error(
      `  Fetched ${data.monitoringStates?.length ?? 0} states (total so far: ${states.length})…`
    );
  } while (nextPageKey);

  return states;
}

/**
 * Resolve entity IDs in bulk using the entities v2 endpoint.
 */
async function getEntitiesById(entityIds, fields = "fromRelationships,properties") {
  const entities = [];
  const CHUNK = 50;

  for (let i = 0; i < entityIds.length; i += CHUNK) {
    const chunk = entityIds.slice(i, i + CHUNK);
    const selector = `entityId(${chunk.map((id) => `"${id}"`).join(",")})`;

    let nextPageKey = null;
    do {
      const params = nextPageKey
        ? { nextPageKey }
        : {
            entitySelector: selector,
            from: FROM,
            to: TO,
            fields,
            pageSize: "500",
          };

      const data = await dtFetch("/entities", params);
      if (data.entities) entities.push(...data.entities);
      nextPageKey = data.nextPageKey || null;
    } while (nextPageKey);

    if (i + CHUNK < entityIds.length) await sleep(REQ_DELAY_MS);
  }

  return entities;
}

/**
 * Paginate through /entities for a given selector.
 */
async function getAllEntities(entitySelector, fields) {
  const entities = [];
  let nextPageKey = null;

  do {
    const params = nextPageKey
      ? { nextPageKey }
      : {
          entitySelector,
          from: FROM,
          to: TO,
          fields,
          pageSize: "500",
        };

    const data = await dtFetch("/entities", params);
    if (data.entities) entities.push(...data.entities);
    nextPageKey = data.nextPageKey || null;

    console.error(
      `  Fetched ${data.entities?.length ?? 0} entities (total so far: ${entities.length})…`
    );
  } while (nextPageKey);

  return entities;
}

/**
 * Fetch a single host entity with full properties.
 */
async function getHostDetail(hostId) {
  return dtFetch(`/entities/${encodeURIComponent(hostId)}`, {
    from: FROM,
    to: TO,
    fields: "properties",
  });
}

/**
 * Extract system.memory.size from additionalSystemInfo array.
 */
function extractMemoryBytes(hostEntity) {
  const sysInfo = hostEntity.properties?.additionalSystemInfo || [];
  const entry = sysInfo.find((e) => e.key === "system.memory.size");
  return entry ? entry.value : null;
}

/**
 * Escape a CSV field.
 */
function csvEscape(val) {
  const str = String(val ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // ------------------------------------------------------------------
  // Source 1: Hosts with deep-monitored process group instances
  // ------------------------------------------------------------------
  console.error("=== Source 1: Deep-monitored PGIs ===\n");
  const states = await getAllMonitoringStates();
  console.error(`\nTotal PGI states: ${states.length}`);

  const DEEP_MONITORING_STATES = new Set([
    "deep_monitoring_successful",
    "restart_required_outdated_agent_injected",
  ]);

  const deepMonitored = states.filter((s) => DEEP_MONITORING_STATES.has(s.state));
  console.error(`Deep-monitored PGIs: ${deepMonitored.length}\n`);

  const hostIdSet = new Set();
  const hostSourceMap = new Map();

  if (deepMonitored.length > 0) {
    const pgiIds = deepMonitored.map((s) => s.entityId);

    console.error("Resolving PGI → Host relationships…\n");
    const pgiEntities = await getEntitiesById(pgiIds, "fromRelationships.isProcessOf");

    for (const pgi of pgiEntities) {
      const rels = pgi.fromRelationships?.isProcessOf || [];
      for (const rel of rels) {
        if (rel.id?.startsWith("HOST-")) {
          hostIdSet.add(rel.id);
          if (!hostSourceMap.has(rel.id)) hostSourceMap.set(rel.id, new Set());
          hostSourceMap.get(rel.id).add("deep_monitored_pgi");
        }
      }
    }
  }

  console.error(`Hosts from deep-monitored PGIs: ${hostIdSet.size}\n`);

  // ------------------------------------------------------------------
  // Source 2: Hosts underlying Kubernetes nodes
  // ------------------------------------------------------------------
  console.error("=== Source 2: Kubernetes nodes ===\n");
  const k8sNodes = await getAllEntities(
    'type("KUBERNETES_NODE")',
    "fromRelationships.isNodeOfHost"
  );
  console.error(`\nTotal Kubernetes nodes: ${k8sNodes.length}\n`);

  let k8sHostCount = 0;
  for (const node of k8sNodes) {
    const rels = node.fromRelationships?.isNodeOfHost || [];
    for (const rel of rels) {
      if (rel.id?.startsWith("HOST-")) {
        const isNew = !hostIdSet.has(rel.id);
        hostIdSet.add(rel.id);
        if (!hostSourceMap.has(rel.id)) hostSourceMap.set(rel.id, new Set());
        hostSourceMap.get(rel.id).add("kubernetes_node");
        if (isNew) k8sHostCount++;
      }
    }
  }

  console.error(`New hosts added from K8s nodes: ${k8sHostCount}`);
  console.error(`Total unique hosts (combined): ${hostIdSet.size}\n`);

  const allHostIds = [...hostIdSet];

  if (allHostIds.length === 0) {
    console.error("No hosts found.");
    console.log("displayName,entityId,sources,memoryBytes,memoryGiB");
    return;
  }

  // ------------------------------------------------------------------
  // Fetch each host's detail (rate-limit-safe concurrency)
  // ------------------------------------------------------------------
  console.error(
    `Fetching host details (concurrency=${CONCURRENCY}, delay=${REQ_DELAY_MS}ms)…\n`
  );

  const hostDetails = await runWithConcurrency(
    allHostIds,
    CONCURRENCY,
    REQ_DELAY_MS,
    (id) =>
      getHostDetail(id).catch((err) => {
        console.error(`  ⚠ Failed to fetch ${id}: ${err.message}`);
        return { entityId: id, displayName: id, properties: {} };
      })
  );

  // ------------------------------------------------------------------
  // Build CSV
  // ------------------------------------------------------------------
  const BYTES_PER_GIB = 1024 ** 3;

  const rows = hostDetails.map((h) => {
    const memBytes = extractMemoryBytes(h);
    const memGiB = memBytes ? (Number(memBytes) / BYTES_PER_GIB).toFixed(2) : "";
    const sources = [...(hostSourceMap.get(h.entityId) || [])].join(";");

    return [
      csvEscape(h.displayName),
      csvEscape(h.entityId),
      csvEscape(sources),
      memBytes ?? "",
      memGiB,
    ].join(",");
  });

  rows.sort();

  const csv = ["displayName,entityId,sources,memoryBytes,memoryGiB", ...rows].join(
    "\n"
  );

  const fs = require("fs");
  const outFile = process.env.DT_OUTPUT_FILE || "hosts.csv";
  fs.writeFileSync(outFile, csv + "\n", "utf-8");
  console.error(`\nDone — ${rows.length} hosts written to ${outFile}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
