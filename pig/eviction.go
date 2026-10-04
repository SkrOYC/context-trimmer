package pig

import (
	"cmp"
	"math"
	"slices"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// ContextUsage is the slice of getContextUsage the eviction gate consumes.
type ContextUsage struct {
	ContextWindow int
	Percent       *float64
	Tokens        *int
}

// EvictionWeights are the normalized shares of the eviction score. They sum to 1.
type EvictionWeights struct {
	Affordability float64
	Coldness      float64
	Pressure      float64
	Semantic      float64
	Size          float64
	Staleness     float64
	Supersession  float64
}

// EvictionConfig holds the aggressiveness knobs of the eviction pass. The
// aggressiveness knobs (threshold, pressure knees, minBatchTokens) are set by
// principle, not fit to a benchmark; the weight shares and per-tool semantics
// are the tunable surface.
type EvictionConfig struct {
	// ImmutableStalenessConfidence discounts assumed staleness of immutable tools.
	ImmutableStalenessConfidence float64
	// MinBatchTokens is the freed-token floor before an eviction event fires.
	MinBatchTokens int
	// OverflowGuardFraction forces a batch even if small once reached.
	OverflowGuardFraction float64
	// PressureAbsoluteKnee is an absolute token count for the pressure ramp.
	PressureAbsoluteKnee int
	// PressurePercentKnee is a fraction of the window for the pressure ramp.
	PressurePercentKnee float64
	// SemanticByTool is the per-tool disposability (higher = safer to evict).
	SemanticByTool map[string]float64
	// Threshold is the weighted-score bar for still-valid content.
	Threshold float64
	// Weights are the score shares.
	Weights EvictionWeights
}

// DefaultEvictionConfig returns the principle-set defaults.
func DefaultEvictionConfig() EvictionConfig {
	return EvictionConfig{
		ImmutableStalenessConfidence: 0.4,
		MinBatchTokens:               8000,
		OverflowGuardFraction:        0.9,
		PressureAbsoluteKnee:         130_000,
		PressurePercentKnee:          0.6,
		SemanticByTool:               map[string]float64{"bash": 0.55, "find": 0.5, "grep": 0.5, "ls": 0.6, "read": 0.3},
		Threshold:                    0.6,
		Weights: EvictionWeights{
			Affordability: 0.1,
			Coldness:      0.15,
			Pressure:      0.3,
			Semantic:      0.15,
			Size:          0.15,
			Staleness:     0.075,
			Supersession:  0.075,
		},
	}
}

const defaultSemantic = 0.5

const pointerStubSample = "[Results Archive: ptr_xxxxxxxx (Invalidated - Stale)]"

var pointerTokens = approxTokens(pointerStubSample)

func pointerStub(pointerID string) string {
	return "[Results Archive: " + pointerID + " (Invalidated - Stale)]"
}

func getEvictionContext(ctx sdk.Context) ContextUsage {
	usage, err := ctx.GetContextUsage()
	if err != nil || usage == nil {
		return ContextUsage{}
	}
	return ContextUsage{ContextWindow: usage.ContextWindow, Percent: usage.Percent, Tokens: usage.Tokens}
}

func messageTokens(message map[string]any) int {
	return approxTokens(GetMessageText(message))
}

func clamp01(value float64) float64 {
	return math.Max(0, math.Min(1, value))
}

func ramp(value, knee, ceiling float64) float64 {
	if ceiling <= knee {
		if value >= ceiling {
			return 1
		}
		return 0
	}
	return clamp01((value - knee) / (ceiling - knee))
}

// EvictionSignals is one candidate's normalized evidence, each in [0, 1].
type EvictionSignals struct {
	Affordability float64
	Coldness      float64
	Pressure      float64
	Semantic      float64
	Size          float64
	Staleness     float64
	Supersession  float64
}

// ScoreFromSignals returns the weighted sum of the signals.
func ScoreFromSignals(signals EvictionSignals, weights EvictionWeights) float64 {
	return weights.Affordability*signals.Affordability +
		weights.Coldness*signals.Coldness +
		weights.Pressure*signals.Pressure +
		weights.Semantic*signals.Semantic +
		weights.Size*signals.Size +
		weights.Staleness*signals.Staleness +
		weights.Supersession*signals.Supersession
}

type candidate struct {
	index       int
	pointerID   string
	provenDead  bool
	savedTokens int
	signals     EvictionSignals
	tokens      int
}

type candidateContext struct {
	activeArchives     map[string]ArchivedResult
	ageSpan            int
	compiledTokens     int
	config             EvictionConfig
	maxCandidateTokens int
	mostRecentIndex    int
	pressure           float64
	staleByPointer     map[string]bool
	tokensByIndex      []int
}

// EvictionRequest is one context-compilation eviction pass.
type EvictionRequest struct {
	Messages          []map[string]any
	ArchivesByPath    map[string][]ArchivedResult
	ActiveArchives    map[string]ArchivedResult
	Usage             ContextUsage
	Cwd               string
	AlreadyEvicted    map[string]struct{}
	Config            EvictionConfig
	StalenessOverride map[string]bool
}

// collectEligible applies the cap: provably-dead content is always eligible;
// still-valid content needs genuine pressure and a weighted score over the
// threshold. The co-location pass then re-scores the suffix after the oldest
// removal with affordability 1 (that suffix is a cache miss anyway).
func collectEligible(candidates []candidate, pressure float64, config EvictionConfig) []candidate {
	underPressure := pressure > 0
	isEligible := func(c candidate, signals EvictionSignals) bool {
		return c.provenDead ||
			(underPressure && ScoreFromSignals(signals, config.Weights) >= config.Threshold)
	}

	firstRemovalIndex := 0
	hasFirstRemoval := false
	for _, c := range candidates {
		if !isEligible(c, c.signals) {
			continue
		}
		if !hasFirstRemoval || c.index < firstRemovalIndex {
			firstRemovalIndex = c.index
			hasFirstRemoval = true
		}
	}

	eligible := make([]candidate, 0, len(candidates))
	for _, c := range candidates {
		signals := c.signals
		if hasFirstRemoval && c.index > firstRemovalIndex {
			signals.Affordability = 1
		}
		if isEligible(c, signals) {
			eligible = append(eligible, c)
		}
	}
	return eligible
}

func buildCandidate(m ArchiveMetrics, ctx candidateContext) candidate {
	arc, hasArc := ctx.activeArchives[m.PointerID]
	tokens := 0
	if m.Index >= 0 && m.Index < len(ctx.tokensByIndex) {
		tokens = ctx.tokensByIndex[m.Index]
	}

	supersession := 0.0
	if m.Threshold > 0 {
		supersession = clamp01(m.Coverage / m.Threshold)
	}

	proven := !hasArc || arc.StalenessStrategy != StalenessImmutable
	rawStale := ctx.staleByPointer[m.PointerID]
	provenStaleness := ctx.config.ImmutableStalenessConfidence
	if proven {
		provenStaleness = 1
	}
	staleness := 0.0
	if rawStale {
		staleness = provenStaleness
	}

	coldness := float64(ctx.mostRecentIndex-m.Index) / float64(ctx.ageSpan)
	size := float64(tokens) / float64(ctx.maxCandidateTokens)

	// Suffix tokens after this message; a shorter suffix is cheaper to invalidate.
	suffixTokens := 0
	for i := m.Index + 1; i < len(ctx.tokensByIndex); i++ {
		suffixTokens += ctx.tokensByIndex[i]
	}
	affordability := 1.0
	if ctx.compiledTokens > 0 {
		affordability = clamp01(1 - float64(suffixTokens)/float64(ctx.compiledTokens))
	}

	semantic := defaultSemantic
	if hasArc {
		if value, ok := ctx.config.SemanticByTool[arc.ToolName]; ok {
			semantic = value
		}
	}

	// Proven-dead = a newer copy of the exact content exists, or a read whose file
	// has provably changed on disk. Assumed staleness on immutable tools does not
	// count as proven.
	provenDead := supersession >= 1 || (proven && rawStale)

	savedTokens := tokens - pointerTokens
	if savedTokens < 0 {
		savedTokens = 0
	}

	return candidate{
		index:       m.Index,
		pointerID:   m.PointerID,
		provenDead:  provenDead,
		savedTokens: savedTokens,
		signals: EvictionSignals{
			Affordability: affordability,
			Coldness:      coldness,
			Pressure:      ctx.pressure,
			Semantic:      semantic,
			Size:          size,
			Staleness:     staleness,
			Supersession:  supersession,
		},
		tokens: tokens,
	}
}

// SelectEvictionCandidates selects the full set of archive pointers to replace
// this turn. Eviction is append-only: the returned set is always a superset of
// alreadyEvicted, and the single most recently archived result is always
// protected.
func SelectEvictionCandidates(request EvictionRequest) map[string]struct{} {
	evicted := make(map[string]struct{}, len(request.AlreadyEvicted))
	for pointerID := range request.AlreadyEvicted {
		evicted[pointerID] = struct{}{}
	}

	window := request.Usage.ContextWindow
	if window <= 0 {
		return evicted
	}

	metrics := ComputeArchiveMetrics(request.Messages, request.ArchivesByPath)
	slices.SortStableFunc(metrics, func(a, b ArchiveMetrics) int {
		return cmp.Compare(a.Index, b.Index)
	})
	if len(metrics) == 0 {
		return evicted
	}

	tokensByIndex := make([]int, len(request.Messages))
	for i, message := range request.Messages {
		tokensByIndex[i] = messageTokens(message)
	}

	// Compiled size counts already-evicted archives as their pointer stub.
	evictedIndices := make(map[int]struct{})
	for _, m := range metrics {
		if _, ok := evicted[m.PointerID]; ok {
			evictedIndices[m.Index] = struct{}{}
		}
	}
	compiledTokens := 0
	for i, tokens := range tokensByIndex {
		if _, ok := evictedIndices[i]; ok {
			compiledTokens += pointerTokens
		} else {
			compiledTokens += tokens
		}
	}

	// Pressure is shared by every candidate this turn: the higher of the percent
	// ramp and the absolute-token ramp.
	pressure := math.Max(
		ramp(float64(compiledTokens)/float64(window), request.Config.PressurePercentKnee, 1),
		ramp(float64(compiledTokens), float64(request.Config.PressureAbsoluteKnee), float64(window)),
	)

	mostRecentIndex := -1
	for _, m := range metrics {
		if m.Index > mostRecentIndex {
			mostRecentIndex = m.Index
		}
	}

	candidateMetrics := make([]ArchiveMetrics, 0, len(metrics))
	for _, m := range metrics {
		if _, ok := evicted[m.PointerID]; ok {
			continue
		}
		if m.Index == mostRecentIndex {
			continue
		}
		candidateMetrics = append(candidateMetrics, m)
	}
	if len(candidateMetrics) == 0 {
		return evicted
	}

	candidateArchives := make([]ArchivedResult, 0, len(candidateMetrics))
	for _, m := range candidateMetrics {
		if arc, ok := request.ActiveArchives[m.PointerID]; ok {
			candidateArchives = append(candidateArchives, arc)
		}
	}
	staleByPointer := request.StalenessOverride
	if staleByPointer == nil {
		staleByPointer = CheckStalenessBatch(candidateArchives, request.Cwd)
	}

	oldestIndex := candidateMetrics[0].Index
	for _, m := range candidateMetrics[1:] {
		if m.Index < oldestIndex {
			oldestIndex = m.Index
		}
	}
	ageSpan := max(1, mostRecentIndex-oldestIndex)

	maxCandidateTokens := 1
	for _, m := range candidateMetrics {
		if tokens := tokensByIndex[m.Index]; tokens > maxCandidateTokens {
			maxCandidateTokens = tokens
		}
	}

	candidates := make([]candidate, 0, len(candidateMetrics))
	for _, m := range candidateMetrics {
		candidates = append(candidates, buildCandidate(m, candidateContext{
			activeArchives:     request.ActiveArchives,
			ageSpan:            ageSpan,
			compiledTokens:     compiledTokens,
			config:             request.Config,
			maxCandidateTokens: maxCandidateTokens,
			mostRecentIndex:    mostRecentIndex,
			pressure:           pressure,
			staleByPointer:     staleByPointer,
			tokensByIndex:      tokensByIndex,
		}))
	}

	eligible := collectEligible(candidates, pressure, request.Config)
	if len(eligible) == 0 {
		return evicted
	}

	freeTokens := 0
	for _, c := range eligible {
		freeTokens += c.savedTokens
	}
	mustEvict := float64(compiledTokens) >= float64(window)*request.Config.OverflowGuardFraction

	// Batch: hold small removals until enough mass accumulates, unless we are up
	// against the window.
	if freeTokens < request.Config.MinBatchTokens && !mustEvict {
		return evicted
	}

	for _, c := range eligible {
		evicted[c.pointerID] = struct{}{}
	}
	return evicted
}
