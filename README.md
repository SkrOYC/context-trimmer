# Pi Context Trimmer

A Pi extension that archives large tool results and replaces them with compact virtual pointers when they become stale or redundant, reducing context bloat while preserving the ability to recall original content on demand.

## What It Does

For every supported tool result, this extension:

1. **Archives** the result as a custom `results-archive` entry in the session JSONL
2. **Computes SHA-256 hashes** for each line that was actually returned
3. **Leaves the raw result in the current turn** so the model can use it immediately
4. On later turns, replaces archived content in context with a compact pointer when it is **stale or superseded**
5. Exposes a `recall_result` tool so the model can retrieve archived content later

### Supported tools

- **`read`**: full line-hash staleness checks + line-range supersession (newer reads of the same file can cover older reads)
- **`bash`**: archived by exact command; newer runs of the same command supersede older ones; treated as immutable/stale on recall
- **`grep`**: archived by `pattern|path|glob|ignoreCase|literal|context`; newer identical searches supersede older ones; immutable on recall
- **`find`**: archived by `pattern|path`; newer identical searches supersede older ones; immutable on recall
- **`ls`**: archived by `path`; newer listings of the same directory supersede older ones; immutable on recall

## Why

- **Context bloat**: Large file reads accumulate across long sessions
- **Stale data**: A file read from 20 turns ago may no longer reflect disk state
- **Recall on demand**: The model can explicitly ask for archived content when needed

## How It Works

### 1. Tool result interception (`tool_result` event)

For every supported tool result:

- The extension uses a per-tool policy to determine what content to archive and how to identify it.
- For `read` results it determines the actual file content returned:
  - Prefer `details.truncation.content` when the read tool provides it
  - Otherwise strip the read-tool continuation footer from the raw text (e.g. `[7 more lines in file. Use offset=8 to continue.]`)
  - If `details.truncation.firstLineExceedsLimit` is true, no actual file content was returned, so nothing is archived
- It splits the content on `"\n"` (matching pi's read tool) and hashes each line
- It stores an archive record with:
  - `pointerId`: the virtual pointer ID
  - `toolName`, `toolCallId`: identifying metadata
  - `parameterKey`: the resolved identifier for the tool invocation (e.g. file path, command string, search query)
  - `stalenessStrategy`: how staleness is determined (`file-lines` or `immutable`)
  - `supersessionStrategy`: how newer results can replace older ones (`line-range`, `exact-key`, or `none`)
  - `startLine`: the 1-indexed offset from the read input
  - `lineHashes`: SHA-256 hashes of each returned line
  - `originalContent`: the original tool result content (preserved verbatim for recall)

### 2. Context compilation (`context` event)

Before each LLM call, the extension scans `toolResult` messages for archived results:

- It groups archives by tool and parameter key
- For `read` archives it reads the current file from disk and re-hashes the same line range
- It computes an eviction score for each archive from:
  - **Staleness** (line-hash mismatch for `read`, always true for immutable tools)
  - **Supersession coverage** (line-range for `read`, exact-key for `bash`/`grep`/`find`/`ls`)
  - **Context pressure** (higher usage → higher score)
  - **Recency** (recent messages → cheaper KV-cache cost → higher score)
  - **Co-invalidation boost** (archives after the first replacement in a turn get a bump because the suffix is already being recomputed)
- **If the score is below the threshold**: the raw content stays in context
- **If the score crosses the threshold**: the content is replaced with `[Results Archive: ptr_xxx (Invalidated - Stale)]`

### 3. On-demand recall (`recall_result` tool)

The model can call `recall_result` with a `pointer_id`:

- **Active**: returns the original content as-is
- **Stale**: returns the original content wrapped in XML:

```xml
<recalled-stale-content>
[Warning: Pointer ptr_xxx was invalidated. Raw content is shown below verbatim]

{original content here}

</recalled-stale-content>
```

## Installation

Install as a pi package or load directly:

```bash
# Auto-discovery: place in ~/.pi/agent/extensions/
cp src/index.ts ~/.pi/agent/extensions/pi-context-trimmer.ts

# Or load explicitly in ~/.pi/agent/settings.json
{
  "extensions": ["/path/to/pi-context-trimmer/src/index.ts"]
}
```

## Development

```bash
bun install
bun test
```

## Data Schema

Custom session entries of type `"results-archive"`:

```typescript
interface ArchivedResult {
  pointerId: string;
  toolName: string;
  toolCallId: string;
  parameterKey: string;      // resolved identifier (path, command, query, etc.)
  stalenessStrategy?: "file-lines" | "immutable";
  supersessionStrategy?: "line-range" | "exact-key" | "none";
  timestamp: number;
  originalContent: string;   // JSON-stringified content array (verbatim tool result)
  startLine: number;         // 1-indexed offset of first returned line
  lineHashes: string[];      // SHA-256 hashes of each returned line
}
```

## Benchmark

A public-trace benchmark harness is included under `benchmark/`. It replays
agent trajectories through the trimmer's eviction logic and compares the
current algorithm against baselines using real model prices from
[models.dev](https://models.dev) (opencode-go provider).

```bash
# Run against public SWE-agent and oni-devops traces (default 200k window)
bun run benchmark

# Sweep context windows to see pressure-based eviction kick in
bun run benchmark -- --context-window 32000,64000,128000,200000

# Tune sample size
bun run benchmark -- --max-swe 100 --context-window 200000
```

The harness measures:

- **Compression ratio** — archive chars replaced / total archive chars
- **KV-cache invalidation cost** — messages from the first replacement to the end of context
- **Recall cost** — estimated `recall_result` calls needed for replaced archives
- **Real dollar cost** — per-trace input/context spend plus recall output spend
  for each opencode-go SOTA model price card

Because public SWE-agent trajectories peak around ~15k tokens, the default
200k window mainly exercises supersession; smaller windows act as stress tests
for pressure-based eviction.

## Limitations

- Only text content is hashed and tracked
- Footer stripping relies on the read-tool footer formats used by pi today
- Non-`read` tools are treated as immutable/stale on recall (their output is not re-executed to verify freshness)
