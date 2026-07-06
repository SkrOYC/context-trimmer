import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { 
  discoverAndLoadExtensions, 
  ExtensionRunner, 
  SessionManager, 
  ModelRegistry, 
  AuthStorage,
  type ExtensionActions,
  type ExtensionContextActions
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Pi Context Trimmer Extension", () => {
  let tempDir: string;
  let sessionManager: SessionManager;
  let modelRegistry: ModelRegistry;
  let extensionActions: ExtensionActions;
  let extensionContextActions: ExtensionContextActions;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-trimmer-test-"));
    sessionManager = SessionManager.inMemory();
    const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
    modelRegistry = ModelRegistry.create(authStorage);

    extensionActions = {
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: (customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
      },
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      refreshTools: () => {},
      getCommands: () => [],
      setModel: async () => false,
      getThinkingLevel: () => "off",
      setThinkingLevel: () => {},
    };

    extensionContextActions = {
      getModel: () => undefined,
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should load the context trimmer extension and initialize recall_result tool", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);

    expect(result.errors).toHaveLength(0);
    expect(result.extensions).toHaveLength(1);

    const ext = result.extensions[0];
    expect(ext).toBeDefined();
    expect(ext!.tools.has("recall_result")).toBe(true);

    const recallTool = ext!.tools.get("recall_result")!;
    expect(recallTool.definition.name).toBe("recall_result");
  });

  it("should replace large read results with a virtual pointer and create an archive", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    // Initial session start
    await runner.emit({ type: "session_start", reason: "startup" });

    // Large content (> 2000 chars)
    const largeContent = "x".repeat(2500);

    const emitResult = await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      input: { AbsolutePath: "/foo/bar.txt" },
      content: [{ type: "text", text: largeContent }],
      isError: false,
      details: undefined,
    });

    expect(emitResult).toBeDefined();
    const textContent = emitResult!.content?.[0];
    expect(textContent).toBeDefined();
    expect(textContent!.type).toBe("text");
    
    const text = (textContent as { text: string }).text;
    expect(text).toMatch(/\[Results Archive: (ptr_[a-z0-9]+)\]/);

    const pointerId = text.match(/ptr_[a-z0-9]+/)?.[0];
    expect(pointerId).toBeDefined();

    // Verify results archive entry exists in the branch
    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(e => e.type === "custom" && e.customType === "results-archive");
    expect(archiveEntry).toBeDefined();
    expect((archiveEntry as any).data.pointerId).toBe(pointerId);
    expect((archiveEntry as any).data.originalContent).toContain(largeContent);
  });

  it("should invalidate older read results targeting the same AbsolutePath", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    await runner.emit({ type: "session_start", reason: "startup" });

    const filePath = "/foo/bar.txt";

    // 1st Read
    const firstResult = await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      input: { AbsolutePath: filePath },
      content: [{ type: "text", text: "a".repeat(2500) }],
      isError: false,
      details: undefined,
    });
    const firstPointerId = (firstResult!.content![0] as { text: string }).text.match(/ptr_[a-z0-9]+/)?.[0]!;

    // 2nd Read (different toolCallId, same path)
    const secondResult = await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-2",
      input: { AbsolutePath: filePath },
      content: [{ type: "text", text: "b".repeat(2500) }],
      isError: false,
      details: undefined,
    });
    const secondPointerId = (secondResult!.content![0] as { text: string }).text.match(/ptr_[a-z0-9]+/)?.[0]!;

    expect(firstPointerId).not.toBe(secondPointerId);

    // Verify invalidation event exists
    const branch = sessionManager.getBranch();
    const invalidationEntry = branch.find(e => e.type === "custom" && e.customType === "invalidation-event");
    expect(invalidationEntry).toBeDefined();
    expect((invalidationEntry as any).data.supersededPointerId).toBe(firstPointerId);
  });

  it("should not invalidate grep results since invalidatePrior is false", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    await runner.emit({ type: "session_start", reason: "startup" });

    // 1st Grep
    await runner.emitToolResult({
      type: "tool_result",
      toolName: "grep",
      toolCallId: "call-grep-1",
      input: { SearchPath: "/src", Query: "foo" },
      content: [{ type: "text", text: "a".repeat(4500) }],
      isError: false,
      details: undefined,
    });

    // 2nd Grep (same path & query)
    await runner.emitToolResult({
      type: "tool_result",
      toolName: "grep",
      toolCallId: "call-grep-2",
      input: { SearchPath: "/src", Query: "foo" },
      content: [{ type: "text", text: "b".repeat(4500) }],
      isError: false,
      details: undefined,
    });

    const branch = sessionManager.getBranch();
    const invalidationEntry = branch.find(e => e.type === "custom" && e.customType === "invalidation-event");
    expect(invalidationEntry).toBeUndefined(); // Should not exist
  });

  it("should rewrite context for invalidated pointers to include (Invalidated - Stale)", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    await runner.emit({ type: "session_start", reason: "startup" });

    // 1st Read -> archives
    const r1 = await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      input: { AbsolutePath: "/foo/bar.txt" },
      content: [{ type: "text", text: "a".repeat(2500) }],
      isError: false,
      details: undefined,
    });
    const p1 = (r1!.content![0] as { text: string }).text;

    // 2nd Read -> invalidates first
    await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-2",
      input: { AbsolutePath: "/foo/bar.txt" },
      content: [{ type: "text", text: "b".repeat(2500) }],
      isError: false,
      details: undefined,
    });

    // Verify context rewrite
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        timestamp: Date.now(),
        content: [{ type: "text", text: p1 }]
      }
    ];

    const compiled = await runner.emitContext(messages);
    const text = ((compiled[0] as any)!.content![0] as { text: string }).text;
    expect(text).toContain("(Invalidated - Stale)");
  });

  it("should recall results correctly using recall_result tool", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    await runner.emit({ type: "session_start", reason: "startup" });

    const contentText = "a".repeat(2500);

    const r1 = await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      input: { AbsolutePath: "/foo/bar.txt" },
      content: [{ type: "text", text: contentText }],
      isError: false,
      details: undefined,
    });

    const pointerText = (r1!.content![0] as { text: string }).text;
    const pointerId = pointerText.match(/ptr_[a-z0-9]+/)?.[0]!;

    const ext = result.extensions[0];
    expect(ext).toBeDefined();
    const recallTool = ext!.tools.get("recall_result")!;
    
    // Recall Active Pointer
    const executeResult = await recallTool.definition.execute(
      "recall-call-1",
      { pointer_id: pointerId },
      new AbortController().signal,
      () => {},
      runner.createContext()
    );

    expect((executeResult as any).isError).toBeFalsy();
    expect((executeResult.content![0] as { text: string }).text).toContain(contentText);

    // Invalidate the pointer by calling read again
    await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-2",
      input: { AbsolutePath: "/foo/bar.txt" },
      content: [{ type: "text", text: "b".repeat(2500) }],
      isError: false,
      details: undefined,
    });

    // Recall Invalidated/Stale Pointer
    const executeStaleResult = await recallTool.definition.execute(
      "recall-call-2",
      { pointer_id: pointerId },
      new AbortController().signal,
      () => {},
      runner.createContext()
    );

    expect((executeStaleResult as any).isError).toBeFalsy();
    expect((executeStaleResult.content![0] as { text: string }).text).toContain("Warning: Pointer");
    expect((executeStaleResult.details as any)?.status).toBe("invalidated");
  });

  it("should respect branch isolation for archives and invalidations", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    // Root session start
    await runner.emit({ type: "session_start", reason: "startup" });

    // Create a pointer in root
    const r1 = await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-root",
      input: { AbsolutePath: "/foo/root.txt" },
      content: [{ type: "text", text: "a".repeat(2500) }],
      isError: false,
      details: undefined,
    });
    const rootPointerText = (r1!.content![0] as { text: string }).text;
    const rootBranchLeafId = sessionManager.getLeafId()!;

    // BRANCH A
    // In Branch A, we read root.txt again to invalidate the root pointer
    await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-branch-a",
      input: { AbsolutePath: "/foo/root.txt" },
      content: [{ type: "text", text: "b".repeat(2500) }],
      isError: false,
      details: undefined,
    });
    const leafIdA = sessionManager.getLeafId()!;

    // Verify root pointer is invalidated in Branch A
    await runner.emit({ type: "session_tree", oldLeafId: rootBranchLeafId, newLeafId: leafIdA });
    const compiledA = await runner.emitContext([
      { role: "toolResult", toolCallId: "call-root", toolName: "read", isError: false, timestamp: Date.now(), content: [{ type: "text", text: rootPointerText }] }
    ]);
    expect(((compiledA[0] as any)!.content![0] as { text: string }).text).toContain("(Invalidated - Stale)");

    // BRANCH B (we navigate back to rootBranchLeafId, then do a different action)
    // We navigate to rootBranchLeafId, then write a different file (no invalidation of root.txt)
    sessionManager.branch(rootBranchLeafId);
    await runner.emit({ type: "session_tree", oldLeafId: leafIdA, newLeafId: rootBranchLeafId });

    await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-branch-b",
      input: { AbsolutePath: "/foo/branch-b.txt" },
      content: [{ type: "text", text: "c".repeat(2500) }],
      isError: false,
      details: undefined,
    });
    const leafIdB = sessionManager.getLeafId()!;

    // Verify root pointer is STILL ACTIVE in Branch B (not stale)
    await runner.emit({ type: "session_tree", oldLeafId: rootBranchLeafId, newLeafId: leafIdB });
    const compiledB = await runner.emitContext([
      { role: "toolResult", toolCallId: "call-root", toolName: "read", isError: false, timestamp: Date.now(), content: [{ type: "text", text: rootPointerText }] }
    ]);
    expect(((compiledB[0] as any)!.content![0] as { text: string }).text).not.toContain("(Invalidated - Stale)");
    expect(((compiledB[0] as any)!.content![0] as { text: string }).text).toBe(rootPointerText);
  });
});
