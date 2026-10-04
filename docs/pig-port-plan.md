# PiG-native Context Trimmer — Port Plan

Status: **implemented**. The Go extension lives in [`../pig`](../pig); it builds
clean (`go build`, `go vet`, `gofmt`), validates as a PiG extension, passes the
behavior tests in `pig/behavior_test.go`, and was verified live against a real
`pig` session (archives persisted, older reads replaced with pointers in the
provider request, newest read protected).

This document records the plan and the runtime contracts that were verified live
against `pig 0.4.0` so the implementation did not guess.

---

# Original plan

## 0. Decisions already made

- **Language:** Go, using the PiG Go SDK (`github.com/MichaelKinsy/PiG/extensions/sdk`).
- **Location:** same repository, new subdirectory (the repository will be renamed
  later to represent both the Pi and PiG extensions).
- **No benchmark port.**
- **No unit tests.** Behavior/e2e testing only.
- **Go idioms, but preserve the existing intent and tuning knobs** so the
  eviction semantics can still be fine-tuned.
- **No cross-compatibility with the TS extension.** This is a PiG-native build;
  it only needs to read its own `results-archive` entries written by itself in a
  session.

## 1. Verified runtime contracts (live proof)

A throwaway probe extension was built with `pig install --validate-only` and run
against a real `pig --print` session on `opencode-go/deepseek-v4.1-flash`, in a
`devenv` shell with Go 1.26.7. Registered handlers that fired:
`session_start`, `session_tree`, `tool_result`, `context`, `context_with_system`,
`before_provider_request`. Findings below are from the captured payloads.

### 1.1 `tool_result` event payload (Go `data map[string]any`)

Common keys: `type` (`"tool_result"`), `toolName`, `toolCallId`, `input`,
`content`, `isError`. Optional: `details`, `structuredContent`.

- `content` is `[]any` of `{ "type": "text", "text": string }` blocks.
- `input` is the tool's own arguments. Verified:
  - `read` → `{ path, offset, limit }` (offset/limit always present; defaults
    `offset:1`, `limit:2000`).
  - `bash` → `{ command }`.
  - `grep` → `{ path, pattern }` (optional `glob`/`ignoreCase`/`literal`/`context`
    not exercised; policy already treats them as optional).
  - `find` → `{ path, pattern }`.
  - `ls` → `{ path }`.
- **`details` is usually absent.** It is `null`/absent for bash/grep/find/ls and
  for line-limit reads. It is present only for byte-truncation, e.g. a single
  oversized line:
  ```json
  "details": { "truncation": {
    "content": "", "firstLineExceedsLimit": true, "truncatedBy": "bytes",
    "maxBytes": 51200, "maxLines": 2000, "outputBytes": 0, "outputLines": 0,
    "totalBytes": 100000, "totalLines": 1, "truncated": true, "lastLinePartial": false
  }}
  ```
- **Line-limit reads carry the continuation footer instead of `details`.**
  - `read big.txt limit=50` → `content[0].text` ends with
    `"\n\n[251 more lines in file. Use offset=51 to continue.]"` and `details` is
    absent.
  - `read huge.txt` (3000 lines, default limit 2000) → 2000 lines + footer
    `"\n\n[1001 more lines in file. Use offset=2001 to continue.]"`, `details` absent.
- `bash` also carries `structuredContent` (`{exit_code, output, truncated,
  wall_time_seconds}`); the TS extension ignores it and we will too.

**Implication:** on PiG, normal read archiving depends on `stripReadFooters`
(the `details.truncation.content` fast path only appears alongside byte
truncation). The existing footer regexes already match the observed PiG formats
(`[N more lines in file. Use offset=N to continue.]` and the oversized-line
warning).

### 1.2 `context` event payload

Keys: `type`, `messages`. `messages` is `[]any` of `map[string]any`:
- Standard roles observed: `user`, `assistant`, `toolResult`. (System is only in
  `context_with_system`, which we do not need.)
- A `toolResult` message has keys `role, toolCallId, toolName, content, details,
  isError, timestamp`; `content` is the same text-block array as the event.
- `details` is forwarded when the tool result had it.
- `user` content arrives as a content-block array (handle a bare string too).
- Event order in a turn was:
  `session_start` → `context` → `context_with_system` → `before_provider_request`
  → `tool_result` → `context` → …

### 1.3 `context` replacement is honored (critical)

