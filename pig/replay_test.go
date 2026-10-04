package pig

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// Real-transcript replay harness. It walks the branch turn by turn (a turn is a
// provider request, marked by an assistant message with usage), runs the exact
// eviction logic under a candidate config, and accumulates a cache-aware cost.
//
// The fixture is the real session branch: set PIG_REPLAY_FIXTURE, or it falls
// back to PI_SESSION_FILE. Nothing is persisted; it is read-only analysis.

const approxCharsPerTokenReplay = 4.0

type replayMetrics struct {
	config            string
	untrimmedTokens   int
	compiledTokens    int
	savedTokens       int
	invalidations     int
	invalidatedTokens int
	overflowTurns     int
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
	backfillCache      map[string]ArchivedResult
	staleByPointer     map[string]bool
	cwd                string
	window             int
	inputPrice         float64
	cacheReadPrice     float64
}

func TestReplaySweep(t *testing.T) {
	fixture := os.Getenv("PIG_REPLAY_FIXTURE")
	if fixture == "" {
		t.Skip("set PIG_REPLAY_FIXTURE to a session branch to run the replay sweep")
	}
	cwd := "/home/oscar/GitHub/pi-context-trimmer"

	branch := loadBranch(t, fixture)
	base := buildReplayInput(branch, cwd)
	if len(base.points) == 0 {
		t.Skip("no provider turns in fixture")
	}
	base.inputPrice = envFloat("PIG_REPLAY_INPUT_PRICE", 0.15) / 1_000_000
	base.cacheReadPrice = envFloat("PIG_REPLAY_CACHE_READ_PRICE", 0.003) / 1_000_000

	for _, window := range replayWindows() {
		input := base
		input.window = window

		baseline := replayConfig(input, DefaultEvictionConfig(), true)
		baseline.config = "no-trim"

		results := []replayMetrics{baseline}
		for _, cfg := range configGrid() {
			results = append(results, replayConfig(input, cfg, false))
		}
		sort.SliceStable(results, func(i, j int) bool {
			return results[i].netSavings > results[j].netSavings
		})

		fmt.Printf("\n===== window = %d (peak real ctx %d, overflow turns in baseline %d) =====\n",
			window, peakRealTokens(input), baseline.overflowTurns)
		fmt.Printf("%-26s %9s %9s %6s %10s %10s %9s %9s\n",
			"config", "savedTok", "inval", "ovf", "invalTok", "netSave$", "deadTok", "validTok")
		for _, r := range results {
			fmt.Printf("%-26s %9d %9d %6d %10d %10.4f %9d %9d\n",
				r.config, r.savedTokens, r.invalidations, r.overflowTurns,
				r.invalidatedTokens, r.netSavings, r.deadSavedTokens, r.validSavedTokens)
		}
	}
}

func peakRealTokens(in replayInput) int {
	peak := 0
	for _, tokens := range in.realTokens {
		if tokens > peak {
			peak = tokens
		}
	}
	return peak
}

func buildReplayInput(branch []map[string]any, cwd string) replayInput {
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
	staleByPointer := make(map[string]bool, len(full.activeArchives))
	for _, arc := range full.activeArchives {
		dead[arc.PointerID] = isProvenDead(arc, full)
		contentChars[arc.PointerID] = toolResultContentChars(arc.OriginalContent)
		pointerForToolCall[arc.ToolCallID] = arc.PointerID
		staleByPointer[arc.PointerID] = CheckStaleness(arc, cwd)
	}
	if os.Getenv("PIG_REPLAY_DEBUG") != "" {
		deadCount, totalChars := 0, 0
		for _, isDead := range dead {
			if isDead {
				deadCount++
			}
		}
		for _, chars := range contentChars {
			totalChars += chars
		}
		fmt.Printf("fixture: archives=%d dead=%d contentChars=%d (approx %d tok)\n",
			len(full.activeArchives), deadCount, totalChars, totalChars/4)
	}

	return replayInput{
		branch: branch, messages: messages, points: points, prefixEnds: prefixEnds,
		realTokens: realTokens,
		msgChars:   msgChars, msgCharPrefix: msgCharPrefix,
		dead: dead, contentChars: contentChars, pointerForToolCall: pointerForToolCall,
		backfillCache:  full.backfillCache,
		staleByPointer: staleByPointer,
		cwd:            cwd,
	}
}

