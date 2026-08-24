# dynatrace-instrumented-hosts-report

Node.js scripts for scoping Dynatrace-monitored environments — identifying what is instrumented and how much memory it consumes. Useful for licensing, capacity planning, and migration sizing.

## Scripts

| Script | Report unit | Memory source | Use case |
|---|---|---|---|
| `hosts-deep-monitoring.js` | Host | System RAM (`system.memory.size`) | Full-stack host scoping |
| `container-group-memory-report.js` | Kubernetes workload (Container Group) | Limits (if set) or working set utilization | App-only K8s deployment scoping |

---

## hosts-deep-monitoring.js

Identifies hosts that are actively instrumented with deep (code-level) monitoring or that back a Kubernetes node, and reports their total system memory.

### How it works

Collects hosts from two sources and merges them into a deduplicated list:

**Source 1 — Deep-monitored processes:** Queries `/api/v2/monitoringstate` for all process group instances, filters for those with active code injection, then resolves each to its host via the `isProcessOf` relationship.

**Source 2 — Kubernetes nodes:** Queries `/api/v2/entities` for all `KUBERNETES_NODE` entities and resolves each to its underlying host via the `isNodeOfHost` relationship.

After building the host list, the script fetches each host's entity detail and extracts `system.memory.size` from the `additionalSystemInfo` property.

### Prerequisites

- **Node.js 18+** (uses built-in `fetch`)
- API token with `entities.read` scope

### Usage

```bash
export DT_ENV_URL=https://your-environment-id.live.dynatrace.com
export DT_API_TOKEN=dt0c01.XXXXXXXX

node hosts-deep-monitoring.js
```

### Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DT_ENV_URL` | Yes | — | Dynatrace environment URL |
| `DT_API_TOKEN` | Yes | — | API token with `entities.read` scope |
| `DT_FROM` | No | `now-2h` | Start of the query timeframe |
| `DT_TO` | No | `now` | End of the query timeframe |
| `DT_PAGE_SIZE` | No | `500` | Page size for paginated API calls (max 500) |
| `DT_CONCURRENCY` | No | `5` | Max parallel API requests |
| `DT_REQ_DELAY_MS` | No | `200` | Delay in ms between request batches |
| `DT_OUTPUT_FILE` | No | `hosts.csv` | Output file path |

### Output

```csv
displayName,entityId,sources,memoryBytes,memoryGiB
app-server-01,HOST-ABC123,deep_monitored_pgi,33647964160,31.34
k8s-worker-02,HOST-DEF456,deep_monitored_pgi;kubernetes_node,67295928320,62.67
k8s-worker-03,HOST-GHI789,kubernetes_node,16773996544,15.63
```

| Column | Description |
|---|---|
| `displayName` | Host display name in Dynatrace |
| `entityId` | Dynatrace entity ID (`HOST-xxx`) |
| `sources` | How the host was found: `deep_monitored_pgi`, `kubernetes_node`, or both (semicolon-separated) |
| `memoryBytes` | Total system memory in bytes |
| `memoryGiB` | Total system memory in GiB (2 decimal places) |

### Recognized monitoring states

| State | Meaning |
|---|---|
| `deep_monitoring_successful` | Agent injected and working |
| `restart_required_outdated_agent_injected` | Agent injected but process needs a restart |

To add more states, edit the `DEEP_MONITORING_STATES` set in the script.

---

## container-group-memory-report.js

Reports the memory footprint of Kubernetes workloads (Container Groups) that have deep-monitored processes running inside them. Designed for scoping **app-only deployments** where there is no full-stack host agent.

### How it works

Resolves deep-monitored PGIs through the container entity graph to the Container Group (workload) level:

```
Deep-monitored PGI
  → CONTAINER_GROUP_INSTANCE  via isPgiOfCgi
    → CONTAINER_GROUP          via isInstanceOf    (reporting unit)
    → CLOUD_APPLICATION_INSTANCE via isCgiOfCai   (memory limits source)
    → CLOUD_APPLICATION        via isCgiOfCa      (working set metric entity)
```

