# Context Trimmer Benchmark

Stress-tests the `pi-context-trimmer` eviction algorithm against public agent
trajectories and compares its cost against simple baselines using real prices
from [models.dev](https://models.dev) (opencode-go provider).

## Data sources (public only)

- `nebius/SWE-agent-trajectories` (Hugging Face): ~80k real SWE-agent
  trajectories. Long contexts, realistic command mix. The harness samples a
  configurable subset and caches it locally.
- `hkust-nlp/Toolathlon-Trajectories` (Hugging Face): long-horizon agent
  traces from Claude 4.5 Opus runs. These are the longest public traces
  available — some exceed 2M characters (~500k+ tokens) — so they are the
  best source for realistic 200k context-window pressure testing.
- `makarsuperstar/oni-devops-traces` (GitHub): short, clean JSONL traces with
  explicit `bash`, `read_file`, and `list_dir` tool calls.

Traces are cached under `.benchmark-cache/` after the first run.

## Run

```bash
bun run benchmark
```

Options:

```bash
# Default: 200k context window (realistic for modern SOTA models)
bun run benchmark

# Stress-test at smaller windows to see pressure-based eviction
bun run benchmark -- --context-window 32000

# Sweep multiple windows
bun run benchmark -- --context-window 32000,64000,128000,200000

# Tune samples
bun run benchmark -- --max-swe 100 --max-oni 100
bun run benchmark -- --swe-agent
bun run benchmark -- --oni-devops
```

## Cost model

For every turn of every trace we replay:

1. Archive the tool result using the same policies as the extension.
2. Build the compiled message list up to that turn.
3. Run the chosen replacement algorithm.
4. Measure:
   - **Compression ratio** — replaced archive chars / total archive chars.
   - **KV-cache invalidation cost** — messages from the first replacement to
     the end of context. Lower is better because fewer prefix tokens are
     recomputed.
   - **Recall cost** — number of archives replaced. Each one may require a
     `recall_result` call later.
   - **Real dollar cost** — context/input tokens are priced at the model's
     `input` rate for every turn; each replaced archive is assumed to be
     recalled once, paying the `input` rate for the recall tool call and the
     `output` rate for the returned original content. Prices come from
     `https://models.dev/api.json` filtered to the `opencode-go` provider.

## Algorithms compared

- `no-replacement`: keep every raw tool result (baseline).
- `oldest-first-30`: replace oldest archives until 30% of archive chars are
  freed (naive baseline).
- `supersession-only`: only replace when staleness or supersession signals are
  strong; ignore pressure.
- `current-70`: the trimmer's composite score (staleness + supersession +
  pressure + recency + co-invalidation boost) with the default thresholds.

## A note on context-window size

The default context window is **200,000 tokens**, which matches modern SOTA
coding models.

- **Toolathlon** traces are genuinely long (some >500k tokens), so at 200k
they hit heavy pressure and the pressure-based algorithms (`current-70`,
`oldest-first-30`) fire strongly.
- **SWE-agent** trajectories peak at roughly **15k tokens** (≈32% of 200k), so
at 200k they mainly exercise supersession.
- **oni-devops** traces are short and rarely hit pressure at any window.

The `--context-window` flag accepts a comma-separated list so you can sweep
and see the transition from "no pressure" to "heavy pressure".

## Output

A metrics table and a dollar-cost table are printed per source and context
window. A JSON report is written to `.benchmark-cache/benchmark-report.json`.
