# Pi Context Trimmer

A Pi extension that archives large file-read results and replaces them with compact virtual pointers when they become stale, reducing context bloat while preserving the ability to recall original content on demand.

## What It Does

For every `read` tool result, this extension:

1. **Archives** the result as a custom `results-archive` entry in the session JSONL
2. **Computes SHA-256 hashes** for each line that was actually returned
3. **Leaves the raw result in the current turn** so the model can use it immediately
4. On later turns, **checks the same file lines on disk**; if any changed, it replaces the archived content in context with a stale pointer
5. Exposes a `recall_result` tool so the model can retrieve archived content later

## Why

- **Context bloat**: Large file reads accumulate across long sessions
- **Stale data**: A file read from 20 turns ago may no longer reflect disk state
- **Recall on demand**: The model can explicitly ask for archived content when needed

## How It Works

### 1. Tool result interception (`tool_result` event)

For every `read` tool result:

- The extension determines the actual file content returned:
  - Prefer `details.truncation.content` when the read tool provides it
  - Otherwise strip the read-tool continuation footer from the raw text (e.g. `[7 more lines in file. Use offset=8 to continue.]`)
  - If `details.truncation.firstLineExceedsLimit` is true, no actual file content was returned, so nothing is archived
- It splits the content on `"\n"` (matching pi's read tool) and hashes each line
- It stores an archive record with:
  - `pointerId`: the virtual pointer ID
  - `toolName`, `toolCallId`: identifying metadata
  - `parameterKey`: the file path
  - `startLine`: the 1-indexed offset from the read input
  - `lineHashes`: SHA-256 hashes of each returned line
  - `originalContent`: the original tool result content (preserved verbatim for recall)

### 2. Context compilation (`context` event)

Before each LLM call, the extension scans `toolResult` messages for archived reads:

- It reads the current file from disk and splits it on `"\n"`
- For each archived read, it re-hashes the same line range
- **If unchanged**: the raw content stays in context
- **If changed or file deleted**: the content is replaced with `[Results Archive: ptr_xxx (Invalidated - Stale)]`

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
  parameterKey: string;      // absolute file path
  timestamp: number;
  originalContent: string;   // JSON-stringified content array (verbatim tool result)
  startLine: number;         // 1-indexed offset of first returned line
  lineHashes: string[];      // SHA-256 hashes of each returned line
}
```

## Limitations

- Only archives `read` tool results today
- Only text content is hashed and tracked
- Footer stripping relies on the read-tool footer formats used by pi today
