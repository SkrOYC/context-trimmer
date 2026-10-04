package pig

import (
	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// handleContext runs the eviction pass and replaces evicted tool results with a
// compact pointer. It returns a new message list with only the changed messages
// rebuilt, so the SDK keeps the identity of every untouched message.
func handleContext(state *State, ctx sdk.Context, data map[string]any) (any, error) {
	rawMessages, ok := data["messages"].([]any)
	if !ok {
		return nil, nil
	}

	snapshot := state.Snapshot(ctx)

	messages := make([]map[string]any, 0, len(rawMessages))
	for _, raw := range rawMessages {
		if message, ok := raw.(map[string]any); ok {
			messages = append(messages, message)
		}
	}

	toReplace := SelectEvictionCandidates(EvictionRequest{
		Messages:       messages,
		ArchivesByPath: snapshot.ArchivesByPath,
		ActiveArchives: snapshot.ActiveArchives,
		Usage:          getEvictionContext(ctx),
		Cwd:            ctx.Cwd(),
		AlreadyEvicted: snapshot.EvictedPointers,
		Config:         DefaultEvictionConfig(),
	})
	if len(toReplace) > 0 {
		state.MarkEvicted(toReplace)
	}

	archiveByToolCallID := make(map[string]ArchivedResult, len(snapshot.ActiveArchives))
	for _, arc := range snapshot.ActiveArchives {
		archiveByToolCallID[arc.ToolCallID] = arc
	}

	updated := make([]any, len(rawMessages))
	for i, raw := range rawMessages {
		message, ok := raw.(map[string]any)
		if !ok || message["role"] != "toolResult" {
			updated[i] = raw
			continue
		}
		toolCallID, _ := message["toolCallId"].(string)
		arc, ok := archiveByToolCallID[toolCallID]
		if !ok {
			updated[i] = raw
			continue
		}
		if _, replace := toReplace[arc.PointerID]; !replace {
			updated[i] = raw
			continue
		}
		replacement := make(map[string]any, len(message)+1)
		for key, value := range message {
			replacement[key] = value
		}
		replacement["content"] = []any{
			map[string]any{"type": "text", "text": pointerStub(arc.PointerID)},
		}
		updated[i] = replacement
	}

	return map[string]any{"messages": updated}, nil
}
