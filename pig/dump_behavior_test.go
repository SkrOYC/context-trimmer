package pig

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBehaviorDumpWritesCompiledContext(t *testing.T) {
	dumpPath := filepath.Join(t.TempDir(), "dump.jsonl")
	t.Setenv("PIG_TRIMMER_DUMP", dumpPath)

	host := newHost(t, t.TempDir())
	big := strings.Repeat("x", 40_000)
	if _, err := host.ToolResult(bashResult("tc1", "echo", big)); err != nil {
		t.Fatalf("first bash result: %v", err)
	}
	if _, err := host.ToolResult(bashResult("tc2", "echo", big)); err != nil {
		t.Fatalf("second bash result: %v", err)
	}
	if _, err := host.Context([]any{
		userMessage("1"),
		toolResultMessage("tc1", "bash", big),
		userMessage("2"),
		toolResultMessage("tc2", "bash", big),
	}); err != nil {
		t.Fatalf("context: %v", err)
	}

	data, err := os.ReadFile(dumpPath)
	if err != nil {
		t.Fatalf("read dump: %v", err)
	}
	line := bytes.TrimSpace(data)
	if len(line) == 0 {
		t.Fatal("dump is empty")
	}
	var record map[string]any
	if err := json.Unmarshal(line, &record); err != nil {
		t.Fatalf("decode dump: %v", err)
	}
	if record["pointers"].(float64) != 1 {
		t.Fatalf("want 1 pointer, got %v", record["pointers"])
	}
	if record["messages"].(float64) != 4 {
		t.Fatalf("want 4 messages, got %v", record["messages"])
	}
}
