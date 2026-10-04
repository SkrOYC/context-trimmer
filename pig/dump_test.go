package pig

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// TestDumpContext is a one-off diagnostic: it replays the extension's backfill
// and eviction over the real session branch and prints what the compiled context
// would look like, with estimated token usage. Run with:
//
//	PI_SESSION_FILE=... go test ./pig -run TestDumpContext -v
func TestDumpContext(t *testing.T) {
	sessionFile := os.Getenv("PI_SESSION_FILE")
	if sessionFile == "" {
		t.Skip("PI_SESSION_FILE not set")
	}
	window := 1_000_000

	branch := loadBranch(t, sessionFile)

	state := NewState()
	state.rebuildLocked(branch)

	messages := make([]map[string]any, 0, len(branch))
	for _, entry := range branch {
		if entry["type"] != "message" {
			continue
		}
		if message, ok := entry["message"].(map[string]any); ok {
			messages = append(messages, message)
		}
	}

	toReplace := SelectEvictionCandidates(EvictionRequest{
		Messages:       messages,
		ArchivesByPath: state.archivesByPath,
		ActiveArchives: state.activeArchives,
		Usage:          ContextUsage{ContextWindow: window},
		Cwd:            "/home/oscar/GitHub/pi-context-trimmer",
		AlreadyEvicted: state.evictedPointers,
		Config:         DefaultEvictionConfig(),
	})

	archiveByToolCall := make(map[string]ArchivedResult, len(state.ordered))
	for _, arc := range state.ordered {
		archiveByToolCall[arc.ToolCallID] = arc
	}

	fmt.Printf("\n=== compiled context (%d messages, %d archives) ===\n", len(messages), len(state.activeArchives))
	fmt.Printf("%4s  %-10s %-7s %8s %6s  %s\n", "idx", "role", "tool", "chars", "tok", "status")

	var fullTokens, compiledTokens int
	replaced := 0
	for i, message := range messages {
		role := stringValue(message["role"])
		toolName := stringValue(message["toolName"])
		text := GetMessageText(message)
		tokens := approxTokens(text)

		status := ""
		compiled := tokens
		if role == "toolResult" {
			if arc, ok := archiveByToolCall[stringValue(message["toolCallId"])]; ok {
				if _, evicted := toReplace[arc.PointerID]; evicted {
					status = "POINTER " + arc.PointerID
					compiled = pointerTokens
					replaced++
				} else {
					status = "archived"
				}
			}
		}
		fullTokens += tokens
		compiledTokens += compiled
		fmt.Printf("%4d  %-10s %-7s %8d %6d  %s\n", i, role, toolName, len(text), tokens, status)
	}

	fmt.Printf("\nmessages: %d, replaced with pointers: %d\n", len(messages), replaced)
	fmt.Printf("estimated tokens, untrimmed: %d\n", fullTokens)
	fmt.Printf("estimated tokens, compiled (with pointers): %d\n", compiledTokens)
	fmt.Printf("estimated tokens saved: %d (%.1f%%)\n", fullTokens-compiledTokens, 100*float64(fullTokens-compiledTokens)/float64(fullTokens))
}

func loadBranch(t *testing.T, path string) []map[string]any {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open session: %v", err)
	}
	defer f.Close()

	var branch []map[string]any
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 1<<20), 128<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		if entry["type"] == nil {
			continue
		}
		branch = append(branch, entry)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan session: %v", err)
	}
	return branch
}