The probe's `context` handler rewrote every `toolResult.content` to
`[PROBE-POINTER <toolCallId>]` and returned `{messages: msgs}`. The subsequent
`before_provider_request` payload contained those markers and **no** original
read footer. Confirms:
- the `context` handler runs before the provider request;
- returning a replacement message list is applied;
- mutating message maps in place also survives (the SDK documents this), so we
  can mutate and/or return the list.

We only ever replace `content` (never add/remove messages), so in-place mutation
is sufficient and robust across both `context` and `context_with_system`.

### 1.4 Custom entry persistence + branch rebuild

`ctx.AppendEntry(customType, data)` then `ctx.SessionManager().GetBranch(nil)`
returns raw maps that preserve custom entries:
```json
{ "type": "custom", "id": "7aaf97a9", "parentId": "...",
  "timestamp": "...", "customType": "probe-entry", "data": { ... } }
```
This is the state-rebuild path. **Do not** use the typed `ctx.GetBranch()`: its
`BranchEntry` struct drops `customType` and `data`, so archives would be invisible
after a restart/resume/branch switch.

### 1.5 Context usage

`ctx.GetContextUsage()` returned `{ tokens: 2163, contextWindow: 1000000,
percent: 0.2163 }`. `ContextWindow` is populated, so the eviction pressure gate
has what it needs. (Note: the default model here is a 1M window; the TS pressure
knees were tuned for 200k. Keep the knobs configurable rather than hard-coded.)

### 1.6 Go SDK surface confirmed

- Factory form: `func Extension() *sdk.Extension`, `sdk.New(name)`.
- `ext.OnSessionStart`, `ext.OnEvent(sdk.EventSessionTree)`,
  `ext.OnToolResult`, `ext.OnEvent(sdk.EventContext)`, `ext.Tool(name, desc, sdk.Schema, handler)`.
- `sdk.EventContext`, `sdk.EventContextWithSystem`, `sdk.EventBeforeProviderRequest` exist.
- `ctx.AppendEntry`, `ctx.SessionManager().GetBranch(nil)`, `ctx.GetContextUsage()`,
  `ctx.Cwd()`, `ctx.Done()`.
- Tool results: `sdk.ToolResultContent{Type, Text, Data, MimeType}` and
  `sdk.AgentToolResult{Content, Details, StructuredContent, Usage, IsError, Terminate}`;
  a `ToolFunc` may return a string or a structured result.
- `Extension.RunWithConn(net.Conn)` exists explicitly for testing without a host
  process; the wire is framed (4-byte big-endian length + JSON envelope) and the
  envelope shapes are stable (`register`, `ready`, `request`, `response`, `call`,
  `call_result`, `notify`, `cancel`, `shutdown`).

## 2. Proposed layout

```text
<repo>/
  src/ …                      # existing Pi TS extension (untouched)
  pigg/                       # NEW: Go module + PiG extension
    go.mod                    # module path + SDK require (pig injects a temp replace at build)
    extension.go              # factory: state + handler wiring (mirrors src/index.ts)
    types.go                  # ArchivedResult, ToolPolicy, POLICIES
    state.go                  # ArchiveState + rebuild/register
    archive.go                # tool_result handler
    context.go                # context handler
    eviction.go               # weighted scoring + batching (selectEvictionCandidates)
    supersession.go           # coverage + recency thresholds
    recall.go                 # recall_result tool
    utils.go                  # sha256, footer strip, staleness, message text
    *_test.go                 # behavior tests (see §5)
    testdata/                 # captured real payload fixtures
    e2e/live-smoke.sh         # optional manual live smoke run (tmux + real pig)
  devenv.nix / devenv.lock    # Go toolchain (already used for the probe)
```

Naming/identity is an open decision (§8): PiG derives the expected extension
identity from the selected directory/file stem, so the directory name and
`sdk.New(...)` must agree, or a Piglet/Package must map the name.

## 3. Component port map

The port mirrors the TS module boundaries so behavior stays reviewable against
the original.

