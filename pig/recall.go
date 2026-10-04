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
// content has since gone stale.
func handleRecall(state *State, ctx sdk.Context, params map[string]any) (any, error) {
	snapshot := state.Snapshot(ctx)
	pointerID, _ := params["pointer_id"].(string)

	arc, ok := snapshot.ActiveArchives[pointerID]
	if !ok {
		return sdk.AgentToolResult{
			Content: []sdk.ToolResultContent{{Type: "text", Text: "Error: Pointer " + pointerID + " not found in this branch."}},
			Details: map[string]any{"status": "not_found"},
			IsError: true,
		}, nil
	}

	var original []sdk.ToolResultContent
	if err := json.Unmarshal([]byte(arc.OriginalContent), &original); err != nil {
		return sdk.AgentToolResult{
			Content: []sdk.ToolResultContent{{Type: "text", Text: "Error recalling result: " + err.Error()}},
			Details: map[string]any{"status": "error"},
			IsError: true,
		}, nil
	}

	if CheckStaleness(arc, ctx.Cwd()) {
		parts := make([]string, len(original))
		for i, block := range original {
			if block.Type == "text" {
				parts[i] = block.Text
			}
		}
		text := "<recalled-stale-content>\n" +
			"[Warning: Pointer " + pointerID + " was invalidated. Raw content is shown below verbatim]\n\n" +
			strings.Join(parts, "\n") +
			"\n\n</recalled-stale-content>"
		return sdk.AgentToolResult{
			Content: []sdk.ToolResultContent{{Type: "text", Text: text}},
			Details: map[string]any{"status": "invalidated"},
		}, nil
	}

	return sdk.AgentToolResult{
		Content: original,
		Details: map[string]any{"status": "active"},
	}, nil
}
