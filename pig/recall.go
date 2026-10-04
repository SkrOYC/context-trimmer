package pig

import (
	"encoding/json"
	"strings"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

const recallDescription = "Retrieve complete or older tool result payloads from the results archive."

func recallSchema() sdk.Schema {
	return sdk.Schema{
		"type": "object",
		"properties": map[string]any{
			"pointer_id": map[string]any{
				"type":        "string",
				"description": "The pointer ID, e.g. ptr_abc123",
			},
		},
		"required": []string{"pointer_id"},
	}
}

// handleRecall returns an archive's original content, wrapping it when the
// content has since gone stale. The content blocks are returned verbatim so
// every field survives recall.
func handleRecall(state *State, ctx sdk.Context, params map[string]any) (any, error) {
	snapshot := state.Snapshot(ctx)
	pointerID, _ := params["pointer_id"].(string)

	arc, ok := snapshot.ActiveArchives[pointerID]
	if !ok {
		return errorToolResult("Error: Pointer "+pointerID+" not found in this branch.", "not_found"), nil
	}

	var blocks []map[string]any
	if err := json.Unmarshal([]byte(arc.OriginalContent), &blocks); err != nil {
		return errorToolResult("Error recalling result: "+err.Error(), "error"), nil
	}

	if CheckStaleness(arc, ctx.Cwd()) {
		parts := make([]string, len(blocks))
		for i, block := range blocks {
			if block["type"] == "text" {
				parts[i] = stringValue(block["text"])
			}
		}
		text := "<recalled-stale-content>\n" +
			"[Warning: Pointer " + pointerID + " was invalidated. Raw content is shown below verbatim]\n\n" +
			strings.Join(parts, "\n") +
			"\n\n</recalled-stale-content>"
		return map[string]any{
			"content": []any{map[string]any{"type": "text", "text": text}},
			"details": map[string]any{"status": "invalidated"},
		}, nil
	}

	return map[string]any{
		"content": blocks,
		"details": map[string]any{"status": "active"},
	}, nil
}

func errorToolResult(text, status string) map[string]any {
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": text}},
		"details": map[string]any{"status": status},
		"isError": true,
	}
}