| TS | Go | Notes |
|---|---|---|
| `index.ts` | `extension.go` | `Extension()` builds state, registers handlers + tool |
| `types.ts` | `types.go` | `ArchivedResult` with identical camelCase JSON tags; `POLICIES` table; group key |
| `state.ts` | `state.go` | mutex-guarded maps; `rebuildState` from `SessionManager().GetBranch(nil)`; append-only `evictedPointers` |
| `archive.ts` | `archive.go` | policy lookup, error skip, content extract, per-line sha256, `AppendEntry` |
| `context.ts` | `context.go` | `selectEvictionCandidates`, then replace `content` for chosen pointers |
| `eviction.ts` | `eviction.go` | signals, weights, config, pressure ramps, batching, co-location bump, proven-dead bypass |
| `supersession.ts` | `supersession.go` | interval merge, line-range coverage, exact-key coverage, recency threshold |
| `recall.ts` | `recall.go` | `recall_result` tool, stale wrapper, active passthrough |
| `utils.ts` | `utils.go` | sha256, footer regexes, staleness (batch + single), message text, token estimate |

### 3.1 Preserved schema

Keep the archive record field-for-field, including optional strategies:

```go
type ArchivedResult struct {
    PointerID             string   `json:"pointerId"`
    ToolName              string   `json:"toolName"`
    ToolCallID            string   `json:"toolCallId"`
    ParameterKey          string   `json:"parameterKey"`
    StalenessStrategy     string   `json:"stalenessStrategy,omitempty"`     // file-lines | immutable
    SupersessionStrategy  string   `json:"supersessionStrategy,omitempty"`  // line-range | exact-key | none
    Timestamp             int64    `json:"timestamp"`
    OriginalContent       string   `json:"originalContent"` // JSON of the content-block array
    StartLine             int      `json:"startLine"`
    LineHashes            []string `json:"lineHashes"`
}
```

### 3.2 Preserved knobs (fine-tuning surface)

Port `DEFAULT_EVICTION_CONFIG` verbatim as an exported struct + constructor:
`immutableStalenessConfidence`, `minBatchTokens`, `overflowGuardFraction`,
`pressureAbsoluteKnee`, `pressurePercentKnee`, `semanticByTool`, `threshold`,
and the seven weights (`affordability, coldness, pressure, semantic, size,
staleness, supersession`). Keep `selectEvictionCandidates` taking the config as a
parameter so it can be re-tuned without touching call sites (production uses the
defaults).

### 3.3 Go idioms to use

- Mutex-guarded `ArchiveState` (handlers run on separate goroutines, unlike TS).
- `os.ReadFile` + `path/filepath`; `crypto/sha256`; `crypto/rand` for pointer IDs.
- `map[string]struct{}` for evicted pointers; `slices`/`sort` for intervals.
- Deterministic ordering where it matters: sort metrics by message index; every
  map iteration result feeds into order-independent reductions.
- Return `(nil, nil)` from `context` on error (match TS "log and continue") and
  log to stderr.

## 4. Behavior semantics to preserve (unchanged)

1. Archive only on non-error supported tool results; skip oversized-first-line.
2. Leave the fresh result in the turn it lands; only replace on **later** turns.
3. Eviction is **append-only** (`evictedPointers` never cleared, but rebuilt
   archives keep the set across turns).
4. **Most recent archive is protected.**
5. **Proven-dead** (full supersession, or a proven-stale read) evicts with no
   pressure; still-valid content needs pressure > 0 **and** score ≥ threshold.
6. **Batched** removals: hold until `minBatchTokens` or the overflow guard.
7. Co-location bump: set affordability to 1 for candidates after the first
   removal (suffix is already invalidated).
8. Pointer stub text: `[Results Archive: <id> (Invalidated - Stale)]`.
9. Recall: active → verbatim content; stale → `<recalled-stale-content>` wrapper.

## 5. Testing strategy (behavior/e2e, no unit tests)

### 5.1 Primary: fake-host behavior harness (`pigg/hosttest`)

Use `sdk.Extension.RunWithConn(net.Pipe())` with a minimal in-process host that
speaks the real wire protocol. This is deterministic, model-free, fast, and
exercises the real handlers end-to-end across the extension boundary.

The harness must:

1. Frame messages (`4-byte big-endian length` + JSON envelope) on both ends.
2. Read the extension's `register` envelope (capture `handlers` → handler IDs,
   `tools`).
3. Send `ready` (`session_name`, `cwd`, `mode`, `width`, `model`, `state`).
4. Send event requests:
   `{type:"request", id, request:{method:"event", event:"tool_result"|"context"|"session_start"|"session_tree", handler_id, args:{...}}}`,
   and read the matching `response`.
