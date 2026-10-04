// Package hosttest is a minimal fake PiG host for behavior-testing an extension
// over the real subprocess protocol. It speaks the same length-prefixed JSON
// envelopes as the PiG runtime, so a test drives the actual handlers and tool
// through the extension's wire boundary with no model and no disk session.
package hosttest

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// Host is one in-process fake host bound to a running extension.
type Host struct {
	conn net.Conn

	writeMu sync.Mutex

	handlers map[string]int
	tools    map[string]bool

	reqID int

	mu      sync.Mutex
	entries []map[string]any
	usage   map[string]any

	runErr chan error
}

type envelope struct {
	Type       string          `json:"type"`
	ID         string          `json:"id,omitempty"`
	Register   json.RawMessage `json:"register,omitempty"`
	Call       json.RawMessage `json:"call,omitempty"`
	Response   *responseMsg    `json:"response,omitempty"`
	Notify     json.RawMessage `json:"notify,omitempty"`
	Shutdown   json.RawMessage `json:"shutdown,omitempty"`
	WidgetPush json.RawMessage `json:"widget_push,omitempty"`
	Ping       json.RawMessage `json:"ping,omitempty"`
}

type callWire struct {
	Method string          `json:"method"`
	Args   json.RawMessage `json:"args,omitempty"`
}

type responseMsg struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  *errorWire      `json:"error,omitempty"`
}

type errorWire struct {
	Message string `json:"message"`
}

type registerWire struct {
	Tools []struct {
		Name string `json:"name"`
	} `json:"tools"`
	Handlers []struct {
		Event     string `json:"event"`
		HandlerID int    `json:"handler_id"`
	} `json:"handlers"`
}

// New starts the extension over an in-memory pipe and completes the register →
// ready handshake. The caller must call Close.
func New(ext *sdk.Extension, cwd string) (*Host, error) {
	server, client := net.Pipe()
	host := &Host{
		conn:     client,
		handlers: make(map[string]int),
		tools:    make(map[string]bool),
		usage:    map[string]any{"tokens": 0, "contextWindow": 200_000, "percent": 0.0},
		runErr:   make(chan error, 1),
	}
	go func() { host.runErr <- ext.RunWithConn(server) }()

	env, err := host.readEnvelope()
	if err != nil {
		return nil, fmt.Errorf("read register: %w", err)
	}
	if env.Type != "register" {
		return nil, fmt.Errorf("expected register, got %q", env.Type)
	}
	var register registerWire
	if err := json.Unmarshal(env.Register, &register); err != nil {
		return nil, fmt.Errorf("decode register: %w", err)
	}
	for _, tool := range register.Tools {
		host.tools[tool.Name] = true
	}
	for _, handler := range register.Handlers {
		host.handlers[handler.Event] = handler.HandlerID
	}

	if err := host.write(map[string]any{
		"type": "ready",
		"ready": map[string]any{
			"session_name": "behavior-test",
			"cwd":          cwd,
			"mode":         "print",
			"width":        80,
			"model":        "test-model",
		},
	}); err != nil {
		return nil, fmt.Errorf("send ready: %w", err)
	}
	return host, nil
}

// Close ends the connection and waits for the extension to stop.
func (h *Host) Close() error {
	_ = h.conn.Close()
	select {
	case err := <-h.runErr:
		return err
	case <-time.After(3 * time.Second):
		return nil
	}
}

// Tools returns the registered tool names.
func (h *Host) Tools() map[string]bool {
	out := make(map[string]bool, len(h.tools))
	for name := range h.tools {
		out[name] = true
	}
	return out
}

// Entries returns the custom entries the extension appended, in order, shaped as
// session-branch entries.
func (h *Host) Entries() []map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]map[string]any, len(h.entries))
	for i, entry := range h.entries {
		out[i] = cloneMap(entry)
	}
	return out
}

// SeedBranch pre-populates the branch a rebuild would read, for simulating a
// resumed session with a fresh extension instance.
func (h *Host) SeedBranch(entries []map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.entries = make([]map[string]any, len(entries))
	for i, entry := range entries {
		h.entries[i] = cloneMap(entry)
	}
}

// SetContextWindow sets the contextWindow reported by getContextUsage.
func (h *Host) SetContextWindow(window int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.usage["contextWindow"] = window
}

// SessionStart fires the session_start event.
func (h *Host) SessionStart() error {
	_, err := h.event("session_start", map[string]any{"type": "session_start", "reason": "startup"})
	return err
}

// ToolResult fires a tool_result event and returns the handler result.
func (h *Host) ToolResult(data map[string]any) (json.RawMessage, error) {
	return h.event("tool_result", data)
}

