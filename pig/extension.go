// Package pig is a PiG-native port of the pi-context-trimmer extension. It
// archives large tool results, replaces stale or superseded content with compact
// pointers when the context is compiled, and exposes a recall_result tool.
package pig

import (
	"log"
	"os"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

var logger = log.New(os.Stderr, "[Context Trimmer] ", log.LstdFlags)

func warnf(format string, args ...any) {
	logger.Printf(format, args...)
}

// Extension builds the PiG extension. PiG's generated runner imports this
// package and calls Extension.
func Extension() *sdk.Extension {
	ext := sdk.New("pig")
	state := NewState()

	rebuild := func(ctx sdk.Context, _ map[string]any) (any, error) {
		state.Rebuild(ctx)
		return nil, nil
	}
	ext.OnSessionStart(rebuild)
	ext.OnEvent(sdk.EventSessionTree, rebuild)

	ext.OnToolResult(func(ctx sdk.Context, data map[string]any) (any, error) {
		return handleToolResult(state, ctx, data)
	})
	ext.OnEvent(sdk.EventContext, func(ctx sdk.Context, data map[string]any) (any, error) {
		return handleContext(state, ctx, data)
	})
	ext.Tool("recall_result", recallDescription, recallSchema(), func(ctx sdk.Context, params map[string]any) (any, error) {
		return handleRecall(state, ctx, params)
	})

	return ext
}
