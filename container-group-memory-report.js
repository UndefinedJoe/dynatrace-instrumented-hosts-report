#!/usr/bin/env node

/**
 * Reports memory footprint of Kubernetes Container Groups that have
 * deep-monitored PGIs — useful for scoping app-only deployments.
 *
 * Resolution chain:
 *   Deep-monitored PGI
 *     → CONTAINER_GROUP_INSTANCE  (fromRelationships.isPgiOfCgi)
 *       → CONTAINER_GROUP         (fromRelationships.isInstanceOf)      — reporting unit
 *       → CLOUD_APPLICATION_INSTANCE (fromRelationships.isCgiOfCai)     — limits/requests source
 *       → CLOUD_APPLICATION         (fromRelationships.isCgiOfCa)       — working set metric entity
 *
 * Memory strategy per Container Group:
 *   hasLimits=true  → sum limitsMemory / requestsMemory from pod specs (CAI properties)
 *   hasLimits=false → builtin:kubernetes.workload.memory_working_set via CLOUD_APPLICATION
 *                     (working set = RSS minus file cache; what kubelet uses for pod eviction)
 *
 * Usage:
 *   DT_ENV_URL=https://{your-env}.live.dynatrace.com \
 *   DT_API_TOKEN=dt0c01.xxxx \
 *   node container-group-memory-report.js
 *
 * Optional env vars:
 *   DT_FROM          – start of timeframe    (default: now-2h)
 *   DT_TO            – end of timeframe      (default: now)
 *   DT_PAGE_SIZE     – page size, max 500    (default: 500)
 *   DT_CONCURRENCY   – max parallel requests (default: 5)
 *   DT_REQ_DELAY_MS  – ms delay between batches (default: 200)
 *   DT_OUTPUT_FILE   – output file path      (default: container-groups.csv)
 *
 * Required API token scopes:
 *   entities.read  — always required
 *   metrics.read   — required for utilization fallback on CGs without limits;
 *                    without it those rows will have empty utilization columns
 */

const DT_ENV_URL = (process.env.DT_ENV_URL || "").replace(/\/+$/, "");
const DT_API_TOKEN = process.env.DT_API_TOKEN || "";
const FROM = process.env.DT_FROM || "now-2h";
const TO = process.env.DT_TO || "now";
const PAGE_SIZE = process.env.DT_PAGE_SIZE || "500";
const CONCURRENCY = parseInt(process.env.DT_CONCURRENCY || "5", 10);
const REQ_DELAY_MS = parseInt(process.env.DT_REQ_DELAY_MS || "200", 10);

// --ns <namespace> flag or DT_NAMESPACE env var; null means no filter
const nsArgIdx = process.argv.indexOf("--ns");
const NAMESPACE_FILTER = nsArgIdx !== -1 ? process.argv[nsArgIdx + 1] : (process.env.DT_NAMESPACE || null);

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
 * Returns true if a given entity type exists in this environment.
 */
async function entityTypeExists(typeName) {
  let nextPageKey = null;
  do {
    const params = nextPageKey ? { nextPageKey } : { pageSize: "500" };
    const data = await dtFetch("/entityTypes", params);
    if ((data.types || []).some((t) => t.type === typeName)) return true;
    nextPageKey = data.nextPageKey || null;
  } while (nextPageKey);
  return false;
}

/**
 * Paginate through /monitoringstate and collect all PGI states.
 */
async function getAllMonitoringStates() {
  const states = [];
  let nextPageKey = null;

  do {
    const params = nextPageKey
      ? { nextPageKey }
      : { entitySelector: 'type("PROCESS_GROUP_INSTANCE")', from: FROM, to: TO, pageSize: PAGE_SIZE };

    const data = await dtFetch("/monitoringstate", params);
    if (data.monitoringStates) states.push(...data.monitoringStates);
    nextPageKey = data.nextPageKey || null;

    console.error(`  Fetched ${data.monitoringStates?.length ?? 0} states (total so far: ${states.length})…`);
  } while (nextPageKey);

  return states;
}

