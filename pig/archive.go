package pig

import (
	"encoding/json"
	"strings"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// handleToolResult archives a successful result of an archive-eligible tool.
func handleToolResult(state *State, ctx sdk.Context, data map[string]any) (any, error) {
	policy, ok := policyByTool[stringValue(data["toolName"])]
	if !ok {
		return nil, nil
	}

	// Failed tool calls carry an error string, not recallable content. Skip them
	// entirely: archiving the text would line-hash the error and, for reads,
	// record the offending path as file-backed.
	if boolValue(data["isError"]) {
		return nil, nil
	}

	state.Rebuild(ctx)

	arc, ok := buildArchiveRecord(policy, decodeToolResultEvent(data), data["content"])
	if !ok {
		return nil, nil
	}
	if err := ctx.AppendEntry(ArchiveType, arc); err != nil {
		warnf("archive %s: append entry: %v", arc.ToolName, err)
		return nil, nil
	}
	state.Register(arc)
	return nil, nil
}

// buildArchiveRecord builds the archive payload for a tool result. It returns
// false when the result has no archivable content or no resolvable parameter.
func buildArchiveRecord(policy ToolPolicy, ev toolResultEvent, rawContent any) (ArchivedResult, bool) {
	content, ok := policy.ExtractContent(ev)
	if !ok {
		// No archivable content (e.g. oversized first line / empty result).
		return ArchivedResult{}, false
	}
	parameterKey, ok := policy.GetParameterKey(ev.Input)
	if !ok || parameterKey == "" {
		return ArchivedResult{}, false
	}

	// Store the raw content blocks verbatim so recall returns exactly what the
	// tool produced.
	original, err := json.Marshal(rawContent)
	if err != nil {
		return ArchivedResult{}, false
	}

	lines := strings.Split(content, "\n")
	lineHashes := make([]string, len(lines))
	for i, line := range lines {
		lineHashes[i] = GetHash(line)
	}

	return ArchivedResult{
		LineHashes:           lineHashes,
		OriginalContent:      string(original),
		ParameterKey:         parameterKey,
		PointerID:            newPointerID(),
		StalenessStrategy:    policy.StalenessStrategy,
		StartLine:            archiveStartLine(ev.Input),
		SupersessionStrategy: policy.SupersessionStrategy,
		Timestamp:            time.Now().UnixMilli(),
		ToolCallID:           ev.ToolCallID,
		ToolName:             ev.ToolName,
	}, true
}

// archiveStartLine mirrors the TypeScript `Number(input.offset) || 1` and keeps
// a fractional offset as-is.
func archiveStartLine(input map[string]any) float64 {
	if offset, ok := numberValue(input["offset"]); ok && offset != 0 {
		return offset
	}
	return 1
}