// Context fires the context event and returns the replacement result.
func (h *Host) Context(messages []any) (map[string]any, error) {
	result, err := h.event("context", map[string]any{"type": "context", "messages": messages})
	if err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return nil, nil
	}
	var out map[string]any
	if err := json.Unmarshal(result, &out); err != nil {
		return nil, fmt.Errorf("decode context result: %w", err)
	}
	return out, nil
}

// CallTool invokes a registered tool and returns its result object.
func (h *Host) CallTool(name, toolCallID string, args map[string]any) (map[string]any, error) {
	result, err := h.request(map[string]any{
		"method":       "tool_call",
		"tool":         name,
		"tool_call_id": toolCallID,
		"args":         args,
	})
	if err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return nil, nil
	}
	var out map[string]any
	if err := json.Unmarshal(result, &out); err != nil {
		return nil, fmt.Errorf("decode tool result: %w", err)
	}
	return out, nil
}

func (h *Host) event(name string, data map[string]any) (json.RawMessage, error) {
	handlerID, ok := h.handlers[name]
	if !ok {
		return nil, fmt.Errorf("no handler registered for event %q", name)
	}
	return h.request(map[string]any{
		"method":     "event",
		"event":      name,
		"handler_id": handlerID,
		"args":       data,
	})
}

func (h *Host) request(request map[string]any) (json.RawMessage, error) {
	h.reqID++
	id := fmt.Sprintf("req-%d", h.reqID)
	if err := h.write(map[string]any{"type": "request", "id": id, "request": request}); err != nil {
		return nil, err
	}

	for {
		env, err := h.readEnvelope()
		if err != nil {
			return nil, err
		}
		switch env.Type {
		case "call":
			if err := h.handleCall(env); err != nil {
				return nil, err
			}
		case "response":
			if env.ID != id {
				continue
			}
			if env.Response == nil {
				return nil, nil
			}
			if env.Response.Error != nil {
				return nil, fmt.Errorf("extension error: %s", env.Response.Error.Message)
			}
			return env.Response.Result, nil
		case "shutdown":
			return nil, fmt.Errorf("extension shut down")
		default:
			// notify, request_state, ping, etc. carry nothing a test needs.
		}
	}
}

func (h *Host) handleCall(env *envelope) error {
	var call callWire
	if err := json.Unmarshal(env.Call, &call); err != nil {
		return fmt.Errorf("decode call: %w", err)
	}

	switch call.Method {
	case "appendEntry":
		var args struct {
			CustomType string `json:"customType"`
			Data       any    `json:"data"`
		}
		if err := json.Unmarshal(call.Args, &args); err != nil {
			return fmt.Errorf("decode appendEntry args: %w", err)
		}
		h.mu.Lock()
		h.entries = append(h.entries, map[string]any{
			"type":       "custom",
			"customType": args.CustomType,
			"data":       args.Data,
		})
		h.mu.Unlock()
		return h.replyCall(env.ID, nil)
	case "sessionRead":
		var args struct {
			Method string `json:"method"`
		}
		if err := json.Unmarshal(call.Args, &args); err != nil {
			return fmt.Errorf("decode sessionRead args: %w", err)
		}
		h.mu.Lock()
		entries := make([]map[string]any, len(h.entries))
		for i, entry := range h.entries {
			entries[i] = cloneMap(entry)
		}
		h.mu.Unlock()
		return h.replyCall(env.ID, entries)
	case "getContextUsage":
		h.mu.Lock()
		usage := cloneMap(h.usage)
		h.mu.Unlock()
		return h.replyCall(env.ID, usage)
	default:
		return h.replyCall(env.ID, nil)
	}
}

func (h *Host) replyCall(id string, result any) error {
	return h.write(map[string]any{
		"type":        "call_result",
		"id":          id,
		"call_result": map[string]any{"result": result},
	})
}

func (h *Host) readEnvelope() (*envelope, error) {
	frame, err := readFrame(h.conn)
	if err != nil {
		return nil, err
	}
	var env envelope
	if err := json.Unmarshal(frame, &env); err != nil {
		return nil, fmt.Errorf("decode envelope: %w", err)
	}
	return &env, nil
}

func (h *Host) write(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	return writeFrame(h.conn, data)
}

func readFrame(conn net.Conn) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil {
		return nil, err
	}
	size := binary.BigEndian.Uint32(header[:])
	if size == 0 {
		return nil, nil
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(conn, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func writeFrame(conn net.Conn, payload []byte) error {
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := conn.Write(header[:]); err != nil {
		return err
	}
	_, err := conn.Write(payload)
	return err
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
