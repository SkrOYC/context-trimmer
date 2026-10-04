package pig

import (
	"cmp"
	"slices"
)

// Supersession thresholds for the recency ramp.
const (
	// MinSupersessionThreshold is the threshold for the most recent reads.
	MinSupersessionThreshold = 0.25
	// MaxSupersessionThreshold is the threshold for the oldest reads.
	MaxSupersessionThreshold = 0.6
	// fullCoverage is the coverage value used for exact-key supersession.
	fullCoverage = 1
)

// ArchiveMetrics describes one archive's place in the compiled context.
type ArchiveMetrics struct {
	Coverage   float64
	Index      int
	LineCount  int
	PointerID  string
	Threshold  float64
	ToolCallID string
}

// ComputeSupersessionThreshold returns the replacement threshold for a message
// by its position in the compiled context. Recent messages are cheap to remove
// (they invalidate little KV cache suffix), so they get a low threshold; older
// messages need more cumulative overlap to justify replacement.
func ComputeSupersessionThreshold(messageIndex, totalMessages int) float64 {
	if totalMessages <= 1 {
		return MinSupersessionThreshold
	}
	// 0 = oldest, 1 = most recent.
	recencyFactor := 1 - float64(messageIndex)/float64(totalMessages-1)
	return MinSupersessionThreshold + (MaxSupersessionThreshold-MinSupersessionThreshold)*recencyFactor
}

func getArchiveRange(arc ArchivedResult) LineRange {
	return LineRange{Start: arc.StartLine, End: arc.StartLine + len(arc.LineHashes) - 1}
}

func intersectRanges(a, b LineRange) (LineRange, bool) {
	start := max(a.Start, b.Start)
	end := min(a.End, b.End)
	if start > end {
		return LineRange{}, false
	}
	return LineRange{Start: start, End: end}, true
}

func computeLineRangeCoverage(target ArchivedResult, laterReads []ArchivedResult) float64 {
	if len(target.LineHashes) == 0 {
		return 0
	}

	targetRange := getArchiveRange(target)
	overlaps := make([]LineRange, 0, len(laterReads))
	for _, read := range laterReads {
		if overlap, ok := intersectRanges(targetRange, getArchiveRange(read)); ok {
			overlaps = append(overlaps, overlap)
		}
	}

	merged := MergeIntervals(overlaps)
	return float64(TotalIntervalLength(merged)) / float64(len(target.LineHashes))
}

func getSupersessionStrategy(arc ArchivedResult) SupersessionStrategy {
	if arc.SupersessionStrategy == "" {
		return SupersessionLineRange
	}
	return arc.SupersessionStrategy
}

// ComputeCoverage returns the fraction of target superseded by later reads of
// the same group. Line-range archives compare line coverage; exact-key archives
// are fully superseded if any later read shares the group.
func ComputeCoverage(target ArchivedResult, laterReads []ArchivedResult) float64 {
	switch getSupersessionStrategy(target) {
	case SupersessionExactKey:
		if len(laterReads) > 0 {
			return fullCoverage
		}
		return 0
	case SupersessionNone:
		return 0
	default:
		return computeLineRangeCoverage(target, laterReads)
	}
}

// ComputeArchiveMetrics computes metrics for every archive that appears in the
// current compiled messages: message position, cumulative coverage by newer
// reads of the same file, and the recency-aware replacement threshold.
func ComputeArchiveMetrics(messages []map[string]any, archivesByPath map[string][]ArchivedResult) []ArchiveMetrics {
	indexByToolCallID := make(map[string]int)
	for idx, message := range messages {
		if message["role"] != "toolResult" {
			continue
		}
		if toolCallID, _ := message["toolCallId"].(string); toolCallID != "" {
			indexByToolCallID[toolCallID] = idx
		}
	}

	type indexedArchive struct {
		arc   ArchivedResult
		index int
	}

	metrics := make([]ArchiveMetrics, 0)
	for _, pathArchives := range archivesByPath {
		indexed := make([]indexedArchive, 0, len(pathArchives))
		for _, arc := range pathArchives {
			if index, ok := indexByToolCallID[arc.ToolCallID]; ok {
				indexed = append(indexed, indexedArchive{arc: arc, index: index})
			}
		}
		slices.SortStableFunc(indexed, func(a, b indexedArchive) int {
			return cmp.Compare(a.index, b.index)
		})

		for i, entry := range indexed {
			laterReads := make([]ArchivedResult, 0, len(indexed)-i-1)
			for _, later := range indexed[i+1:] {
				laterReads = append(laterReads, later.arc)
			}
			metrics = append(metrics, ArchiveMetrics{
				Coverage:   ComputeCoverage(entry.arc, laterReads),
				Index:      entry.index,
				LineCount:  len(entry.arc.LineHashes),
				PointerID:  entry.arc.PointerID,
				Threshold:  ComputeSupersessionThreshold(entry.index, len(messages)),
				ToolCallID: entry.arc.ToolCallID,
			})
		}
	}
	return metrics
}
