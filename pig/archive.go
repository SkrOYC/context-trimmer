package pig

import (
	"encoding/json"
	"strings"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// handleToolResult archives a successful result of an archive-eligible tool.
func handleToolResult(state *State, ctx sdk.Context, data map[string]any) (any, error) {
	toolName, _ := data["toolName"].(string)
	policy, ok := policyByTool[toolName]
	if !ok {
		return nil, nil
	}

	// Failed tool calls carry an error string, not recallable content. Skip them
	// entirely: archiving the text would line-hash the error and, for reads,
	// record the offending path as file-backed.
	if isError, _ := data["isError"].(bool); isError {
		return nil, nil
	}

	state.Rebuild(ctx)

	ev := decodeToolResultEvent(data)

	content, ok := policy.ExtractContent(ev)
	if !ok {
		// No archivable content (e.g. oversized first line / empty result).
		return nil, nil
	}
	parameterKey, ok := policy.GetParameterKey(ev.Input)
	if !ok || parameterKey == "" {
		return nil, nil
	}

	// Store the raw content blocks verbatim so recall returns exactly what the
	// tool produced.
	original, err := json.Marshal(data["content"])
	if err != nil {
		warnf("archive %s: marshal content: %v", toolName, err)
		return nil, nil
	}

	lines := strings.Split(content, "\n")
	lineHashes := make([]string, len(lines))
	for i, line := range lines {
		lineHashes[i] = GetHash(line)
	}

	arc := ArchivedResult{
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
	}
	if err := ctx.AppendEntry(ArchiveType, arc); err != nil {
		warnf("archive %s: append entry: %v", toolName, err)
		return nil, nil
	}
	state.Register(arc)
	return nil, nil
}

// archiveStartLine mirrors the TypeScript `Number(input.offset) || 1`.
func archiveStartLine(input map[string]any) int {
	if offset, ok := numberValue(input["offset"]); ok && offset != 0 {
		return int(offset)
	}
	return 1
}
