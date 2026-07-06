# Pi Context Trimmer: KV-Cache-Aware Redesign Plan

> Tracking document for the upcoming refactor of the context-trimmer extension.
> Created: 2026-07-05
> Status: Design phase complete; implementation pending.

---

## 1. Motivation

The current extension treats every disk change as a reason to replace a full archived `read` result with a stale pointer. This is wasteful in two ways:

1. **Information waste:** A single changed line invalidates an entire multi-hundred-line read.
2. **KV-cache waste:** Replacing content in the middle of context invalidates the KV cache for that content and everything after it. We were spending cache to save context-window tokens.

The new design optimizes for **KV-cache hit rate** first, following the principle that context should be **append-only** unless there is a strong reason to mutate it.

---

## 2. Core Design Principles

1. **Append-only by default.** Historical `toolResult` messages are not modified unless a stronger trigger fires.
2. **Supersession, not staleness, drives replacement.** A newer read of the same file supersedes an older read when enough of the old read's range has been re-observed.
3. **Cumulative overlap.** Multiple newer reads can accumulate coverage of an older read; the older read is replaced only when cumulative coverage crosses a threshold.
4. **Recency-aware threshold.** Older reads are more expensive to remove (they invalidate more KV cache), so they require higher cumulative overlap to justify replacement. Recent reads are cheaper to remove, so a lower overlap suffices.
5. **Batch all mutations.** All replacements happen in a single `context` event pass, so the cache miss is paid once.
6. **Pointer = restorable compression.** When content is replaced, it is replaced by a stable pointer; the full original content remains available via `recall_result` and the session archive.

---

## 3. Current vs. New Behavior

### Current behavior

- Every `read` result is archived with per-line SHA-256 hashes.
- On each `context` compilation, every archived read is checked against disk.
- If **any** line in the read range changed (or the file was deleted), the entire result is replaced with `[Results Archive: ptr_xxx (Invalidated - Stale)]`.
- `recall_result` can retrieve the original content, wrapped as stale if disk no longer matches.

### New behavior

- Every `read` result is still archived with per-line hashes.
- Disk staleness is **no longer** a trigger for context replacement. It is tracked only for:
  - `recall_result` status/wrapping.
  - Future context-pressure eviction priority.
- On each `context` compilation, the extension computes for each archived read:
  - Its cumulative coverage by all **newer** reads of the same file on the current branch.
  - A replacement threshold based on its position in the compiled context.
- If cumulative coverage >= threshold, the read is marked superseded and replaced with its pointer.
- If coverage < threshold, the read stays verbatim in context.
- All replacements are computed and applied in one pass.

---

## 4. Decisions Made

### 4.1 Supersession threshold: 25% to 60%, linear by position

- **Recent reads** (near end of context): threshold = **25%**.
- **Oldest reads** (near beginning of context): threshold = **60%**.
- **In between:** linear interpolation.

Formula:

```typescript
const positionRatio = messageIndex / totalMessages; // 0 = oldest, 1 = most recent
const threshold = 0.25 + (0.60 - 0.25) * (1 - positionRatio);
```

Rationale: recent reads are cheap to remove (little suffix invalidated), so we accept lower overlap. Old reads are expensive to remove, so we demand near-total re-observation.

### 4.2 Cumulative coverage is read-relative

Coverage is computed as:

```
coverage = union_of_covered_lines / old_read_line_count
```

The denominator is the old read's own line count, not the file length or union of ranges. This answers: "What fraction of this old observation has been re-observed?"

### 4.3 Coverage is computed from current-branch archives

- Archives are grouped by file path (`parameterKey`).
- Within each group, archives are sorted by their position in the compiled `event.messages` array (falling back to timestamp).
- For each archive, coverage is the union of line ranges from all archives that appear **after** it.
- Only archives whose `toolCallId` appears in the current compiled messages are considered for both coverage contribution and replacement.

This naturally handles:
- Parallel reads (message order is stable in `context`).
- Cascading supersession (A superseded by B, B superseded by C).
- Compacted history (compacted reads are no longer in messages, so they do not contribute coverage or get replaced).

### 4.4 Disk staleness is preserved but not surfaced

The existing `checkStaleness()` utility is kept for:
- `recall_result` wrapping (`<recalled-stale-content>`).
- Future eviction scoring under context pressure.

It is **not** used to modify context.

### 4.5 Pointer text stays the same

When a read is superseded, its `toolResult` content is replaced with:

```
[Results Archive: ptr_xxx (Invalidated - Stale)]
```

No new annotation types are introduced. The pointer is the single, consistent representation of "this content is no longer the primary source."

### 4.6 Context-pressure eviction is a side note for now

The extension will continue to expose `ctx.getContextUsage()` data, but aggressive context-pressure eviction is **deferred**. It will be added later with a separate scoring function combining:
- Actual disk staleness.
- Cumulative supersession coverage.
- Recency / KV-cache removal cost.
- Information value.

---

## 5. Implementation Plan

### 5.1 New modules

#### `src/supersession.ts`

Responsibilities:
- Compute cumulative coverage of an older read by newer reads.
- Compute replacement threshold from message position.
- Decide whether a read is superseded.
- Build a set of superseded `pointerId`s from the current messages and archives.

Key functions (draft):

```typescript
export function computeThreshold(messageIndex: number, totalMessages: number): number;

export function computeCoverage(
  target: ArchivedResult,
  laterReads: ArchivedResult[]
): number;

export function findSuperseded(
  messages: AgentMessage[],
  archives: Map<string, ArchivedResult>
): Set<string>;
```

