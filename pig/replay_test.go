package pig

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"testing"
)

// Real-transcript replay harness. It walks the branch turn by turn (a turn is a
// provider request, marked by an assistant message with usage), runs the exact
// eviction logic under a candidate config, and accumulates a cache-aware cost.
//
// The fixture is the real session branch: set PIG_REPLAY_FIXTURE, or it falls
// back to PI_SESSION_FILE. Nothing is persisted; it is read-only analysis.

const (
	approxCharsPerTokenReplay = 4.0
	inputPricePerToken        = 0.15 / 1_000_000
	cacheReadPricePerToken    = 0.003 / 1_000_000
)

type replayMetrics struct {
	config            string
	untrimmedTokens   int
	compiledTokens    int
	savedTokens       int
	invalidations     int
	invalidatedTokens int
	contextCost       float64
	baselineCost      float64
	netSavings        float64
	deadSavedTokens   int
	validSavedTokens  int
}

type replayInput struct {
	branch             []map[string]any
	messages           []map[string]any
	points             []int // message index of each provider request
	prefixEnds         []int // branch index of each provider request
	realTokens         []int // provider-reported context tokens per request
	msgChars           []int
	msgCharPrefix      []int // prefix sums of msgChars
	dead               map[string]bool
	contentChars       map[string]int
	pointerForToolCall map[string]string
	cwd                string
	window             int
}

func TestReplaySweep(t *testing.T) {
	fixture := os.Getenv("PIG_REPLAY_FIXTURE")
	if fixture == "" {
		fixture = os.Getenv("PI_SESSION_FILE")
	}
	if fixture == "" {
		t.Skip("set PIG_REPLAY_FIXTURE or PI_SESSION_FILE")
	}
	cwd := "/home/oscar/GitHub/pi-context-trimmer"
	window := 1_000_000

	branch := loadBranch(t, fixture)
	input := buildReplayInput(branch, cwd, window)
	if len(input.points) == 0 {
		t.Skip("no provider turns in fixture")
	}

	baseline := replayConfig(input, DefaultEvictionConfig(), true)
	baseline.config = "baseline (no trim)"

	results := []replayMetrics{baseline}
	for _, cfg := range configGrid() {
		results = append(results, replayConfig(input, cfg, false))
	}
	sort.SliceStable(results, func(i, j int) bool {
		return results[i].netSavings > results[j].netSavings
	})

	fmt.Printf("\n%-34s %10s %10s %9s %6s %10s %10s %9s %9s\n",
		"config", "untrim", "compiled", "saved", "inval", "invalTok", "netSave$", "deadTok", "validTok")
	for _, r := range results {
		fmt.Printf("%-34s %10d %10d %9d %6d %10d %10.4f %9d %9d\n",
			r.config, r.untrimmedTokens, r.compiledTokens, r.savedTokens,
			r.invalidations, r.invalidatedTokens, r.netSavings, r.deadSavedTokens, r.validSavedTokens)
	}
}

func buildReplayInput(branch []map[string]any, cwd string, window int) replayInput {
	messages := make([]map[string]any, 0, len(branch))
	points := make([]int, 0)
	prefixEnds := make([]int, 0)
	realTokens := make([]int, 0)
	for i, entry := range branch {
		if entry["type"] != "message" {
			continue
		}
		message, ok := entry["message"].(map[string]any)
		if !ok {
			continue
		}
		if stringValue(message["role"]) == "assistant" {
			if usage, ok := message["usage"].(map[string]any); ok {
				points = append(points, len(messages))
				prefixEnds = append(prefixEnds, i+1)
				realTokens = append(realTokens, contextTokensFromUsage(usage))
			}
		}
		messages = append(messages, message)
	}

	msgChars := make([]int, len(messages))
	msgCharPrefix := make([]int, len(messages)+1)
	for i, message := range messages {
		msgChars[i] = messageAllChars(message)
		msgCharPrefix[i+1] = msgCharPrefix[i] + msgChars[i]
	}

	full := NewState()
	full.rebuildLocked(branch)
	dead := make(map[string]bool, len(full.activeArchives))
	contentChars := make(map[string]int, len(full.activeArchives))
	pointerForToolCall := make(map[string]string, len(full.activeArchives))
	for _, arc := range full.activeArchives {
		dead[arc.PointerID] = isProvenDead(arc, full)
		contentChars[arc.PointerID] = toolResultContentChars(arc.OriginalContent)
		pointerForToolCall[arc.ToolCallID] = arc.PointerID
	}

	return replayInput{
		branch: branch, messages: messages, points: points, prefixEnds: prefixEnds,
		realTokens: realTokens,
		msgChars:   msgChars, msgCharPrefix: msgCharPrefix,
		dead: dead, contentChars: contentChars, pointerForToolCall: pointerForToolCall,
		cwd: cwd, window: window,
	}
}

