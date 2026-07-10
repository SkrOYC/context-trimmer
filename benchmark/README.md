# Context Trimmer Benchmark

Stress-tests the `pi-context-trimmer` eviction algorithm against public agent
trajectories and compares its cost against simple baselines using real prices
from [models.dev](https://models.dev) (opencode-go provider).

## Data sources (public only)

- `nebius/SWE-agent-trajectories` (Hugging Face): ~80k real SWE-agent
  trajectories. Long contexts, realistic command mix. The harness samples a
  configurable subset and caches it locally.
- `makarsuperstar/oni-devops-traces` (GitHub): short, clean JSONL traces with
  explicit `bash`, `read_file`, and `list_dir` tool calls.

Traces are cached under `.benchmark-cache/` after the first run.

## Run

```bash
bun run benchmark
```

Options:

```bash
bun run benchmark -- --max-swe 100 --max-oni 100 --context-window 32000
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

## Output

A metrics table and a dollar-cost table are printed per source. A JSON report
is written to `.benchmark-cache/benchmark-report.json`.