func replayConfig(in replayInput, config EvictionConfig, noTrim bool) replayMetrics {
	m := replayMetrics{config: configName(config)}
	state := NewState()
	state.backfillCache = in.backfillCache
	evicted := make(map[string]struct{})
	prevEvicted := make(map[string]struct{})
	prevCount := 0

	for k, point := range in.points {
		contextMessages := in.messages[:point]
		state.rebuildLocked(in.branch[:in.prefixEnds[k]])

		realTokens := in.realTokens[k]
		if realTokens > in.window {
			m.overflowTurns++
		}

		toReplace := make(map[string]struct{})
		if !noTrim {
			toReplace = SelectEvictionCandidates(EvictionRequest{
				Messages:          contextMessages,
				ArchivesByPath:    state.archivesByPath,
				ActiveArchives:    state.activeArchives,
				Usage:             ContextUsage{ContextWindow: in.window, Tokens: &realTokens},
				Cwd:               in.cwd,
				AlreadyEvicted:    evicted,
				Config:            config,
				StalenessOverride: in.staleByPointer,
			})
		}

		if os.Getenv("PIG_REPLAY_DEBUG") != "" && realTokens > 130_000 {
			fmt.Printf("turn=%3d point=%3d arch=%3d replace=%3d realTok=%d\n", k, point, len(state.activeArchives), len(toReplace), realTokens)
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
		m.contextCost += newTokens*in.inputPrice + cachedTokens*in.cacheReadPrice

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

	lastTokens := 0
	for _, point := range in.points {
		compiledTokens := float64(in.msgCharPrefix[point]) / approxCharsPerTokenReplay
		newTokens := compiledTokens - float64(lastTokens)
		if newTokens < 0 {
			newTokens = 0
		}
		m.baselineCost += newTokens*in.inputPrice + (compiledTokens-newTokens)*in.cacheReadPrice
		lastTokens = int(compiledTokens)
	}

	m.netSavings = m.baselineCost - m.contextCost
	return m
}

func envFloat(name string, fallback float64) float64 {
	if value := os.Getenv(name); value != "" {
		if parsed, err := strconv.ParseFloat(value, 64); err == nil {
			return parsed
		}
	}
	return fallback
}

func replayWindows() []int {
	if value := os.Getenv("PIG_REPLAY_WINDOWS"); value != "" {
		var out []int
		for _, part := range strings.Split(value, ",") {
			if parsed, err := strconv.Atoi(strings.TrimSpace(part)); err == nil {
				out = append(out, parsed)
			}
		}
		return out
	}
	return []int{200_000, 500_000, 1_000_000}
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
	return fmt.Sprintf("thr=%.2f aff=%.2f batch=%d",
		config.Threshold, config.Weights.Affordability, config.MinBatchTokens)
}

// withAffordability sets the affordability share and rescales the other weights
// so the shares still sum to 1.
func withAffordability(base EvictionConfig, afford float64) EvictionConfig {
	w := base.Weights
	sum := w.Coldness + w.Pressure + w.Semantic + w.Size + w.Staleness + w.Supersession
	rest := 1 - afford
	w.Affordability = afford
	w.Coldness = w.Coldness / sum * rest
	w.Pressure = w.Pressure / sum * rest
	w.Semantic = w.Semantic / sum * rest
	w.Size = w.Size / sum * rest
	w.Staleness = w.Staleness / sum * rest
	w.Supersession = w.Supersession / sum * rest
	base.Weights = w
	return base
}

func configGrid() []EvictionConfig {
	if os.Getenv("PIG_REPLAY_ONE") != "" {
		config := DefaultEvictionConfig()
		config.Threshold = 0.3
		config.MinBatchTokens = 0
		return []EvictionConfig{config}
	}
	var out []EvictionConfig
	for _, threshold := range []float64{0.1, 0.2, 0.3, 0.4, 0.5} {
		for _, afford := range []float64{0.1, 0.2, 0.3} {
			for _, batch := range []int{0, 2000, 8000} {
				config := withAffordability(DefaultEvictionConfig(), afford)
				config.Threshold = threshold
				config.MinBatchTokens = batch
				out = append(out, config)
			}
		}
	}
	return out
}