/**
 * Resolve a list of entity IDs in chunks, requesting the given fields.
 */
async function getEntitiesById(entityIds, fields) {
  const entities = [];
  const CHUNK = 50;

  for (let i = 0; i < entityIds.length; i += CHUNK) {
    const chunk = entityIds.slice(i, i + CHUNK);
    const selector = `entityId(${chunk.map((id) => `"${id}"`).join(",")})`;

    let nextPageKey = null;
    do {
      const params = nextPageKey
        ? { nextPageKey }
        : { entitySelector: selector, from: FROM, to: TO, fields, pageSize: "500" };

      const data = await dtFetch("/entities", params);
      if (data.entities) entities.push(...data.entities);
      nextPageKey = data.nextPageKey || null;
    } while (nextPageKey);

    if (i + CHUNK < entityIds.length) await sleep(REQ_DELAY_MS);
  }

  return entities;
}

/**
 * Query builtin:kubernetes.workload.memory_working_set for a set of CLOUD_APPLICATION entity IDs.
 * Returns a Map of CA entity ID → avg working set bytes over the timeframe.
 * Working set (RSS minus file cache) is what kubelet uses for pod eviction decisions.
 */
async function getCaWorkingSetMemory(caIds) {
  const caToBytes = new Map();
  if (caIds.length === 0) return caToBytes;

  const CHUNK = 50;
  const metricSelector =
    'builtin:kubernetes.workload.memory_working_set:splitBy("dt.entity.cloud_application"):avg';

  for (let i = 0; i < caIds.length; i += CHUNK) {
    const chunk = caIds.slice(i, i + CHUNK);
    const entitySelector = `type("CLOUD_APPLICATION"),entityId(${chunk.map((id) => `"${id}"`).join(",")})`;

    let data;
    try {
      data = await dtFetch("/metrics/query", {
        metricSelector,
        entitySelector,
        resolution: "Inf",
        from: FROM,
        to: TO,
      });
    } catch (err) {
      console.error(`  ⚠ Metrics query failed for chunk ${i / CHUNK + 1}: ${err.message}`);
      continue;
    }

    for (const result of data.result || []) {
      for (const series of result.data || []) {
        const caId = series.dimensionMap?.["dt.entity.cloud_application"];
        const value = series.values?.find((v) => v != null);
        if (caId && value != null) {
          caToBytes.set(caId, value);
        }
      }
    }

    if (i + CHUNK < caIds.length) await sleep(REQ_DELAY_MS);
  }

  return caToBytes;
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

const BYTES_PER_GIB = 1024 ** 3;
const toGiB = (bytes) => (Number(bytes) / BYTES_PER_GIB).toFixed(2);

// DPS app-only billing: round up to nearest 0.25 GiB, 256 MiB minimum.
// https://docs.dynatrace.com/docs/shortlink/dps-full-stack#app-only-gib-hour
const BILLING_MIN_BYTES = 256 * 1024 * 1024;
const BILLING_STEP_GIB = 0.25;
const toBillingGiB = (bytes) => {
  const effective = Math.max(Number(bytes), BILLING_MIN_BYTES);
  return (Math.ceil((effective / BYTES_PER_GIB) / BILLING_STEP_GIB) * BILLING_STEP_GIB).toFixed(2);
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // ------------------------------------------------------------------
  // Preflight: confirm CONTAINER_GROUP_INSTANCE is available
  // ------------------------------------------------------------------
  console.error("Checking entity type availability…");
  const hasCgi = await entityTypeExists("CONTAINER_GROUP_INSTANCE");
  if (!hasCgi) {
    console.error("  ✗ CONTAINER_GROUP_INSTANCE not found in this environment. Exiting.");
    process.exit(1);
  }
  console.error("  ✓ CONTAINER_GROUP_INSTANCE is available");
  if (NAMESPACE_FILTER) {
    console.error(`  ✦ Namespace filter active: "${NAMESPACE_FILTER}"`);
  }
  console.error();

  const EMPTY_HEADER = "displayName,entityId,clusterName,namespace,hasLimits,memoryBytes,memoryGiB,billingMemoryGiB";

  // ------------------------------------------------------------------
  // Step 1: Collect deep-monitored PGIs
  // ------------------------------------------------------------------
  console.error("=== Step 1: Deep-monitored PGIs ===\n");
  const states = await getAllMonitoringStates();
  console.error(`\nTotal PGI states fetched: ${states.length}`);

  const DEEP_MONITORING_STATES = new Set([
    "deep_monitoring_successful",
    "restart_required_outdated_agent_injected",
  ]);

  const deepPgiIds = states
    .filter((s) => DEEP_MONITORING_STATES.has(s.state))
    .map((s) => s.entityId);

  console.error(`Deep-monitored PGIs: ${deepPgiIds.length}\n`);

  if (deepPgiIds.length === 0) {
    console.error("No deep-monitored PGIs found. Exiting.");
    console.log(EMPTY_HEADER);
    return;
  }

  // ------------------------------------------------------------------
  // Step 2: PGI → CONTAINER_GROUP_INSTANCE (isPgiOfCgi)
  // ------------------------------------------------------------------
  console.error("=== Step 2: PGI → Container Group Instance ===\n");
  const pgiEntities = await getEntitiesById(deepPgiIds, "fromRelationships.isPgiOfCgi");

  const cgiIdSet = new Set();
  for (const pgi of pgiEntities) {
    for (const rel of pgi.fromRelationships?.isPgiOfCgi || []) {
      if (rel.id?.startsWith("CONTAINER_GROUP_INSTANCE-")) cgiIdSet.add(rel.id);
    }
  }

  const cgiIds = [...cgiIdSet];
  console.error(`Container Group Instances linked to deep-monitored PGIs: ${cgiIds.length}\n`);

  if (cgiIds.length === 0) {
    console.error("No Container Group Instances found for these PGIs.");
    console.error("These processes may not be running inside containers.");
    console.log(EMPTY_HEADER);
    return;
  }

  // ------------------------------------------------------------------
  // Step 3: CGI → CONTAINER_GROUP (isInstanceOf) + CAI (isCgiOfCai)
  // ------------------------------------------------------------------
  console.error("=== Step 3: Container Group Instance → Container Group & Pod ===\n");
  const cgiEntities = await getEntitiesById(
    cgiIds,
    "fromRelationships.isInstanceOf,fromRelationships.isCgiOfCai,fromRelationships.isCgiOfCa,fromRelationships.isCgiOfCluster,properties"
  );

  // CG ID → { displayName, caIds, clusterEntityIds }
  const cgMap = new Map();
  // CAI ID → CG ID
  const caiToCg = new Map();
  // CA ID → CG ID
  const caToCg = new Map();
  // CA ID → cluster entity ID (CA is cluster-specific)
  const caToCluster = new Map();
  // CAI ID → cluster entity ID (pod runs on one cluster)
  const caiToCluster = new Map();
  // CG ID → Map<clusterId, namespace string>
  const cgClusterNamespace = new Map();

  for (const cgi of cgiEntities) {
    const cgRels = cgi.fromRelationships?.isInstanceOf || [];
    const caiRels = cgi.fromRelationships?.isCgiOfCai || [];
    const caRels  = cgi.fromRelationships?.isCgiOfCa  || [];
    const clusterRels = cgi.fromRelationships?.isCgiOfCluster || [];
    const namespaceName = cgi.properties?.namespaceName;

    // Apply namespace filter if specified
    if (NAMESPACE_FILTER && namespaceName !== NAMESPACE_FILTER) continue;

    const clusterId = clusterRels.find((r) => r.id?.startsWith("KUBERNETES_CLUSTER-"))?.id ?? null;

    for (const cgRel of cgRels) {
      if (!cgRel.id?.startsWith("CONTAINER_GROUP-")) continue;
      const cgId = cgRel.id;

      if (!cgMap.has(cgId)) {
        cgMap.set(cgId, { displayName: cgId, caIds: new Set(), clusterEntityIds: new Set() });
        cgClusterNamespace.set(cgId, new Map());
      }

      const entry = cgMap.get(cgId);
      if (clusterId) {
        entry.clusterEntityIds.add(clusterId);
        if (namespaceName) cgClusterNamespace.get(cgId).set(clusterId, namespaceName);
      }

      for (const caiRel of caiRels) {
        if (caiRel.id?.startsWith("CLOUD_APPLICATION_INSTANCE-")) {
          caiToCg.set(caiRel.id, cgId);
          if (clusterId) caiToCluster.set(caiRel.id, clusterId);
        }
      }
      for (const caRel of caRels) {
        if (caRel.id?.startsWith("CLOUD_APPLICATION-")) {
          entry.caIds.add(caRel.id);
          caToCg.set(caRel.id, cgId);
          if (clusterId) caToCluster.set(caRel.id, clusterId);
        }
      }
    }
  }

  console.error(`Container Groups (workloads) found: ${cgMap.size}`);

  const allCaiIds = [...caiToCg.keys()];
  console.error(`Cloud Application Instances (pods) to fetch: ${allCaiIds.length}\n`);

  // ------------------------------------------------------------------
  // Step 4: Fetch pod memory limits/requests (CLOUD_APPLICATION_INSTANCE)
  // ------------------------------------------------------------------
  console.error("=== Step 4: Fetching pod memory limits/requests ===\n");

  // CG ID → Map<clusterId, { limitsBytes }>
  const cgClusterLimits = new Map();
  for (const cgId of cgMap.keys()) cgClusterLimits.set(cgId, new Map());

  if (allCaiIds.length > 0) {
    const caiEntities = await getEntitiesById(allCaiIds, "properties");

    for (const cai of caiEntities) {
      const cgId = caiToCg.get(cai.entityId);
      const clusterId = caiToCluster.get(cai.entityId);
      if (!cgId || !clusterId) continue;

      const limitsMemory = cai.properties?.limitsMemory;
      if (limitsMemory == null) continue;

      const clusterMap = cgClusterLimits.get(cgId);
      if (!clusterMap.has(clusterId)) clusterMap.set(clusterId, { limitsBytes: 0 });
      clusterMap.get(clusterId).limitsBytes += Number(limitsMemory);
    }
  }

  const cgIds = [...cgMap.keys()];
  const cgWithLimits = cgIds.filter((id) => [...cgClusterLimits.get(id).values()].some((e) => e.limitsBytes > 0));
  console.error(`\nContainer Groups with limits: ${cgWithLimits.length}`);
  console.error(`Container Groups without limits (will use utilization): ${cgIds.length - cgWithLimits.length}\n`);

  // ------------------------------------------------------------------
  // Step 5: Fetch working set for all CAs (per-CA, so per cluster/workload)
  // ------------------------------------------------------------------
  // caToWorkingSet: CA ID → bytes; queried for all CAs so per-(CG, cluster) rows
  // can use limits when set and working set when not, independently per cluster.
  const caToWorkingSet = new Map();

  const allCaIds = [...caToCg.keys()];
  if (allCaIds.length > 0) {
    console.error("=== Step 5: Fetching working set memory (kubelet eviction metric) ===\n");
    console.error(`Querying builtin:kubernetes.workload.memory_working_set for ${allCaIds.length} workloads…\n`);

    const caToBytes = await getCaWorkingSetMemory(allCaIds);
    console.error(`  Metric values received for ${caToBytes.size} workloads`);
    for (const [caId, bytes] of caToBytes) caToWorkingSet.set(caId, bytes);
  } else {
    console.error("=== Step 5: Skipped (no CLOUD_APPLICATION entities found) ===\n");
  }

  // ------------------------------------------------------------------
  // Step 6: Fetch Container Group display names
  // ------------------------------------------------------------------
  console.error("\n=== Step 6: Fetching Container Group display names ===\n");
  const cgEntities = await getEntitiesById(cgIds, "");

  for (const cg of cgEntities) {
    if (cgMap.has(cg.entityId)) {
      cgMap.get(cg.entityId).displayName = cg.displayName || cg.entityId;
    }
  }

  // ------------------------------------------------------------------
  // Step 7: Resolve KUBERNETES_CLUSTER entity IDs → display names
  // ------------------------------------------------------------------
  console.error("\n=== Step 7: Fetching Kubernetes Cluster display names ===\n");
  const allClusterIds = [...new Set([...cgMap.values()].flatMap((e) => [...e.clusterEntityIds]))];
  const clusterIdToName = new Map();

  if (allClusterIds.length > 0) {
    const clusterEntities = await getEntitiesById(allClusterIds, "");
    for (const cl of clusterEntities) {
      clusterIdToName.set(cl.entityId, cl.displayName || cl.entityId);
    }
  }
  console.error(`Kubernetes Clusters resolved: ${clusterIdToName.size}`);

  // ------------------------------------------------------------------
  // Build CSV
  // ------------------------------------------------------------------
  const header = "displayName,entityId,clusterName,namespace,hasLimits,memoryBytes,memoryGiB,billingMemoryGiB";

  const rows = [];
  for (const cgId of cgIds) {
    const { displayName, caIds } = cgMap.get(cgId);

    // Group this CG's CAs by cluster — each CA is cluster-specific
    const clusterToCaIds = new Map();
    for (const caId of caIds) {
      const clusterId = caToCluster.get(caId);
      if (clusterId) {
        if (!clusterToCaIds.has(clusterId)) clusterToCaIds.set(clusterId, []);
        clusterToCaIds.get(clusterId).push(caId);
      }
    }

    // No K8s workload entity (e.g. bare container) — emit one row with no cluster/memory
    if (clusterToCaIds.size === 0) {
      rows.push([csvEscape(displayName), csvEscape(cgId), "", "", "", "", "", ""].join(","));
      continue;
    }

    for (const [clusterId, clusterCaIds] of [...clusterToCaIds].sort()) {
      const clusterName = clusterIdToName.get(clusterId) || clusterId;
      const namespace = cgClusterNamespace.get(cgId)?.get(clusterId) || "";

      const limitsBytes = cgClusterLimits.get(cgId)?.get(clusterId)?.limitsBytes ?? 0;
      const hasLimits = limitsBytes > 0;

      const workingSetBytes = clusterCaIds.reduce((sum, caId) => {
        const v = caToWorkingSet.get(caId);
        return v != null ? sum + v : sum;
      }, 0);

      // Coalesce: limits when set for this cluster, working set otherwise
      const memoryBytes = hasLimits
        ? limitsBytes
        : (workingSetBytes > 0 ? Math.round(workingSetBytes) : null);

      rows.push([
        csvEscape(displayName),
        csvEscape(cgId),
        csvEscape(clusterName),
        csvEscape(namespace),
        hasLimits,
        memoryBytes ?? "",
        memoryBytes != null ? toGiB(memoryBytes) : "",
        memoryBytes != null ? toBillingGiB(memoryBytes) : "",
      ].join(","));
    }
  }

  rows.sort();

  const csv = [header, ...rows].join("\n");

  const fs = require("fs");
  const outFile = process.env.DT_OUTPUT_FILE || "container-groups.csv";
  fs.writeFileSync(outFile, csv + "\n", "utf-8");
  console.error(`\nDone — ${rows.length} container groups written to ${outFile}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
