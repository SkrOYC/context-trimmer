package pig

import (
	"cmp"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// approxCharsPerToken is the divisor used to estimate tokens from text length.
const approxCharsPerToken = 4

// GetHash returns the SHA-256 hex digest of s.
func GetHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

const pointerAlphabet = "0123456789abcdefghijklmnopqrstuvwxyz"

// newPointerID returns a fresh `ptr_` identifier, mirroring the TypeScript
// extension's `ptr_` + 8 base36 characters.
func newPointerID() string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		n := time.Now().UnixNano()
		for i := range raw {
			raw[i] = byte(n >> (8 * i))
		}
	}
	id := make([]byte, len(raw))
	for i, b := range raw {
		id[i] = pointerAlphabet[int(b)%len(pointerAlphabet)]
	}
	return "ptr_" + string(id)
}

// approxTokens estimates a token count from text length.
func approxTokens(text string) int {
	return (utf8.RuneCountInString(text) + approxCharsPerToken - 1) / approxCharsPerToken
}

func joinTextContentAny(parts []any) string {
	out := make([]string, len(parts))
	for i, part := range parts {
		block, ok := part.(map[string]any)
		if !ok || block["type"] != "text" {
			continue
		}
		if text, ok := block["text"].(string); ok {
			out[i] = text
		}
	}
	return strings.Join(out, "\n")
}

// GetMessageText extracts the searchable text of a compiled context message.
// AgentMessage spans plain LLM messages (user/assistant/toolResult) and PiG's
// own custom roles (bashExecution, custom, branchSummary, compactionSummary),
// each storing its text under a different field.
func GetMessageText(message map[string]any) string {
	role, _ := message["role"].(string)
	switch role {
	case "user", "custom":
		switch content := message["content"].(type) {
		case string:
			return content
		case []any:
			return joinTextContentAny(content)
		}
		return ""
	case "assistant", "toolResult":
		content, _ := message["content"].([]any)
		return joinTextContentAny(content)
	case "bashExecution":
		output, _ := message["output"].(string)
		return output
	case "branchSummary", "compactionSummary":
		summary, _ := message["summary"].(string)
		return summary
	}
	return ""
}

// readFooterPatterns are the footers PiG's read tool adds when more content
// exists beyond what was returned.
var readFooterPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$`),
	regexp.MustCompile(`^\[Showing lines \d+-\d+ of \d+\. Use offset=\d+ to continue\.\]$`),
	regexp.MustCompile(`^\[Showing lines \d+-\d+ of \d+ \(\d+(?:\.\d+)?[KMGT]?B limit\)\. Use offset=\d+ to continue\.\]$`),
	regexp.MustCompile(`^\[Line \d+ is [\d.]+[KMGT]?B, exceeds \d+(?:\.\d+)?[KMGT]?B limit\. Use bash: .*\]$`),
}

// StripReadFooters removes a trailing read-tool footer from text.
func StripReadFooters(text string) string {
	parts := strings.Split(text, "\n\n")
	if len(parts) == 0 {
		return text
	}
	last := parts[len(parts)-1]
	for _, pattern := range readFooterPatterns {
		if pattern.MatchString(last) {
			return strings.Join(parts[:len(parts)-1], "\n\n")
		}
	}
	return text
}

// MergeIntervals merges overlapping or adjacent 1-indexed line intervals.
func MergeIntervals(intervals []LineRange) []LineRange {
	sorted := make([]LineRange, 0, len(intervals))
	for _, interval := range intervals {
		if interval.Start <= interval.End {
			sorted = append(sorted, interval)
		}
	}
	slices.SortStableFunc(sorted, func(a, b LineRange) int {
		if byStart := cmp.Compare(a.Start, b.Start); byStart != 0 {
			return byStart
		}
		return cmp.Compare(a.End, b.End)
	})
	if len(sorted) == 0 {
		return []LineRange{}
	}

	merged := make([]LineRange, 0, len(sorted))
	current := sorted[0]
	for _, next := range sorted[1:] {
		if next.Start <= current.End+1 {
			if next.End > current.End {
				current.End = next.End
			}
		} else {
			merged = append(merged, current)
			current = next
		}
	}
	return append(merged, current)
}

// TotalIntervalLength sums the covered lines of disjoint intervals.
func TotalIntervalLength(intervals []LineRange) int {
	total := 0
	for _, interval := range intervals {
		total += interval.End - interval.Start + 1
	}
	return total
}

func isFileBacked(arc ArchivedResult) bool {
	return arc.StalenessStrategy != StalenessImmutable
}

func checkArchiveAgainstLines(arc ArchivedResult, diskLines []string) bool {
	for i, hash := range arc.LineHashes {
		lineIndex := arc.StartLine - 1 + i
		if lineIndex < 0 || lineIndex >= len(diskLines) {
			return true
		}
		if GetHash(diskLines[lineIndex]) != hash {
			return true
		}
	}
	return false
}

func checkPathArchives(paramKey string, pathArchives []ArchivedResult, cwd string, result map[string]bool) {
	filePath := paramKey
	if !filepath.IsAbs(filePath) {
		filePath = filepath.Join(cwd, filePath)
	}

	// A missing path, a directory (EISDIR), or an unreadable file (EACCES) all
	// mark every archive on the path stale, matching single-archive
	// CheckStaleness, rather than aborting the whole eviction pass.
	data, err := os.ReadFile(filePath)
	if err != nil {
		for _, arc := range pathArchives {
			result[arc.PointerID] = true
		}
		return
	}

	diskLines := strings.Split(string(data), "\n")
	for _, arc := range pathArchives {
		result[arc.PointerID] = checkArchiveAgainstLines(arc, diskLines)
	}
}

// CheckStalenessBatch resolves staleness for many archives at once, reading each
// path only once. Immutable archives are always reported stale.
func CheckStalenessBatch(archives []ArchivedResult, cwd string) map[string]bool {
	byPath := make(map[string][]ArchivedResult)
	result := make(map[string]bool)
	for _, arc := range archives {
		if isFileBacked(arc) {
			byPath[arc.ParameterKey] = append(byPath[arc.ParameterKey], arc)
		} else {
			result[arc.PointerID] = true
		}
	}
	for paramKey, pathArchives := range byPath {
		checkPathArchives(paramKey, pathArchives, cwd, result)
	}
	return result
}

// CheckStaleness reports whether a single archive's content no longer matches
// disk. Immutable archives are always stale.
func CheckStaleness(arc ArchivedResult, cwd string) bool {
	if !isFileBacked(arc) {
		return true
	}

	filePath := arc.ParameterKey
	if !filepath.IsAbs(filePath) {
		filePath = filepath.Join(cwd, filePath)
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		return true
	}

	diskLines := strings.Split(string(data), "\n")
	return checkArchiveAgainstLines(arc, diskLines)
}
