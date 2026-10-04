package pig

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

var dumpMu sync.Mutex

// dumpCompiledContext appends one JSON record describing the compiled context
// when PIG_TRIMMER_DUMP names a file. It is inert otherwise, so it costs nothing
// in normal runs.
//
// The record pairs PiG's own reported usage (which does not account for the
// pointer stubs) with the extension's untrimmed and compiled token estimates, so
// the real, post-pointer context size can be compared against what PiG displays.
func dumpCompiledContext(
	path string,
	usage ContextUsage,
	messages []map[string]any,
	snapshot Snapshot,
	evicted map[string]struct{},
) {
	archiveByToolCall := make(map[string]ArchivedResult, len(snapshot.Ordered))
	for _, arc := range snapshot.Ordered {
		archiveByToolCall[arc.ToolCallID] = arc
	}

	untrimmedTokens := 0
	compiledTokens := 0
	pointers := 0
	for _, message := range messages {
		tokens := messageTokens(message)
		untrimmedTokens += tokens

		next := tokens
		if stringValue(message["role"]) == "toolResult" {
			if arc, ok := archiveByToolCall[stringValue(message["toolCallId"])]; ok {
				if _, isEvicted := evicted[arc.PointerID]; isEvicted {
					next = pointerTokens
					pointers++
				}
			}
		}
		compiledTokens += next
	}

	record := map[string]any{
		"ts":               time.Now().Format(time.RFC3339Nano),
		"pig_tokens":       deref(usage.Tokens),
		"pig_percent":      deref(usage.Percent),
		"context_window":   usage.ContextWindow,
		"messages":         len(messages),
		"archives":         len(snapshot.ActiveArchives),
		"pointers":         pointers,
		"untrimmed_tokens": untrimmedTokens,
		"compiled_tokens":  compiledTokens,
		"saved_tokens":     untrimmedTokens - compiledTokens,
	}

	data, err := json.Marshal(record)
	if err != nil {
		return
	}

	dumpMu.Lock()
	defer dumpMu.Unlock()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(data, '\n'))
}

func deref[T any](value *T) any {
	if value == nil {
		return nil
	}
	return *value
}
