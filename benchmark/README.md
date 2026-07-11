# Context Trimmer Benchmark

Stress-tests the `pi-context-trimmer` eviction algorithm against long public
agent trajectories and compares it against simple baselines using real prices
from [models.dev](https://models.dev) (opencode-go provider).

## Data source (public only)

- `hkust-nlp/Toolathlon-Trajectories` (Hugging Face): long-horizon agent traces
  from Claude 4.5 Opus runs. These are the only public traces long enough — some
  exceed 2M characters (~500k+ tokens) — to actually cross a 200k context window
  and exercise the eviction logic. Shorter datasets (SWE-agent ~32% peak,
  oni-devops ~1%) never approach the window, so they were dropped: replaying them
  only confirms the trimmer correctly does nothing.

Traces are cached under `.benchmark-cache/` after the first run.

## Run

```bash
bun run benchmark
bun run benchmark -- --context-window 32000,64000,128000,200000
bun run benchmark -- --max-toolathlon 20 --recall-rate 0.02
```

## What the benchmark can and cannot measure

For every turn of every trace we archive the tool result, build the compiled
message list, run the eviction algorithm (`production` calls the exact
`selectEvictionCandidates` from `src/eviction.ts`), and measure:

- **Mean context usage** — average compiled context as a share of the window.
  Lower is better (the "dumb zone": large contexts degrade model quality).
- **Window overflow tokens** — a **hard constraint**. Tokens over the window
  force compaction or a request failure in a live agent, so any config that
  overflows is infeasible regardless of its other numbers.
- **Invalidation events** — turns on which a *new* mid-context replacement
  rewrote the KV-cache suffix. This is the anti-thrash metric: the batched design
  frees many archives across few events; a naive per-turn policy re-invalidates
  constantly.
- **Real dollar cost** — cache-aware: each turn's cache-read and cache-write
  tokens (a mid-context edit makes the whole suffix a cache-write) plus a
  **parameterized** recall estimate (`--recall-rate`, default ~0.02, since the
  pointer is a rarely-used safety net, not an expected access).

**The honest ceiling:** these traces were generated *without* trimming, so the
agent never had to re-fetch anything — every observation stayed in context the
whole run. The re-reads our trimming *would* force are therefore invisible, and a
pure "minimize context" objective would collapse the context to near-empty. Local
or private traces have the identical problem (also generated without our
trimmer). So the benchmark honestly measures overflow, thrash, and context size —
but **not** the cost of over-trimming.

## Consequences encoded in the design

- **Aggressiveness is set by principle, not fit to the benchmark.** Provably-dead
  content (fully superseded / proven-stale reads) evicts freely; still-valid
  content is only trimmed under genuine pressure. See `DEFAULT_EVICTION_CONFIG`.
- **Staleness is synthesized from the trace.** A `read` is marked stale only when
  a later `filesystem-write_file`/`edit_file` touches the same path — so the
  staleness signal actually varies, instead of the degenerate "everything is
  stale" you get from re-hashing files that don't exist in a temp dir.
- **A re-reference (premature-recall) penalty** charges the objective when we
  evict a read whose file the trace's own agent reads again later — a partial,
  data-driven proxy for information loss.

## Algorithms compared

- `no-replacement`: keep every raw tool result (baseline).
- `oldest-first-30`: replace oldest archives until 30% of archive chars are freed.
- `optimized-cache-aware`: a marginal-cost model kept for comparison. It looks
  cheap on dollars only because it trims aggressively — but it **overflows the
  window** and thrashes the cache, i.e. it optimizes dollars by abandoning the
  actual goal.
- `production`: the shipped policy from `src/eviction.ts`.

## `optimize.ts`

`bun run benchmark/optimize.ts` runs coordinate descent over the *honestly
learnable* parameters (the signal weight shares, per-tool semantics) with
aggressiveness fixed by principle, on a deterministic train/holdout split. It
minimizes mean context usage + a cache-miss term + a recall term, with overflow
as a hard constraint. It ends with an **overfitting guard**: it only recommends
the learned weights if they beat the principled defaults out-of-sample — which,
with the over-trim exploit closed, they do not. The value is in the structure,
not fitted weights.

## Output

A metrics table and a dollar-cost table are printed per context window. A JSON
report is written to `.benchmark-cache/benchmark-report.json`.
