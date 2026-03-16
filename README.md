# dynatrace-instrumented-hosts-report

# dynatrace-host-memory-report

A Node.js script that identifies Dynatrace-monitored hosts with deep (code-level) instrumentation or backing a Kubernetes node, fetches their memory footprint, and outputs a CSV report.

## Why

When scoping a Dynatrace environment — for licensing, capacity planning, or migration — you often need a clear list of hosts that are actively instrumented along with their memory. This script automates that by querying two sources and merging the results into a single report.

## Prerequisites

- **Node.js 18+** (uses built-in `fetch`)
- A Dynatrace **API token** with the `entities.read` (`ReadEntities`) scope

## Usage

```bash
export DT_ENV_URL=https://your-environment-id.live.dynatrace.com
export DT_API_TOKEN=dt0c01.XXXXXXXX

node get-deep-monitored-hosts.js
```

This writes a `hosts.csv` file in the current directory.

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DT_ENV_URL` | Yes | — | Dynatrace environment URL (e.g. `https://abc12345.live.dynatrace.com`) |
| `DT_API_TOKEN` | Yes | — | API token with `entities.read` scope |
| `DT_FROM` | No | `now-2h` | Start of the query timeframe |
| `DT_TO` | No | `now` | End of the query timeframe |
| `DT_PAGE_SIZE` | No | `500` | Page size for paginated API calls (max 500) |
| `DT_CONCURRENCY` | No | `5` | Max parallel API requests |
| `DT_REQ_DELAY_MS` | No | `200` | Delay in ms between request batches |
| `DT_OUTPUT_FILE` | No | `hosts.csv` | Output file path |

## How it works

The script collects hosts from two sources and merges them into a deduplicated list:

**Source 1 — Deep-monitored processes:** Queries `/api/v2/monitoringstate` for all process group instances, filters for those with active code injection, then resolves each process to its host via the `isProcessOf` relationship.

**Source 2 — Kubernetes nodes:** Queries `/api/v2/entities` for all `KUBERNETES_NODE` entities, then resolves each node to its underlying host via the `isNodeOfHost` relationship.

After building the combined host list, the script fetches each host's entity detail from `/api/v2/entities/{entityId}` and extracts `system.memory.size` from the `additionalSystemInfo` property.

## Recognized monitoring states

The script considers a process group instance to be deep-monitored if its `state` field is one of:

| State | Meaning |
|---|---|
| `deep_monitoring_successful` | Agent injected and working |
| `restart_required_outdated_agent_injected` | Agent injected but the process needs a restart |

To add more states, edit the `DEEP_MONITORING_STATES` set in the script.

## Output

The output is a CSV file with the following columns:

| Column | Description |
|---|---|
| `displayName` | Host display name in Dynatrace |
| `entityId` | Dynatrace entity ID (e.g. `HOST-ABC123`) |
| `sources` | How the host was found: `deep_monitored_pgi`, `kubernetes_node`, or both (semicolon-separated) |
| `memoryBytes` | Total system memory in bytes |
| `memoryGiB` | Total system memory in GiB (rounded to 2 decimal places) |

Example:

```csv
displayName,entityId,sources,memoryBytes,memoryGiB
app-server-01,HOST-ABC123,deep_monitored_pgi,33647964160,31.34
k8s-worker-02,HOST-DEF456,deep_monitored_pgi;kubernetes_node,67295928320,62.67
k8s-worker-03,HOST-GHI789,kubernetes_node,16773996544,15.63
```

## Rate limiting

Dynatrace environments have a limited thread pool for request processing and will return `429` when overloaded. The script handles this in three ways:

1. **Bounded concurrency** — only `DT_CONCURRENCY` requests run in parallel (default 5)
2. **Batch delay** — a `DT_REQ_DELAY_MS` pause between each batch (default 200ms)
3. **429 retry** — if the API returns 429, the script reads the `Retry-After` header, waits, and retries once

If you're still hitting rate limits, lower concurrency and increase the delay:

```bash
DT_CONCURRENCY=2 DT_REQ_DELAY_MS=500 node get-deep-monitored-hosts.js
```

This script was built with the assistance of Claude by Anthropic.

## License

MIT