**Memory strategy per workload:**

- `hasLimits=true` — uses `limitsMemory` from the Kubernetes pod spec (via `CLOUD_APPLICATION_INSTANCE` properties)
- `hasLimits=false` — falls back to `builtin:kubernetes.workload.memory_working_set` (RSS minus file cache — the same metric Kubernetes uses for pod eviction decisions)

At startup the script verifies that `CONTAINER_GROUP_INSTANCE` exists as an entity type in the target environment and exits early if not.

### Prerequisites

- **Node.js 18+** (uses built-in `fetch`)
- API token with:
  - `entities.read` scope — always required
  - `metrics.read` scope — required for the working set fallback; without it, workloads without limits will have empty memory columns

### Usage

```bash
export DT_ENV_URL=https://your-environment-id.live.dynatrace.com
export DT_API_TOKEN=dt0c01.XXXXXXXX

node container-group-memory-report.js
```

### Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DT_ENV_URL` | Yes | — | Dynatrace environment URL |
| `DT_API_TOKEN` | Yes | — | API token with `entities.read` and `metrics.read` scopes |
| `DT_FROM` | No | `now-2h` | Start of the query timeframe |
| `DT_TO` | No | `now` | End of the query timeframe |
| `DT_PAGE_SIZE` | No | `500` | Page size for paginated API calls (max 500) |
| `DT_CONCURRENCY` | No | `5` | Max parallel API requests |
| `DT_REQ_DELAY_MS` | No | `200` | Delay in ms between request batches |
| `DT_OUTPUT_FILE` | No | `container-groups.csv` | Output file path |
| `DT_NAMESPACE` | No | — | Filter results to a single Kubernetes namespace |

A namespace filter can also be passed as a CLI flag, which takes precedence over the env var:

```bash
node container-group-memory-report.js --ns unguard
```

> **Note:** The initial PGI sweep always runs across the full environment (namespace is not a PGI concept), but all entity and metric queries downstream are scoped to the requested namespace, making it significantly faster in large environments.

### Output

```csv
displayName,entityId,clusterName,namespace,hasLimits,memoryBytes,memoryGiB
dynatrace-operator-*,CONTAINER_GROUP-9FB31EC,dynakube,dynatrace,true,134217728,0.13
unguard-frontend-*,CONTAINER_GROUP-188BAEB,eks-demo-ap-southeast-2,unguard,false,2638745231,2.46
```

| Column | Description |
|---|---|
| `displayName` | Container Group name (base pod name pattern, e.g. `my-app-*`) |
| `entityId` | Dynatrace entity ID (`CONTAINER_GROUP-xxx`) |
| `clusterName` | Kubernetes cluster name(s), semicolon-separated if the workload spans multiple clusters |
| `namespace` | Kubernetes namespace(s), semicolon-separated if multiple |
| `hasLimits` | `true` if K8s memory limits are set in the pod spec; `false` if using utilization fallback |
| `memoryBytes` | Memory limit (bytes) when `hasLimits=true`; working set utilization (bytes) when `hasLimits=false` |
| `memoryGiB` | Same value in GiB (2 decimal places) |

---

## Rate limiting

Both scripts apply the same rate-limit strategy:

1. **Bounded concurrency** — only `DT_CONCURRENCY` requests run in parallel (default 5)
2. **Batch delay** — a `DT_REQ_DELAY_MS` pause between each batch (default 200ms)
3. **429 retry** — on a 429 response the script reads the `Retry-After` header, waits, and retries once

If you're still hitting rate limits, lower concurrency and increase the delay:

```bash
DT_CONCURRENCY=2 DT_REQ_DELAY_MS=500 node hosts-deep-monitoring.js
```

These scripts were built with the assistance of Claude by Anthropic.

## License

MIT
