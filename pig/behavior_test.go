package pig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oscar/pi-context-trimmer/pig/internal/hosttest"
)

func newHost(t *testing.T, cwd string) *hosttest.Host {
	t.Helper()
	host, err := hosttest.New(Extension(), cwd)
	if err != nil {
		t.Fatalf("start host: %v", err)
	}
	t.Cleanup(func() { _ = host.Close() })
	return host
}

func readResult(toolCallID, path, text string) map[string]any {
	return map[string]any{
		"type":       "tool_result",
		"toolName":   "read",
		"toolCallId": toolCallID,
		"input":      map[string]any{"path": path, "offset": 1.0, "limit": 2000.0},
		"content":    []any{map[string]any{"type": "text", "text": text}},
		"isError":    false,
	}
}

func bashResult(toolCallID, command, text string) map[string]any {
	return map[string]any{
		"type":       "tool_result",
		"toolName":   "bash",
		"toolCallId": toolCallID,
		"input":      map[string]any{"command": command},
		"content":    []any{map[string]any{"type": "text", "text": text}},
		"isError":    false,
	}
}

func userMessage(text string) map[string]any {
	return map[string]any{
		"role":    "user",
		"content": []any{map[string]any{"type": "text", "text": text}},
	}
}

func toolResultMessage(toolCallID, toolName, text string) map[string]any {
	return map[string]any{
		"role":       "toolResult",
		"toolCallId": toolCallID,
		"toolName":   toolName,
		"content":    []any{map[string]any{"type": "text", "text": text}},
		"isError":    false,
		"timestamp":  1.0,
	}
}

