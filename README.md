# context-trimmer

> Lossless context trimming for long-running AI coding agents: archive large tool results, then replace the stale or superseded ones with compact, recallable pointers.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)

**context-trimmer** keeps an agent's working context small without losing
information. Rather than lossy summarization, it archives every large tool
result verbatim, replaces the ones that are stale or superseded with a one-line
pointer, and exposes a `recall_result` tool so the agent can pull the original
back on demand.

The repository ships two reference implementations of the same design: a
**TypeScript** extension for the Pi coding agent (`src/`) and a **Go** extension
for the PiG coding agent (`pig/`). Both share the same archive schema, eviction
signals, thresholds, and per-tool policies.

## Table of Contents

- [Why](#why)
- [Features](#features)
- [How it works](#how-it-works)
- [Implementations](#implementations)
- [Getting started](#getting-started)
- [Configuration and tuning](#configuration-and-tuning)
- [Data schema](#data-schema)
- [Benchmark](#benchmark)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

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

## Features

- **Verbatim archiving** — every supported tool result is stored whole; nothing
  is summarized away.
- **Staleness detection** — file-backed results (`read`) are re-hashed against
  disk; command-like results (`bash`/`grep`/`find`/`ls`) are treated as
  immutable and assumed stale.
- **Supersession** — a newer read of the same file range, or a newer run of the
  same command/search, supersedes the older result.
- **Principled eviction** — proven-dead content evicts freely; still-valid
  content is only trimmed under genuine context pressure and above a weighted
  score threshold.
- **KV-cache discipline** — removals are batched and append-only, and the most
  recently archived result is always protected.
- **On-demand recall** — a `recall_result` tool returns the original content,
  wrapping it when the source has since gone stale.
- **Retroactive backfill** — loaded into a session that predates it, it archives
  the old tool results it never saw (pairing each with its tool call's
  arguments), so the session is trimmed as if the extension had been active from
  the start. Backfilled archives are derived and cached, never re-hashed per turn.
- **Two host implementations** — TypeScript and Go, with identical behavior.

### Supported tools

| Tool | Archive key | Staleness | Supersession |
|---|---|---|---|
| `read` | file path | re-hash archived lines on disk | line-range overlap |
| `bash` | command | immutable (assumed stale) | exact key |
| `grep` | `pattern\|path\|glob\|ignoreCase\|literal\|context` | immutable | exact key |
| `find` | `pattern\|path` | immutable | exact key |
| `ls` | path | immutable | exact key |

## How it works

### 1. Archive (`tool_result`)

For every supported, successful tool result:

1. A per-tool policy decides what content to archive and how to identify the
   invocation.
2. For `read`, the actual file content is recovered: prefer
   `details.truncation.content` when the host provides it, otherwise strip the
   read-tool continuation footer (for example
   `[7 more lines in file. Use offset=8 to continue.]`). If the read was
   truncated to a single oversized line, no file content was returned and
   nothing is archived.
3. The content is split on `"\n"` and every line is SHA-256 hashed.
4. An archive record is appended to the session as a custom
   `results-archive` entry.

The fresh result stays verbatim in the turn it lands, so the model can use it
immediately.

### 2. Evict (`context`)

Before each model call, the extension scans the compiled `toolResult` messages
for archived results. Each archived result receives a single normalized
**eviction score** in `[0, 1]` — a weighted sum of signals, where each weight is
that signal's *share* of the total (the weights sum to 1):

- **Supersession** — a newer result of the same tool/parameter group covers this
  one (line-range for `read`, exact-key for `bash`/`grep`/`find`/`ls`).
- **Staleness** — confidence-weighted: a `read` whose file changed on disk is
  *proven* stale (1.0); immutable tools can only be *assumed* stale (discounted).
- **Pressure** — rises as the compiled context crosses a percent or absolute
  token knee; shared by every candidate that turn.
- **Coldness** and **Size** — older, larger archives are more disposable.
- **Semantic** — per-tool disposability (reads are the most valuable to keep).
- **Affordability** — the KV-cache counterweight: content whose removal
  invalidates a long suffix scores *lower* (expensive to evict). Its
  **co-location bump** sets affordability to 1 for anything already inside a
  suffix we are invalidating anyway.

Two rules gate what the score is allowed to do:

- **Proven-dead content evicts freely**, independent of pressure: a fully
  superseded archive or a proven-stale read is wrong to keep *and* dumb-zone
  ballast, so it goes.
- **Still-valid content is capped**: it is only trimmed once there is genuine
  pressure *and* its score clears the threshold, so good content is never thrown
  away early.

Removals are **batched**: held until they would free at least `minBatchTokens`
(or the overflow guard trips), so eviction is a few large, amortized KV-cache
invalidations rather than a trickle. Eviction is **append-only** — once a pointer
replaces a result it stays replaced — and the **most recently archived result is
always protected**, so a fresh result is usable verbatim on the turn it lands.

### 3. Recall (`recall_result`)

The model can call `recall_result` with a `pointer_id`:

- **Active** — returns the original content verbatim.
- **Stale** — returns the original content wrapped in XML:

```xml
<recalled-stale-content>
[Warning: Pointer ptr_xxx was invalidated. Raw content is shown below verbatim]

{original content here}

</recalled-stale-content>
```

## Implementations

| | TypeScript | Go |
|---|---|---|
| Directory | `src/` | `pig/` |
| Host | Pi | PiG |
| Runtime | Node-compatible extension | PiG-native subprocess extension |
| Tests | `bun test` | `go test ./...` |

The Go implementation is a from-scratch port, not a compatibility shim. It keeps
the same archive schema, eviction signals, thresholds, and per-tool policies,
adapting only the host integration (state rebuild, context mutation, and
concurrency).

## Getting started

### TypeScript (Pi)

```bash
bun install
bun test

# Load it directly:
cp src/index.ts ~/.pi/agent/extensions/context-trimmer.ts

# Or reference it in ~/.pi/agent/settings.json:
# { "extensions": ["/path/to/context-trimmer/src/index.ts"] }
```

### Go (PiG)

```bash
cd pig
go build ./...
go test ./...                              # behavior tests, no model required
pig install ./pig --validate-only --json   # run from the repo root
```

Load it directly, or through the included Piglet:

```bash
pig -e ./pig --model <model> -- "Read /path/to/file, then read it again."
pig --piglet ./piglet.yaml
```

The behavior tests in `pig/behavior_test.go` drive the real handlers and the
`recall_result` tool over PiG's subprocess protocol with a fake host
(`pig/internal/hosttest`), so they need no model and no live session.

## Configuration and tuning

By default the trimmer **tunes itself to the active model** at runtime, so there
is nothing to set per session:

- It reads the model's input and cache-read prices from the host
  (`GetModelInfo` / `ctx.model.cost`) and its context window.
- Still-valid content is evicted only when the cache-read savings over a 50-turn
  horizon beat the one-time cost of re-sending the invalidated suffix:
  `freed · H > (1 − affordability) · compiled · (input/cacheRead − 1)`.
- This self-separates: conservative where cached reads are cheap (a 50× input
  ratio), aggressive where they are not (a 10× ratio), with no per-model
  threshold. If the host reports no prices, it falls back to the conservative
  proven-dead-only policy.

Proven-dead content (stale or superseded) always evicts. The weights, pressure
knees, and per-tool semantics remain available as the tunable surface and are
used only by the fixed-threshold fallback:

- TypeScript: `DEFAULT_EVICTION_CONFIG` in `src/eviction.ts`.
- Go: `DefaultEvictionConfig()` in `pig/eviction.go`.

## Data schema

Archives are stored as custom session entries of type `"results-archive"`:

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

A public-trace benchmark harness lives under `benchmark/` (TypeScript). It
replays agent trajectories through the trimmer's eviction logic and compares the
algorithm against baselines using real model prices from
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
  infeasible (those turns force compaction or request failure).
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

## Repository layout

```text
src/          TypeScript implementation (Pi)
pig/          Go implementation (PiG)
benchmark/    Public-trace benchmark harness (TypeScript)
docs/         Design and porting notes
test/         TypeScript tests
piglet.yaml   PiG Piglet that activates the Go extension
```

## Development

TypeScript:

```bash
bun install
bun test
bun run check
bun run fix
```

Go (toolchain via devenv):

```bash
cd pig
gofmt -l .
go vet ./...
go test ./...
```

## Limitations

- Only text content is hashed and tracked.
- Footer stripping relies on the read-tool footer formats used by the host
  today.
- Non-`read` tools are treated as immutable/stale on recall: their output is not
  re-executed to verify freshness.

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run the
checks for the implementation you touched:

```bash
bun test && bun run check    # TypeScript
cd pig && gofmt -l . && go vet ./... && go test ./...   # Go
```

Keep the two implementations behaviorally identical; the Go behavior tests are
the reference for parity.

## License

Released under the [MIT License](LICENSE).
