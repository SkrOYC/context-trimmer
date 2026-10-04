package pig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func branchMessage(id string, message map[string]any) map[string]any {
	return map[string]any{"type": "message", "id": id, "message": message}
}

func assistantToolCallEntry(id, name string, args map[string]any) map[string]any {
	return branchMessage("a-"+id, map[string]any{
		"role":    "assistant",
		"content": []any{map[string]any{"type": "toolCall", "id": id, "name": name, "arguments": args}},
	})
}

func toolResultEntry(toolCallID, toolName, text string) map[string]any {
	return branchMessage("r-"+toolCallID, map[string]any{
		"role":       "toolResult",
		"toolCallId": toolCallID,
		"toolName":   toolName,
		"content":    []any{map[string]any{"type": "text", "text": text}},
		"isError":    false,
	})
}

// largeBody is big enough that freeing one archive clears minBatchTokens.
func largeBody() string {
	return strings.Repeat("0123456789abcdefghij\n", 2000)
}

func TestBehaviorBackfillEvictsSupersededPreExtensionRead(t *testing.T) {
	dir := t.TempDir()
	body := largeBody()
	if err := os.WriteFile(filepath.Join(dir, "big.txt"), []byte(body), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	host := newHost(t, dir)

	args := map[string]any{"path": "big.txt", "offset": 1.0, "limit": 2000.0}
	host.SeedBranch([]map[string]any{
		assistantToolCallEntry("tc1", "read", args),
		toolResultEntry("tc1", "read", body),
		assistantToolCallEntry("tc2", "read", args),
		toolResultEntry("tc2", "read", body),
	})

	result, err := host.Context([]any{
		userMessage("list"),
		toolResultMessage("tc1", "read", body),
		userMessage("again"),
		toolResultMessage("tc2", "read", body),
	})
	if err != nil {
		t.Fatalf("context: %v", err)
	}
	updated, _ := result["messages"].([]any)
	if got := contentText(updated[1].(map[string]any)); !strings.HasPrefix(got, "[Results Archive: ptr_") {
		t.Fatalf("pre-extension read was not backfilled and evicted: %q", got)
	}
	if got := contentText(updated[3].(map[string]any)); got != body {
		t.Fatalf("most recent read should stay verbatim")
	}
}

func TestBehaviorBackfillEvictsStalePreExtensionRead(t *testing.T) {
	dir := t.TempDir()
	body := largeBody()
	aPath := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(aPath, []byte(body), 0o600); err != nil {
		t.Fatalf("write a: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte(body), 0o600); err != nil {
		t.Fatalf("write b: %v", err)
	}
	host := newHost(t, dir)

	host.SeedBranch([]map[string]any{
		assistantToolCallEntry("tc1", "read", map[string]any{"path": "a.txt", "offset": 1.0, "limit": 2000.0}),
		toolResultEntry("tc1", "read", body),
		assistantToolCallEntry("tc2", "read", map[string]any{"path": "b.txt", "offset": 1.0, "limit": 2000.0}),
		toolResultEntry("tc2", "read", body),
	})
	// a.txt changes after its read, so its backfilled archive is proven stale.
	if err := os.WriteFile(aPath, []byte(strings.ReplaceAll(body, "0", "9")), 0o600); err != nil {
		t.Fatalf("rewrite a: %v", err)
	}

	result, err := host.Context([]any{
		userMessage("1"),
		toolResultMessage("tc1", "read", body),
		userMessage("2"),
		toolResultMessage("tc2", "read", body),
	})
	if err != nil {
		t.Fatalf("context: %v", err)
	}
	updated, _ := result["messages"].([]any)
	if got := contentText(updated[1].(map[string]any)); !strings.HasPrefix(got, "[Results Archive: ptr_") {
		t.Fatalf("stale pre-extension read was not evicted: %q", got)
	}
}

func TestBehaviorBackfillPointerIsStableAcrossTurns(t *testing.T) {
	dir := t.TempDir()
	body := largeBody()
	if err := os.WriteFile(filepath.Join(dir, "big.txt"), []byte(body), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	host := newHost(t, dir)

	args := map[string]any{"path": "big.txt", "offset": 1.0, "limit": 2000.0}
	host.SeedBranch([]map[string]any{
		assistantToolCallEntry("tc1", "read", args),
		toolResultEntry("tc1", "read", body),
		assistantToolCallEntry("tc2", "read", args),
		toolResultEntry("tc2", "read", body),
	})
	messages := func() []any {
		return []any{
			userMessage("1"),
			toolResultMessage("tc1", "read", body),
			userMessage("2"),
			toolResultMessage("tc2", "read", body),
		}
	}

	first, err := host.Context(messages())
	if err != nil {
		t.Fatalf("first context: %v", err)
	}
	firstStub := contentText(first["messages"].([]any)[1].(map[string]any))

	second, err := host.Context(messages())
	if err != nil {
		t.Fatalf("second context: %v", err)
	}
	secondStub := contentText(second["messages"].([]any)[1].(map[string]any))

	if firstStub != secondStub || !strings.HasPrefix(firstStub, "[Results Archive: ptr_") {
		t.Fatalf("backfill pointer not stable across turns: %q vs %q", firstStub, secondStub)
	}
}

func TestBehaviorBackfillIgnoresUnsupportedAndErroredResults(t *testing.T) {
	host := newHost(t, t.TempDir())

	host.SeedBranch([]map[string]any{
		assistantToolCallEntry("tc1", "edit", map[string]any{"path": "a.txt"}),
		toolResultEntry("tc1", "edit", "patched"),
		assistantToolCallEntry("tc2", "read", map[string]any{"path": "missing.txt", "offset": 1.0, "limit": 2000.0}),
		branchMessage("r-tc2", map[string]any{
			"role":       "toolResult",
			"toolCallId": "tc2",
			"toolName":   "read",
			"content":    []any{map[string]any{"type": "text", "text": "ENOENT: no such file"}},
			"isError":    true,
		}),
	})

	result, err := host.Context([]any{
		userMessage("1"),
		toolResultMessage("tc1", "edit", "patched"),
		userMessage("2"),
		toolResultMessage("tc2", "read", "ENOENT: no such file"),
	})
	if err != nil {
		t.Fatalf("context: %v", err)
	}
	updated, _ := result["messages"].([]any)
	for _, index := range []int{1, 3} {
		if got := contentText(updated[index].(map[string]any)); strings.HasPrefix(got, "[Results Archive: ptr_") {
			t.Fatalf("unsupported/errored result was archived and evicted: %q", got)
		}
	}
}