func contentText(message map[string]any) string {
	content, _ := message["content"].([]any)
	parts := make([]string, 0, len(content))
	for _, block := range content {
		if part, ok := block.(map[string]any); ok && part["type"] == "text" {
			text, _ := part["text"].(string)
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n")
}

func archiveData(t *testing.T, entry map[string]any) ArchivedResult {
	t.Helper()
	if entry["customType"] != ArchiveType {
		t.Fatalf("entry customType = %v, want %q", entry["customType"], ArchiveType)
	}
	raw, err := json.Marshal(entry["data"])
	if err != nil {
		t.Fatalf("marshal entry data: %v", err)
	}
	var arc ArchivedResult
	if err := json.Unmarshal(raw, &arc); err != nil {
		t.Fatalf("decode archive: %v", err)
	}
	return arc
}

func TestBehaviorArchiveReadStripsFooterAndRecordsLines(t *testing.T) {
	host := newHost(t, t.TempDir())

	text := "alpha\nbeta\n\n[251 more lines in file. Use offset=51 to continue.]"
	if _, err := host.ToolResult(readResult("tc1", "notes.txt", text)); err != nil {
		t.Fatalf("tool_result: %v", err)
	}

	entries := host.Entries()
	if len(entries) != 1 {
		t.Fatalf("want 1 archive entry, got %d", len(entries))
	}
	arc := archiveData(t, entries[0])
	if arc.ToolName != "read" || arc.ParameterKey != "notes.txt" || arc.StartLine != 1 {
		t.Fatalf("unexpected archive: %+v", arc)
	}
	if len(arc.LineHashes) != 2 {
		t.Fatalf("want 2 line hashes after footer strip, got %d", len(arc.LineHashes))
	}
	if arc.StalenessStrategy != StalenessFileLines || arc.SupersessionStrategy != SupersessionLineRange {
		t.Fatalf("unexpected strategies: %+v", arc)
	}
	if arc.LineHashes[0] != GetHash("alpha") || arc.LineHashes[1] != GetHash("beta") {
		t.Fatalf("line hashes do not match stripped content: %v", arc.LineHashes)
	}
}

func TestBehaviorArchiveKeepsOriginalContentVerbatim(t *testing.T) {
	host := newHost(t, t.TempDir())

	text := "first\nsecond"
	if _, err := host.ToolResult(readResult("tc1", "a.txt", text)); err != nil {
		t.Fatalf("tool_result: %v", err)
	}
	arc := archiveData(t, host.Entries()[0])

	var content []map[string]any
	if err := json.Unmarshal([]byte(arc.OriginalContent), &content); err != nil {
		t.Fatalf("originalContent is not content JSON: %v", err)
	}
	if len(content) != 1 || content[0]["type"] != "text" || content[0]["text"] != text {
		t.Fatalf("originalContent not verbatim: %s", arc.OriginalContent)
	}
}

func TestBehaviorArchiveSkipsErrorsAndOversizedFirstLine(t *testing.T) {
	host := newHost(t, t.TempDir())

	errored := readResult("tc1", "x.txt", "boom")
	errored["isError"] = true
	if _, err := host.ToolResult(errored); err != nil {
		t.Fatalf("tool_result error case: %v", err)
	}

	truncated := readResult("tc2", "x.txt", "[Line 1 is 97.7KB, exceeds 50.0KB limit. Use bash: cat x.txt]")
	truncated["details"] = map[string]any{
		"truncation": map[string]any{"firstLineExceedsLimit": true, "content": ""},
	}
	if _, err := host.ToolResult(truncated); err != nil {
		t.Fatalf("tool_result oversized case: %v", err)
	}

	if entries := host.Entries(); len(entries) != 0 {
		t.Fatalf("want no archives, got %d", len(entries))
	}
}

func TestBehaviorArchiveIgnoresUnsupportedTools(t *testing.T) {
	host := newHost(t, t.TempDir())

	if _, err := host.ToolResult(map[string]any{
		"type":       "tool_result",
		"toolName":   "edit",
		"toolCallId": "tc1",
		"input":      map[string]any{"path": "a.txt"},
		"content":    []any{map[string]any{"type": "text", "text": "patched"}},
		"isError":    false,
	}); err != nil {
		t.Fatalf("tool_result: %v", err)
	}

	if entries := host.Entries(); len(entries) != 0 {
		t.Fatalf("want no archives for edit, got %d", len(entries))
	}
}

func TestBehaviorSupersessionReplacesOlderWithPointer(t *testing.T) {
	host := newHost(t, t.TempDir())

	big := strings.Repeat("x", 40_000)
	if _, err := host.ToolResult(bashResult("tc1", "echo hi", big)); err != nil {
		t.Fatalf("first bash result: %v", err)
	}
	if _, err := host.ToolResult(bashResult("tc2", "echo hi", big)); err != nil {
		t.Fatalf("second bash result: %v", err)
	}

	entries := host.Entries()
	if len(entries) != 2 {
		t.Fatalf("want 2 archives, got %d", len(entries))
	}
	older := archiveData(t, entries[0])

	result, err := host.Context([]any{
		userMessage("list"),
		toolResultMessage("tc1", "bash", big),
		userMessage("again"),
		toolResultMessage("tc2", "bash", big),
	})
	if err != nil {
		t.Fatalf("context: %v", err)
	}
	updated, _ := result["messages"].([]any)
	if len(updated) != 4 {
		t.Fatalf("want 4 messages, got %d", len(updated))
	}

	if got := contentText(updated[1].(map[string]any)); got != pointerStub(older.PointerID) {
		t.Fatalf("older message not replaced with pointer:\n%q", got)
	}
	if got := contentText(updated[3].(map[string]any)); got != big {
		t.Fatalf("most recent message should be untouched")
	}
}

func TestBehaviorContextProtectsMostRecentArchive(t *testing.T) {
	host := newHost(t, t.TempDir())

	big := strings.Repeat("y", 40_000)
	if _, err := host.ToolResult(bashResult("tc1", "echo", big)); err != nil {
		t.Fatalf("bash result: %v", err)
	}

	result, err := host.Context([]any{
		userMessage("x"),
		toolResultMessage("tc1", "bash", big),
	})
	if err != nil {
		t.Fatalf("context: %v", err)
	}
	updated, _ := result["messages"].([]any)
	if got := contentText(updated[1].(map[string]any)); got != big {
		t.Fatalf("single most recent archive was evicted")
	}
}

func TestBehaviorEvictionIsAppendOnly(t *testing.T) {
	host := newHost(t, t.TempDir())

	big := strings.Repeat("z", 40_000)
	if _, err := host.ToolResult(bashResult("tc1", "echo", big)); err != nil {
		t.Fatalf("first bash result: %v", err)
	}
	if _, err := host.ToolResult(bashResult("tc2", "echo", big)); err != nil {
		t.Fatalf("second bash result: %v", err)
	}
	older := archiveData(t, host.Entries()[0])

	// The first turn evicts the superseded older archive.
	if _, err := host.Context([]any{
		userMessage("1"),
		toolResultMessage("tc1", "bash", big),
		userMessage("2"),
		toolResultMessage("tc2", "bash", big),
	}); err != nil {
		t.Fatalf("first context: %v", err)
	}

	// A later turn drops the superseding archive, so the older one is now the
	// most recent and would be protected. Append-only keeps it replaced anyway.
	result, err := host.Context([]any{
		userMessage("1"),
		toolResultMessage("tc1", "bash", big),
	})
	if err != nil {
		t.Fatalf("second context: %v", err)
	}
	updated, _ := result["messages"].([]any)
	if got := contentText(updated[1].(map[string]any)); got != pointerStub(older.PointerID) {
		t.Fatalf("append-only invariant broken; got %q", got)
	}
}

func TestBehaviorRecallReturnsActiveContent(t *testing.T) {
	dir := t.TempDir()
	body := "one\ntwo\nthree"
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte(body), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	host := newHost(t, dir)

	if _, err := host.ToolResult(readResult("tc1", "f.txt", body)); err != nil {
		t.Fatalf("tool_result: %v", err)
	}
	arc := archiveData(t, host.Entries()[0])

	result, err := host.CallTool("recall_result", "call-1", map[string]any{"pointer_id": arc.PointerID})
	if err != nil {
		t.Fatalf("recall: %v", err)
	}
	details, _ := result["details"].(map[string]any)
	if details["status"] != "active" {
		t.Fatalf("want active recall, got %v", details)
	}
	content, _ := result["content"].([]any)
	block := content[0].(map[string]any)
	if block["text"] != body {
		t.Fatalf("recall text = %q, want %q", block["text"], body)
	}
}

func TestBehaviorRecallWrapsStaleContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(path, []byte("before"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	host := newHost(t, dir)

	if _, err := host.ToolResult(readResult("tc1", "f.txt", "before")); err != nil {
		t.Fatalf("tool_result: %v", err)
	}
	arc := archiveData(t, host.Entries()[0])

	if err := os.WriteFile(path, []byte("after"), 0o600); err != nil {
		t.Fatalf("rewrite file: %v", err)
	}

	result, err := host.CallTool("recall_result", "call-1", map[string]any{"pointer_id": arc.PointerID})
	if err != nil {
		t.Fatalf("recall: %v", err)
	}
	details, _ := result["details"].(map[string]any)
	if details["status"] != "invalidated" {
		t.Fatalf("want invalidated recall, got %v", details)
	}
	content, _ := result["content"].([]any)
	text := content[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "<recalled-stale-content>") || !strings.Contains(text, "before") {
		t.Fatalf("stale wrapper missing content: %q", text)
	}
}

func TestBehaviorRecallUnknownPointer(t *testing.T) {
	host := newHost(t, t.TempDir())

	result, err := host.CallTool("recall_result", "call-1", map[string]any{"pointer_id": "ptr_missing"})
	if err != nil {
		t.Fatalf("recall: %v", err)
	}
	if result["isError"] != true {
		t.Fatalf("want isError true, got %v", result["isError"])
	}
}

func TestBehaviorRecallAfterRebuildFromBranch(t *testing.T) {
	dir := t.TempDir()
	body := "alpha\nbeta"
	if err := os.WriteFile(filepath.Join(dir, "g.txt"), []byte(body), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	first := newHost(t, dir)
	if _, err := first.ToolResult(readResult("tc1", "g.txt", body)); err != nil {
		t.Fatalf("tool_result: %v", err)
	}
	entries := first.Entries()
	if len(entries) != 1 {
		t.Fatalf("want 1 archive, got %d", len(entries))
	}
	arc := archiveData(t, entries[0])

	second := newHost(t, dir)
	second.SeedBranch(entries)

	result, err := second.CallTool("recall_result", "call-1", map[string]any{"pointer_id": arc.PointerID})
	if err != nil {
		t.Fatalf("recall: %v", err)
	}
	details, _ := result["details"].(map[string]any)
	if details["status"] != "active" {
		t.Fatalf("rebuild from branch lost the archive: %v", details)
	}
}
