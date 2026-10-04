package pig

import (
	"sync"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// State is the in-memory archive index, rebuilt from the session branch.
type State struct {
	mu              sync.Mutex
	activeArchives  map[string]ArchivedResult
	archivesByPath  map[string][]ArchivedResult
	ordered         []ArchivedResult
	evictedPointers map[string]struct{}
}

// NewState returns an empty archive index.
func NewState() *State {
	return &State{
		activeArchives:  make(map[string]ArchivedResult),
		archivesByPath:  make(map[string][]ArchivedResult),
		evictedPointers: make(map[string]struct{}),
	}
}

// Rebuild refreshes the index from the current branch. evictedPointers is
// deliberately not cleared: eviction is append-only for the whole session, so a
// pointer replaced in an earlier turn stays replaced.
func (s *State) Rebuild(ctx sdk.Context) {
	s.refresh(ctx)
}

// refresh reads the branch (a host round-trip) outside the lock, then rebuilds.
// On a read failure it keeps the last known state rather than clearing it.
func (s *State) refresh(ctx sdk.Context) {
	branch, err := ctx.SessionManager().GetBranch(nil)
	if err != nil {
		warnf("rebuild state: %v", err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rebuildLocked(branch)
}

func (s *State) rebuildLocked(branch []map[string]any) {
	s.activeArchives = make(map[string]ArchivedResult)
	s.archivesByPath = make(map[string][]ArchivedResult)
	s.ordered = nil

	for _, entry := range branch {
		if entry["type"] != "custom" || entry["customType"] != ArchiveType {
			continue
		}
		data, ok := entry["data"].(map[string]any)
		if !ok {
			warnf("rebuild state: archive entry %v has non-object data", entry["id"])
			continue
		}
		arc := archivedResultFromMap(data)
		if arc.PointerID == "" {
			warnf("rebuild state: archive entry %v is missing a pointerId", entry["id"])
			continue
		}
		s.registerLocked(arc)
	}
}

// Register adds an archive to the index if it is not already present.
func (s *State) Register(arc ArchivedResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.registerLocked(arc)
}

func (s *State) registerLocked(arc ArchivedResult) {
	if _, ok := s.activeArchives[arc.PointerID]; ok {
		return
	}
	s.activeArchives[arc.PointerID] = arc
	s.ordered = append(s.ordered, arc)
	key := ArchiveGroupKey(arc.ToolName, arc.ParameterKey)
	s.archivesByPath[key] = append(s.archivesByPath[key], arc)
}

// Snapshot is a read-only copy of the index for one context compilation.
type Snapshot struct {
	ActiveArchives  map[string]ArchivedResult
	ArchivesByPath  map[string][]ArchivedResult
	Ordered         []ArchivedResult
	EvictedPointers map[string]struct{}
}

// Snapshot refreshes and copies the index so eviction can run without holding
// the state lock across disk reads or host round-trips.
func (s *State) Snapshot(ctx sdk.Context) Snapshot {
	s.refresh(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotLocked()
}

func (s *State) snapshotLocked() Snapshot {
	active := make(map[string]ArchivedResult, len(s.activeArchives))
	for id, arc := range s.activeArchives {
		active[id] = arc
	}
	byPath := make(map[string][]ArchivedResult, len(s.archivesByPath))
	for key, list := range s.archivesByPath {
		byPath[key] = append([]ArchivedResult(nil), list...)
	}
	evicted := make(map[string]struct{}, len(s.evictedPointers))
	for id := range s.evictedPointers {
		evicted[id] = struct{}{}
	}
	return Snapshot{
		ActiveArchives:  active,
		ArchivesByPath:  byPath,
		Ordered:         append([]ArchivedResult(nil), s.ordered...),
		EvictedPointers: evicted,
	}
}

// MarkEvicted records pointers as replaced for the rest of the session.
func (s *State) MarkEvicted(pointers map[string]struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range pointers {
		s.evictedPointers[id] = struct{}{}
	}
}

// EvictedPointers returns a copy of the live append-only eviction set.
func (s *State) EvictedPointers() map[string]struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	evicted := make(map[string]struct{}, len(s.evictedPointers))
	for id := range s.evictedPointers {
		evicted[id] = struct{}{}
	}
	return evicted
}

// archivedResultFromMap decodes one archive payload without a JSON round-trip.
func archivedResultFromMap(data map[string]any) ArchivedResult {
	arc := ArchivedResult{
		OriginalContent:      stringValue(data["originalContent"]),
		ParameterKey:         stringValue(data["parameterKey"]),
		PointerID:            stringValue(data["pointerId"]),
		StalenessStrategy:    StalenessStrategy(stringValue(data["stalenessStrategy"])),
		SupersessionStrategy: SupersessionStrategy(stringValue(data["supersessionStrategy"])),
		ToolCallID:           stringValue(data["toolCallId"]),
		ToolName:             stringValue(data["toolName"]),
	}
	if value, ok := numberValue(data["startLine"]); ok {
		arc.StartLine = value
	}
	if value, ok := numberValue(data["timestamp"]); ok {
		arc.Timestamp = int64(value)
	}
	switch hashes := data["lineHashes"].(type) {
	case []any:
		arc.LineHashes = make([]string, len(hashes))
		for i, hash := range hashes {
			arc.LineHashes[i] = stringValue(hash)
		}
	case []string:
		arc.LineHashes = append([]string(nil), hashes...)
	}
	return arc
}
