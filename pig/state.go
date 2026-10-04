package pig

import (
	"encoding/json"
	"sync"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// State is the in-memory archive index, rebuilt from the session branch.
type State struct {
	mu              sync.Mutex
	activeArchives  map[string]ArchivedResult
	archivesByPath  map[string][]ArchivedResult
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

// Rebuild clears and repopulates the archive index from the current branch.
// evictedPointers is deliberately not cleared: eviction is append-only for the
// whole session, so a pointer replaced in an earlier turn stays replaced.
func (s *State) Rebuild(ctx sdk.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rebuildLocked(ctx)
}

func (s *State) rebuildLocked(ctx sdk.Context) {
	s.activeArchives = make(map[string]ArchivedResult)
	s.archivesByPath = make(map[string][]ArchivedResult)

	branch, err := ctx.SessionManager().GetBranch(nil)
	if err != nil {
		warnf("rebuild state: %v", err)
		return
	}
	for _, entry := range branch {
		if entry["type"] != "custom" || entry["customType"] != ArchiveType {
			continue
		}
		arc, ok := decodeArchivedResult(entry["data"])
		if !ok || arc.PointerID == "" {
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
	key := ArchiveGroupKey(arc.ToolName, arc.ParameterKey)
	s.archivesByPath[key] = append(s.archivesByPath[key], arc)
}

// Snapshot is a read-only copy of the index for one context compilation.
type Snapshot struct {
	ActiveArchives  map[string]ArchivedResult
	ArchivesByPath  map[string][]ArchivedResult
	EvictedPointers map[string]struct{}
}

// Snapshot rebuilds and copies the index so eviction can run without holding the
// state lock across disk reads.
func (s *State) Snapshot(ctx sdk.Context) Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rebuildLocked(ctx)

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
	return Snapshot{ActiveArchives: active, ArchivesByPath: byPath, EvictedPointers: evicted}
}

// MarkEvicted records pointers as replaced for the rest of the session.
func (s *State) MarkEvicted(pointers map[string]struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range pointers {
		s.evictedPointers[id] = struct{}{}
	}
}

func decodeArchivedResult(value any) (ArchivedResult, bool) {
	raw, err := json.Marshal(value)
	if err != nil {
		return ArchivedResult{}, false
	}
	var arc ArchivedResult
	if err := json.Unmarshal(raw, &arc); err != nil {
		return ArchivedResult{}, false
	}
	return arc, true
}