#### `src/eviction.ts` (stub only for now)

Responsibilities (future):
- Score archives for eviction under context pressure.
- Select which archives to replace when `ctx.getContextUsage().percent` exceeds thresholds.

For this phase, the file may only export placeholder types/scorers so the architecture is ready.

### 5.2 Modified modules

#### `src/types.ts`

- No schema changes required for `ArchivedResult` (coverage is recomputed, not stored).
- Optionally add a `SupersessionResult` / `EvictionCandidate` helper type.

#### `src/state.ts`

- Keep `activeArchives: Map<string, ArchivedResult>`.
- Add `archivesByPath: Map<string, ArchivedResult[]>` for fast grouping.
- The `rebuildState` function populates both maps from the branch.
- No persistent supersession state; recomputed per `context` event.

#### `src/archive.ts`

- Keep archiving every `read` result.
- Remove any eager staleness-based flagging (there is none today, but ensure it stays absent).
- After archiving, update `state.archivesByPath` so the new archive is visible for overlap computation.

#### `src/context.ts`

Major rewrite:
- Remove disk-based staleness check as a replacement trigger.
- Rebuild state.
- Compute superseded reads via `findSuperseded(messages, activeArchives)`.
- Replace content of superseded `toolResult` messages with their pointer.
- Return modified messages.

Pseudocode:

```typescript
pi.on("context", async (event, ctx) => {
  rebuildState(ctx);

  const superseded = findSuperseded(event.messages, activeArchives);

  const updated = event.messages.map(msg => {
    if (msg.role !== "toolResult") return msg;

    const arc = findArchiveByToolCallId(msg.toolCallId);
    if (!arc) return msg;
    if (!superseded.has(arc.pointerId)) return msg;

    return {
      ...msg,
      content: [{
        type: "text",
        text: `[Results Archive: ${arc.pointerId} (Invalidated - Stale)]`
      }]
    };
  });

  return { messages: updated };
});
```

#### `src/recall.ts`

- Keep current behavior.
- Continue to use `checkStaleness()` to decide active vs. invalidated wrapping.
- No logic changes required for this phase.

#### `src/utils.ts`

- Keep `getHash`, `stripReadFooters`, `checkStaleness`.
- Optionally add `mergeIntervals()` helper for coverage union.

### 5.3 Test updates

The test suite currently asserts eager staleness replacement. The following tests need to be rewritten or removed:

- `should replace raw content with stale pointer in context if a read line has changed`
  - Change to: a single line change does **not** replace content.
- `should replace content with pointer if the file is deleted on disk`
  - Change to: deletion does **not** replace content (unless under pressure, deferred).
- `should not invalidate read content if the disk change is outside the read line range`
  - Can be removed or kept as a no-op verification.
- `should preserve raw content in context if the file on disk is unchanged`
  - Keep; still valid.

New tests to add:

- `should not replace read content when only disk content changes`
- `should replace old read when a newer read covers >=60% of an old read near the beginning`
- `should replace recent old read when a newer read covers >=25% of it`
- `should accumulate overlap from multiple newer reads`
- `should not replace old read when cumulative overlap is below threshold`
- `should keep both reads when overlap is below threshold`
- `should handle cascading supersession`

### 5.4 File system plan

```
src/
  index.ts          # unchanged wiring
  types.ts          # minor additions
  state.ts          # add archivesByPath
  utils.ts          # keep existing, add mergeIntervals
  archive.ts        # keep archiving, no eager flagging
  context.ts        # major rewrite: supersession-based replacement
  recall.ts         # unchanged
  supersession.ts   # new: coverage + threshold logic
  eviction.ts       # new: stub for future pressure eviction
```

---

## 6. Risks and Edge Cases

| Risk | Mitigation |
|------|------------|
| Parallel reads of same file in one turn | Use stable `event.messages` order in `context` handler. |
| Compacted history | Only archives whose `toolCallId` is in current messages participate. |
| Many reads of same file causing O(n²) coverage computation | n is typically small; optimize later if profiling shows it matters. |
| Threshold too aggressive / too conservative | Expose constants; tune with real sessions. |
| Model confused by old content left in context | This is intentional per design; model handles stale content until superseded. |
| `ctx.getContextUsage()` returns null | Guard with fallback; do not evict if usage unknown. |

---

## 7. Side Notes / Future Work

The following are explicitly deferred but noted for later:

1. **Context-pressure eviction.** Use `ctx.getContextUsage()` to trigger targeted eviction when context approaches limits. Scoring should combine staleness, supersession coverage, recency, and KV-cache cost.
2. **Per-line staleness display.** Optionally show which specific lines changed without removing the whole read. Not needed for KV-cache-first design.
3. **Configurable thresholds.** Allow users to tune min/max thresholds via settings.
4. **AST-aware or semantic staleness.** Overkill for now; line hashes are sufficient.
5. **Cross-file reads.** Not applicable; reads are grouped by `parameterKey` (file path).

---

## 8. Acceptance Criteria

- [ ] A single line change does not replace a large read result.
- [ ] A newer read covering >=60% of an old early-context read replaces it.
- [ ] A newer read covering >=25% of a recent read replaces it.
- [ ] Multiple partial newer reads can cumulatively supersede an old read.
- [ ] All replacements happen in one `context` pass.
- [ ] `recall_result` still works for both active and stale content.
- [ ] Tests pass and cover the new behavior.
