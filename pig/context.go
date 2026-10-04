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

	// Keep one slot per raw message so eviction indices line up with the list the
	// replacement loop iterates; a non-object entry is a zero-token message.
	messages := make([]map[string]any, len(rawMessages))
	for i, raw := range rawMessages {
		messages[i], _ = raw.(map[string]any)
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

	// Union with the live set so a pointer evicted by a concurrent context pass
	// is still stubbed in this response.
	evicted := state.EvictedPointers()
	for pointerID := range toReplace {
		evicted[pointerID] = struct{}{}
	}

	// Build the tool-call reverse index in registration order so a duplicate
	// toolCallId resolves to the last-registered archive deterministically.
	archiveByToolCallID := make(map[string]ArchivedResult, len(snapshot.Ordered))
	for _, arc := range snapshot.Ordered {
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
		if _, replace := evicted[arc.PointerID]; !replace {
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
