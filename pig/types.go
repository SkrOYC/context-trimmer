package pig

import (
	"strconv"
	"strings"
)

// ArchiveType is the custom session-entry type that stores archived tool results.
const ArchiveType = "results-archive"

// StalenessStrategy says how an archive's validity is re-checked.
type StalenessStrategy string

const (
	// StalenessFileLines re-hashes the archived lines of a file on disk.
	StalenessFileLines StalenessStrategy = "file-lines"
	// StalenessImmutable marks content that cannot be re-validated (bash/grep/find/ls).
	StalenessImmutable StalenessStrategy = "immutable"
)

// SupersessionStrategy says how a newer invocation covers an older archive.
type SupersessionStrategy string

const (
	// SupersessionExactKey means any later invocation of the same group supersedes.
	SupersessionExactKey SupersessionStrategy = "exact-key"
	// SupersessionLineRange means later reads supersede by covered line range.
	SupersessionLineRange SupersessionStrategy = "line-range"
	// SupersessionNone means the archive is never superseded.
	SupersessionNone SupersessionStrategy = "none"
)

// ArchivedResult is the payload of a results-archive custom entry. The JSON field
// names mirror the TypeScript extension's record so a session written by either
// build stays readable to the other.
type ArchivedResult struct {
	LineHashes           []string             `json:"lineHashes"`
	OriginalContent      string               `json:"originalContent"`
	ParameterKey         string               `json:"parameterKey"`
	PointerID            string               `json:"pointerId"`
	StalenessStrategy    StalenessStrategy    `json:"stalenessStrategy,omitempty"`
	StartLine            int                  `json:"startLine"`
	SupersessionStrategy SupersessionStrategy `json:"supersessionStrategy,omitempty"`
	Timestamp            int64                `json:"timestamp"`
	ToolCallID           string               `json:"toolCallId"`
	ToolName             string               `json:"toolName"`
}

// ArchiveGroupKey groups archives that can supersede one another: same tool and
// same resolved parameter.
func ArchiveGroupKey(toolName, parameterKey string) string {
	return toolName + ":" + parameterKey
}

// LineRange is a 1-indexed, inclusive line interval.
type LineRange struct {
	Start int
	End   int
}

// contentBlock is a text or image block of a tool result.
type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// truncation mirrors the `details.truncation` object archive-eligible tools add
// when they cut a result short.
type truncation struct {
	Content               string `json:"content"`
	FirstLineExceedsLimit bool   `json:"firstLineExceedsLimit"`
}

// toolResultEvent is the decoded tool_result payload. Only the fields the
// archiver needs are kept.
type toolResultEvent struct {
	ToolName   string         `json:"toolName"`
	ToolCallID string         `json:"toolCallId"`
	Input      map[string]any `json:"input"`
	Content    []contentBlock `json:"content"`
	Details    struct {
		Truncation *truncation `json:"truncation"`
	} `json:"details"`
	IsError bool `json:"isError"`
}

// ToolPolicy is one row of the archiving policy table: which tools are archived,
// how their content is extracted, and how validity is decided.
type ToolPolicy struct {
	ToolName             string
	StalenessStrategy    StalenessStrategy
	SupersessionStrategy SupersessionStrategy
	ExtractContent       func(ev toolResultEvent) (string, bool)
	GetParameterKey      func(input map[string]any) (string, bool)
}

func joinTextContent(content []contentBlock) string {
	parts := make([]string, len(content))
	for i, block := range content {
		if block.Type == "text" {
			parts[i] = block.Text
		}
	}
	return strings.Join(parts, "\n")
}

func extractGenericContent(ev toolResultEvent) (string, bool) {
	if t := ev.Details.Truncation; t != nil {
		if t.FirstLineExceedsLimit {
			return "", false
		}
		return t.Content, true
	}
	return joinTextContent(ev.Content), true
}

func extractReadContent(ev toolResultEvent) (string, bool) {
	if t := ev.Details.Truncation; t != nil {
		if t.FirstLineExceedsLimit {
			return "", false
		}
		return t.Content, true
	}
	return StripReadFooters(joinTextContent(ev.Content)), true
}

func getReadParameterKey(input map[string]any) (string, bool) {
	path, ok := input["path"].(string)
	return path, ok
}

func getBashParameterKey(input map[string]any) (string, bool) {
	command, ok := input["command"].(string)
	return command, ok
}

func getGrepParameterKey(input map[string]any) (string, bool) {
	pattern, ok := input["pattern"].(string)
	if !ok {
		return "", false
	}
	parts := []string{pattern}
	if path, ok := input["path"].(string); ok {
		parts = append(parts, "path="+path)
	}
	if glob, ok := input["glob"].(string); ok {
		parts = append(parts, "glob="+glob)
	}
	if ignoreCase, ok := input["ignoreCase"].(bool); ok && ignoreCase {
		parts = append(parts, "ignoreCase")
	}
	if literal, ok := input["literal"].(bool); ok && literal {
		parts = append(parts, "literal")
	}
	if context, ok := input["context"].(float64); ok {
		parts = append(parts, "context="+strconv.FormatFloat(context, 'f', -1, 64))
	}
	return strings.Join(parts, "|"), true
}

func getFindParameterKey(input map[string]any) (string, bool) {
	pattern, ok := input["pattern"].(string)
	if !ok {
		return "", false
	}
	parts := []string{pattern}
	if path, ok := input["path"].(string); ok {
		parts = append(parts, "path="+path)
	}
	return strings.Join(parts, "|"), true
}

func getLsParameterKey(input map[string]any) (string, bool) {
	if path, ok := input["path"].(string); ok {
		return path, true
	}
	return ".", true
}

// Policies is the archiving policy table. It mirrors the TypeScript extension's
// per-tool intent: reads are file-backed and line-range superseded; command-like
// output is immutable and exact-key superseded.
var Policies = []ToolPolicy{
	{ToolName: "read", StalenessStrategy: StalenessFileLines, SupersessionStrategy: SupersessionLineRange, ExtractContent: extractReadContent, GetParameterKey: getReadParameterKey},
	{ToolName: "bash", StalenessStrategy: StalenessImmutable, SupersessionStrategy: SupersessionExactKey, ExtractContent: extractGenericContent, GetParameterKey: getBashParameterKey},
	{ToolName: "grep", StalenessStrategy: StalenessImmutable, SupersessionStrategy: SupersessionExactKey, ExtractContent: extractGenericContent, GetParameterKey: getGrepParameterKey},
	{ToolName: "find", StalenessStrategy: StalenessImmutable, SupersessionStrategy: SupersessionExactKey, ExtractContent: extractGenericContent, GetParameterKey: getFindParameterKey},
	{ToolName: "ls", StalenessStrategy: StalenessImmutable, SupersessionStrategy: SupersessionExactKey, ExtractContent: extractGenericContent, GetParameterKey: getLsParameterKey},
}

var policyByTool = func() map[string]ToolPolicy {
	byTool := make(map[string]ToolPolicy, len(Policies))
	for _, policy := range Policies {
		byTool[policy.ToolName] = policy
	}
	return byTool
}()