func replayConfig(in replayInput, config EvictionConfig, noTrim bool) replayMetrics {
	debug := os.Getenv("PIG_REPLAY_DEBUG") != ""
	m := replayMetrics{config: configName(config)}
	state := NewState()
	evicted := make(map[string]struct{})
	prevEvicted := make(map[string]struct{})
	prevCount := 0

	for k, point := range in.points {
		contextMessages := in.messages[:point]
		state.rebuildLocked(in.branch[:in.prefixEnds[k]])

		realTokens := in.realTokens[k]
		toReplace := make(map[string]struct{})
		if !noTrim {
			toReplace = SelectEvictionCandidates(EvictionRequest{
				Messages:       contextMessages,
				ArchivesByPath: state.archivesByPath,
				ActiveArchives: state.activeArchives,
				Usage:          ContextUsage{ContextWindow: in.window, Tokens: &realTokens},
				Cwd:            in.cwd,
				AlreadyEvicted: evicted,
				Config:         config,
			})
		}

		untrimmedChars := in.msgCharPrefix[point]
		compiledChars := 0
		compiledByIndex := make([]int, point)
		firstChange := -1
		for i := 0; i < point; i++ {
			chars := in.msgChars[i]
			if pointer, ok := in.pointerForToolCall[stringValue(in.messages[i]["toolCallId"])]; ok {
				if _, ev := toReplace[pointer]; ev {
					chars = chars - in.contentChars[pointer] + len(pointerStub(pointer))
					if _, was := prevEvicted[pointer]; !was && firstChange < 0 {
						firstChange = i
					}
				}
			}
			compiledByIndex[i] = chars
			compiledChars += chars
		}
		if firstChange < 0 {
			firstChange = prevCount
		}
		if firstChange > point {
			firstChange = point
		}
		invalidatedChars := 0
		for i := firstChange; i < point; i++ {
			invalidatedChars += compiledByIndex[i]
		}
		if firstChange < prevCount {
			m.invalidations++
		}

		newTokens := float64(invalidatedChars) / approxCharsPerTokenReplay
		compiledTokens := float64(compiledChars) / approxCharsPerTokenReplay
		cachedTokens := compiledTokens - newTokens
		if cachedTokens < 0 {
			cachedTokens = 0
		}
		m.contextCost += newTokens*inputPricePerToken + cachedTokens*cacheReadPricePerToken

		if debug && k < 40 {
			newCount := 0
			for p := range toReplace {
				if _, was := prevEvicted[p]; !was {
					newCount++
				}
			}
			fmt.Printf("turn=%3d point=%3d prev=%3d arch=%3d realTok=%d replace=%3d new=%2d first=%3d compTok=%d\n", k, point, prevCount, len(state.activeArchives), realTokens, len(toReplace), newCount, firstChange, int(compiledTokens))
		}

		m.untrimmedTokens += int(float64(untrimmedChars) / approxCharsPerTokenReplay)
		m.compiledTokens += int(compiledTokens)
		m.savedTokens += int((float64(untrimmedChars) - float64(compiledChars)) / approxCharsPerTokenReplay)
		m.invalidatedTokens += int(newTokens)

		for pointer := range toReplace {
			if _, was := prevEvicted[pointer]; was {
				continue
			}
			tokens := in.contentChars[pointer] / int(approxCharsPerTokenReplay)
			if in.dead[pointer] {
				m.deadSavedTokens += tokens
			} else {
				m.validSavedTokens += tokens
			}
		}

		evicted = toReplace
		prevEvicted = copySet(toReplace)
		prevCount = point
	}

	// Baseline: no replacements; the cache only grows with new messages.
	lastTokens := 0
	for _, point := range in.points {
		compiledTokens := float64(in.msgCharPrefix[point]) / approxCharsPerTokenReplay
		newTokens := compiledTokens - float64(lastTokens)
		if newTokens < 0 {
			newTokens = 0
		}
		m.baselineCost += newTokens*inputPricePerToken + (compiledTokens-newTokens)*cacheReadPricePerToken
		lastTokens = int(compiledTokens)
	}

	m.netSavings = m.baselineCost - m.contextCost
	return m
}

func contextTokensFromUsage(usage map[string]any) int {
	total := 0
	for _, key := range []string{"input", "cacheRead", "cacheWrite"} {
		if value, ok := numberValue(usage[key]); ok {
			total += int(value)
		}
	}
	return total
}

func isProvenDead(arc ArchivedResult, state *State) bool {
	if isFileBacked(arc) && CheckStaleness(arc, "/home/oscar/GitHub/pi-context-trimmer") {
		return true
	}
	list := state.archivesByPath[ArchiveGroupKey(arc.ToolName, arc.ParameterKey)]
	for i := range list {
		if list[i].PointerID == arc.PointerID {
			return i < len(list)-1
		}
	}
	return false
}

func messageAllChars(message map[string]any) int {
	raw, err := json.Marshal(message)
	if err != nil {
		return 0
	}
	return len(raw)
}

func toolResultContentChars(originalContent string) int {
	var blocks []map[string]any
	if json.Unmarshal([]byte(originalContent), &blocks) != nil {
		return 0
	}
	total := 0
	for _, block := range blocks {
		total += len(stringValue(block["text"]))
	}
	return total
}

func copySet(in map[string]struct{}) map[string]struct{} {
	out := make(map[string]struct{}, len(in))
	for k := range in {
		out[k] = struct{}{}
	}
	return out
}

func configName(config EvictionConfig) string {
	return fmt.Sprintf("thr=%.2f batch=%d pk=%.2f ak=%d",
		config.Threshold, config.MinBatchTokens, config.PressurePercentKnee, config.PressureAbsoluteKnee)
}

func configGrid() []EvictionConfig {
	if os.Getenv("PIG_REPLAY_DEBUG") != "" {
		return []EvictionConfig{DefaultEvictionConfig()}
	}
	var out []EvictionConfig
	for _, threshold := range []float64{0.4, 0.5, 0.6, 0.7} {
		for _, batch := range []int{2000, 4000, 8000, 16000} {
			for _, percentKnee := range []float64{0.3, 0.45, 0.6} {
				for _, absoluteKnee := range []int{65_000, 130_000} {
					config := DefaultEvictionConfig()
					config.Threshold = threshold
					config.MinBatchTokens = batch
					config.PressurePercentKnee = percentKnee
					config.PressureAbsoluteKnee = absoluteKnee
					out = append(out, config)
				}
			}
		}
	}
	return out
}
