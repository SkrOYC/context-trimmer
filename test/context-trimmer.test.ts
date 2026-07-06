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
    sessionManager = SessionManager.inMemory(tempDir);
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

  it("should not replace read results immediately (returns raw result in full)", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    await runner.emit({ type: "session_start", reason: "startup" });

    const filePath = path.join(tempDir, "large_file.txt");
    const fileContent = "Line 1\n" + "x".repeat(2500) + "\nLine 3";
    fs.writeFileSync(filePath, fileContent, "utf8");

    const emitResult = await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      input: { path: filePath },
      content: [{ type: "text", text: fileContent }],
      isError: false,
      details: undefined,
    });

    // Verify it returned undefined (did not compress/replace tool result raw payload)
    expect(emitResult).toBeUndefined();

    // Verify custom results-archive entry exists in session
    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(e => e.type === "custom" && e.customType === "results-archive");
    expect(archiveEntry).toBeDefined();
    
    const arcData = (archiveEntry as any).data;
    expect(arcData.parameterKey).toBe(filePath);
    expect(arcData.startLine).toBe(1);
    expect(arcData.lineHashes).toHaveLength(3);
  });

  it("should preserve raw content in context if the file on disk is unchanged", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    await runner.emit({ type: "session_start", reason: "startup" });

    const filePath = path.join(tempDir, "file.txt");
    const fileContent = "Line 1\n" + "a".repeat(2100) + "\nLine 3";
    fs.writeFileSync(filePath, fileContent, "utf8");

    // Intercept read
    await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      input: { path: filePath },
      content: [{ type: "text", text: fileContent }],
      isError: false,
      details: undefined,
    });

    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        timestamp: Date.now(),
        content: [{ type: "text", text: fileContent }]
      }
    ];

    // Context compilation
    const compiled = await runner.emitContext(messages);
    const text = ((compiled[0] as any)!.content![0] as { text: string }).text;
    
    // Unchanged raw content should be preserved
    expect(text).toBe(fileContent);
    expect(text).not.toContain("Results Archive");
  });

  it("should replace raw content with stale pointer in context if a read line has changed", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    await runner.emit({ type: "session_start", reason: "startup" });

    const filePath = path.join(tempDir, "file.txt");
    const fileContent = "Line 1\n" + "a".repeat(2100) + "\nLine 3";
    fs.writeFileSync(filePath, fileContent, "utf8");

    await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      input: { path: filePath },
      content: [{ type: "text", text: fileContent }],
      isError: false,
      details: undefined,
    });

    // Modify the file on disk (changes line 2)
    fs.writeFileSync(filePath, "Line 1\n" + "different text\nLine 3", "utf8");

    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        timestamp: Date.now(),
        content: [{ type: "text", text: fileContent }]
      }
    ];

    // Context compilation
    const compiled = await runner.emitContext(messages);
    const text = ((compiled[0] as any)!.content![0] as { text: string }).text;

    // Content should be replaced with stale virtual pointer
    expect(text).toContain("[Results Archive:");
    expect(text).toContain("(Invalidated - Stale)");
  });

  it("should not invalidate read content if the disk change is outside the read line range", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    await runner.emit({ type: "session_start", reason: "startup" });

    const filePath = path.join(tempDir, "file.txt");
    // File has 10 lines
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1} ` + "x".repeat(300));
    fs.writeFileSync(filePath, lines.join("\n"), "utf8");

    // Partial read: lines 5 to 7 (offset 5, limit 3)
    const readLines = lines.slice(4, 7);
    const readText = readLines.join("\n");

    await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      input: { path: filePath, offset: 5, limit: 3 },
      content: [{ type: "text", text: readText }],
      isError: false,
      details: undefined,
    });

    // Modify line 1 and 2 on disk (outside the range of lines 5-7)
    lines[0] = "Line 1 changed completely";
    lines[1] = "Line 2 changed completely";
    fs.writeFileSync(filePath, lines.join("\n"), "utf8");

    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        timestamp: Date.now(),
        content: [{ type: "text", text: readText }]
      }
    ];

    // Context compilation
    const compiled = await runner.emitContext(messages);
    const text = ((compiled[0] as any)!.content![0] as { text: string }).text;

    // Content should remain raw since lines 5-7 did not change
    expect(text).toBe(readText);
  });

  it("should strip read-tool footer before hashing (user limit with more content)", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    await runner.emit({ type: "session_start", reason: "startup" });

    const filePath = path.join(tempDir, "file.txt");
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1} ` + "x".repeat(800));
    fs.writeFileSync(filePath, lines.join("\n"), "utf8");

    // Partial read: lines 5 to 7, with read-tool footer appended because more content remains
    const readLines = lines.slice(4, 7);
    const readText = readLines.join("\n");
    const rawTextWithFooter = `${readText}\n\n[7 more lines in file. Use offset=8 to continue.]`;

    await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      input: { path: filePath, offset: 5, limit: 3 },
      content: [{ type: "text", text: rawTextWithFooter }],
      isError: false,
      details: undefined,
    });

    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(e => e.type === "custom" && e.customType === "results-archive");
    expect(archiveEntry).toBeDefined();

    const arcData = (archiveEntry as any).data;
    expect(arcData.startLine).toBe(5);
    // Should hash only the 3 real content lines, not the footer
    expect(arcData.lineHashes).toHaveLength(3);

    // Verify unchanged content is not marked stale
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        timestamp: Date.now(),
        content: [{ type: "text", text: rawTextWithFooter }]
      }
    ];
    const compiled = await runner.emitContext(messages);
    const text = ((compiled[0] as any)!.content![0] as { text: string }).text;
    expect(text).toBe(rawTextWithFooter);
    expect(text).not.toContain("Results Archive");
  });

  it("should use details.truncation.content when available", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    await runner.emit({ type: "session_start", reason: "startup" });

    const filePath = path.join(tempDir, "file.txt");
    const fileContent = "Line 1\n" + "a".repeat(3000) + "\nLine 3";
    fs.writeFileSync(filePath, fileContent, "utf8");

    // Simulate read tool returning truncation metadata where only the first two lines were kept
    const truncatedContent = "Line 1\n" + "a".repeat(2100);
    const rawText = fileContent;

    await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      input: { path: filePath },
      content: [{ type: "text", text: rawText }],
      isError: false,
      details: {
        truncation: {
          content: truncatedContent,
          truncated: true,
          truncatedBy: "bytes",
          totalLines: 3,
          totalBytes: Buffer.byteLength(fileContent, "utf-8"),
          outputLines: 1,
          outputBytes: Buffer.byteLength(truncatedContent, "utf-8"),
          lastLinePartial: false,
          firstLineExceedsLimit: false,
          maxLines: 2000,
          maxBytes: 50 * 1024,
        }
      },
    });

    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(e => e.type === "custom" && e.customType === "results-archive");
    expect(archiveEntry).toBeDefined();

    const arcData = (archiveEntry as any).data;
    // Should hash only the truncated content lines, not the full raw text
    expect(arcData.lineHashes).toHaveLength(2);
    expect(arcData.startLine).toBe(1);

    // Verify the original raw content is preserved for recall
    expect(arcData.originalContent).toBe(JSON.stringify([{ type: "text", text: rawText }]));
  });

  it("should skip archiving when first line exceeds byte limit", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    await runner.emit({ type: "session_start", reason: "startup" });

    const filePath = path.join(tempDir, "file.txt");
    fs.writeFileSync(filePath, "placeholder", "utf8");

    await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      input: { path: filePath },
      content: [{ type: "text", text: "[Line 1 is 60KB, exceeds 50KB limit. Use bash: ...]" }],
      isError: false,
      details: {
        truncation: {
          content: "",
          truncated: true,
          truncatedBy: "bytes",
          totalLines: 1,
          totalBytes: 60000,
          outputLines: 0,
          outputBytes: 0,
          lastLinePartial: false,
          firstLineExceedsLimit: true,
          maxLines: 2000,
          maxBytes: 50 * 1024,
        }
      },
    });

    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(e => e.type === "custom" && e.customType === "results-archive");
    expect(archiveEntry).toBeUndefined();
  });

  it("should replace content with pointer if the file is deleted on disk", async () => {
    const extensionPath = path.resolve("./index.ts");
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
    const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
    runner.bindCore(extensionActions, extensionContextActions);

    await runner.emit({ type: "session_start", reason: "startup" });

    const filePath = path.join(tempDir, "file.txt");
    const fileContent = "Line 1\n" + "a".repeat(2100);
    fs.writeFileSync(filePath, fileContent, "utf8");

    await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      input: { path: filePath },
      content: [{ type: "text", text: fileContent }],
      isError: false,
      details: undefined,
    });

    // Delete file
    fs.unlinkSync(filePath);

    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        timestamp: Date.now(),
        content: [{ type: "text", text: fileContent }]
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

    const filePath = path.join(tempDir, "file.txt");
    const fileContent = "Line 1\n" + "a".repeat(2100);
    fs.writeFileSync(filePath, fileContent, "utf8");

    await runner.emitToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-1",
      input: { path: filePath },
      content: [{ type: "text", text: fileContent }],
      isError: false,
      details: undefined,
    });

    const branch = sessionManager.getBranch();
    const arcData = (branch.find(e => e.type === "custom" && e.customType === "results-archive") as any).data;
    const pointerId = arcData.pointerId;

    const ext = result.extensions[0];
    expect(ext).toBeDefined();
    const recallTool = ext!.tools.get("recall_result")!;

    // Recall active result
    const activeResult = await recallTool.definition.execute(
      "recall-call-1",
      { pointer_id: pointerId },
      new AbortController().signal,
      () => {},
      runner.createContext()
    );

    expect((activeResult as any).isError).toBeFalsy();
    expect(activeResult.details?.status).toBe("active");
    expect((activeResult.content![0] as { text: string }).text).toBe(fileContent);

    // Modify file -> make it stale
    fs.writeFileSync(filePath, "modified text", "utf8");

    // Recall stale result
    const staleResult = await recallTool.definition.execute(
      "recall-call-2",
      { pointer_id: pointerId },
      new AbortController().signal,
      () => {},
      runner.createContext()
    );

    expect((staleResult as any).isError).toBeFalsy();
    expect(staleResult.details?.status).toBe("invalidated");
    const staleText = (staleResult.content![0] as { text: string }).text;
    expect(staleText).toContain("<recalled-stale-content>");
    expect(staleText).toContain("Warning: Pointer");
    expect(staleText).toContain(fileContent);
    expect(staleText).toContain("</recalled-stale-content>");
  });
});