5. Answer extension→host `call` envelopes for the calls we use:
   `appendEntry`, `sessionRead` (`getBranch`/`getEntries`), `getContextUsage`,
   `setStatus`. Maintain a fake session log so `appendEntry` → `getBranch`
   round-trips (this validates rebuild-from-branch).
6. Invoke the `recall_result` tool via a `tool_call` request.

Scenarios (deterministic, using `testdata/` fixtures captured from the live probe):

- **Archive:** two `read`s and a `bash` → assert `appendEntry` of
  `results-archive` with expected `parameterKey`, `startLine`, `lineHashes`, and
  verbatim `originalContent`.
- **Skip:** error result and `firstLineExceedsLimit` result produce no archive.
- **Supersession (dead bypass):** second read of the same range → older pointer's
  content is replaced in the next `context` response even with zero pressure.
- **Staleness:** read a temp file, mutate it on disk, then `context` → the read
  is replaced as proven-stale; a directory path read must not abort the pass.
- **Staleness batch:** one unreadable/dir path marks only its path's archives
  stale.
- **Pressure + batching:** synthesize large contexts so pressure > 0; assert
  nothing fires below `minBatchTokens` and a batch fires above it; assert the
  most-recent archive stays.
- **Rebuild:** feed `session_read.getBranch` with previously appended custom
  entries → recall finds them after a simulated `session_start`.
- **Recall:** active passthrough and stale wrapper.

Fixtures under `testdata/` are the exact payloads captured in §1, so the harness
never invents a shape PiG does not produce.

### 5.2 Secondary: live smoke script (`pigg/e2e/live-smoke.sh`)

A manual, on-demand script (run under `devenv shell --`, in tmux) that:
- builds/loads the extension with real `pig --print`,
- drives a short read/read-again/reread-after-edit sequence,
- asserts the session JSONL gained `results-archive` entries and that the
  provider request saw pointer replacements.

This is not a CI gate (needs a model + tokens) but proves the extension against
the real host after changes.

## 6. Tooling

- `devenv.nix` with `languages.go.enable = true` (Go 1.26.7 in the current nixpkgs;
  satisfies the SDK's `go 1.26` floor). Build/validate via
  `devenv shell -- pig install ./pigg --validate-only --json` and
  `devenv shell -- go test ./pigg/...`.
- `devenv.lock` committed for reproducibility.
- No Node/Bun needed for the Go extension.

## 7. Risks / watch items

- **Read footer drift.** Footer stripping is load-bearing on PiG. Keep the
  observed formats as tests; if PiG adds formats, extraction degrades silently.
- **`details` optionality.** Treat `details` as optional everywhere; never assume
  `details.truncation`.
- **Message-role coverage.** Token estimation must handle bare-string `user`
  content and array content for assistant/toolResult; compaction/branch-summary
  roles are unverified in PiG but the TS handling can be mirrored defensively.
- **Token estimate unit.** TS uses UTF-16 `.length/4`; Go `len()/4` is bytes.
  Byte-count is fine for a relative heuristic, but note the difference; use rune
  count if closer parity is wanted.
- **Map iteration order.** Ensure every order-sensitive reduction is index-based.
- **1M-window default model.** The knee constants are 200k-tuned; keep them
  configurable.

## 8. Open decisions before implementation

1. **Directory name / extension identity.** Recommend `pigg/` with
   `sdk.New("pigg")`, or name the directory `pig-context-trimmer` if a friendly
   identity is wanted without a Piglet. Confirm.
2. **Go module path.** e.g. `github.com/<owner>/<repo>/pigg`. Confirm the path to
   put in `go.mod`.
3. **Behavior harness acceptance.** Confirm the fake-host `RunWithConn` harness
   (§5.1) is the intended "behavior testing", with the live smoke script as a
   manual companion.
4. **Compaction roles.** Confirm it is acceptable to mirror the TS role handling
   defensively rather than first probing PiG compaction output.

## 9. Milestones

1. Scaffold `pigg/` Go module + devenv; validate an empty factory loads.
2. Port `types`, `utils` (hash/footer/staleness/message-text), `state`.
3. Port `archive` + `context` + `recall`; wire `extension.go`.
4. Build the `hosttest` fake host; add fixtures from §1; write behavior tests.
5. Live smoke against real `pig`; tune nothing (parity), record results.
6. Update repo docs (README/architecture) for the two-extension layout.
