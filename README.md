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

The goal is **context engineering**: keep the working context as small as
possible so a long agent session stays sharp and survives.

- **The "dumb zone"**: large contexts measurably degrade model quality, so a
  leaner context is strictly better — not only near the window, continuously.
- **Restorable (lossless) compression**: an archived observation can be dropped
  from context as long as a pointer remains, because the content is recoverable
  on demand. This is the [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
  "use the file system as context" principle — strictly better than lossy
  summarization/compaction.
- **KV-cache discipline**: the agent re-sends the whole context every turn, so a
  stable prefix is served from cache (~10× cheaper). Replacing a message edits
  the middle of the context and invalidates the cache from that point on, so
  trimming is never free and must be done in rare, decisive batches — never a
  little every turn.

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
Each archived result gets a single normalized **eviction score** in `[0, 1]` — a
weighted sum of signals, where each weight is that signal's *share* of the total
(the weights sum to 1). The signals:

- **Supersession** — a newer result of the same tool/parameter group covers this
  one (line-range for `read`, exact-key for `bash`/`grep`/`find`/`ls`)
- **Staleness** — confidence-weighted: a `read` whose file changed on disk is
  *proven* stale (1.0); immutable tools can only be *assumed* stale (discounted)
- **Pressure** — rises as the compiled context crosses a percent / absolute-token
  knee; shared by every candidate that turn
- **Coldness** and **Size** — older, larger archives are more disposable ballast
- **Semantic** — per-tool disposability (reads are the most valuable to keep)
- **Affordability** — the KV-cache counterweight: content whose removal
  invalidates a long suffix scores *lower* (expensive to evict). Its
  **co-location bump** sets affordability to 1 for anything already inside a
  suffix we're invalidating anyway.

Two rules gate what the score is allowed to do:

- **Proven-dead content evicts freely**, independent of pressure: a fully
  superseded archive or a proven-stale read is wrong-to-keep *and* dumb-zone
  ballast, so it goes.
- **Still-valid content is capped**: it is only trimmed once there is genuine
  pressure *and* its score clears the threshold — so good content is never
  thrown away early.

Removals are **batched**: held until they would free at least `minBatchTokens`
(or the overflow guard trips), so eviction is a few large, amortized KV-cache
invalidations rather than a trickle. Eviction is **append-only** — once a pointer
replaces a result it stays replaced — and the **most recently archived result is
always protected** so a fresh result is usable verbatim on the turn it lands.

The aggressiveness knobs (threshold, pressure knees, batch size) are set by
principle; the signal weights and per-tool semantics are tuned by
`benchmark/optimize.ts`. The same `selectEvictionCandidates` runs in production
and in every test — there is no test-only parameterization.

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
# Run against public Toolathlon traces (default 200k window)
bun run benchmark

# Sweep context windows to see pressure-based eviction kick in
bun run benchmark -- --context-window 32000,64000,128000,200000

# Tune sample size / recall rate
bun run benchmark -- --max-toolathlon 20 --recall-rate 0.02
```

The harness (Toolathlon traces only — the only public traces long enough to
exercise eviction) measures:

- **Mean context usage** — average compiled context as a share of the window;
  the dumb-zone cost we minimize.
- **Window overflow tokens** — a hard constraint: any config that overflows is
  infeasible (those turns force compaction / request failure).
- **Invalidation events** — turns on which a new mid-context replacement rewrote
  the KV-cache suffix; the anti-thrash metric (few, large batches = low).
- **Real dollar cost** — cache-aware per-turn spend plus a parameterized recall
  estimate, for each opencode-go SOTA model price card.

Two findings, reported honestly:

1. **A replay of traces generated *without* trimming cannot measure the cost of
   over-trimming** — the re-reads our trimming would force never happened in the
   source run. So the aggressiveness is set by principle (dead content free,
   valid content capped under pressure), not fit to the benchmark, which would
   otherwise collapse the context to near-empty.
2. **The value lives in the structure, not fitted weights.** With aggressiveness
   fixed, the weight optimizer overfits the train split and does **not** beat the
   principled defaults on held-out traces — so we ship the principled config.
   Production keeps every Toolathlon turn inside the window (0 overflow) with
   ~0.6 invalidation events per trace (no thrash).

## Limitations

- Only text content is hashed and tracked
- Footer stripping relies on the read-tool footer formats used by pi today
- Non-`read` tools are treated as immutable/stale on recall (their output is not re-executed to verify freshness)
