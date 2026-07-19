import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  AuthStorage,
  discoverAndLoadExtensions,
  type ExtensionActions,
  type ExtensionContextActions,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

describe("Pi Context Trimmer Extension", () => {
  let tempDir: string;
  let sessionManager: SessionManager;
  let modelRegistry: ModelRegistry;
  let extensionActions: ExtensionActions;
  let extensionContextActions: ExtensionContextActions;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-trimmer-test-"));
    sessionManager = SessionManager.inMemory(tempDir);
    const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
    modelRegistry = ModelRegistry.create(authStorage);

    extensionActions = {
      appendEntry: (customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
      },
      getActiveTools: () => [],
      getAllTools: () => [],
      getCommands: () => [],
      getSessionName: () => undefined,
      getThinkingLevel: () => "off",
      refreshTools: () => undefined,
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
      setActiveTools: () => undefined,
      setLabel: () => undefined,
      setModel: async () => false,
      setSessionName: () => undefined,
      setThinkingLevel: () => undefined,
    };

    extensionContextActions = {
      abort: () => undefined,
      compact: () => undefined,
      getContextUsage: () => undefined,
      getModel: () => undefined,
      getSignal: () => undefined,
      getSystemPrompt: () => "",
      hasPendingMessages: () => false,
      isIdle: () => true,
      isProjectTrusted: () => true,
      shutdown: () => undefined,
    };
  });

  afterEach(() => {
    rmSync(tempDir, { force: true, recursive: true });
  });

  async function loadExtension(contextUsage?: {
    tokens: number;
    contextWindow: number;
    percent: number;
  }) {
    const extensionPath = resolve("./src/index.ts");
    const result = await discoverAndLoadExtensions(
      [extensionPath],
      tempDir,
      tempDir
    );
    const runner = new ExtensionRunner(
      result.extensions,
      result.runtime,
      tempDir,
      sessionManager,
      modelRegistry
    );

    const customExtensionContextActions = {
      ...extensionContextActions,
      getContextUsage: () => contextUsage ?? undefined,
    };

    runner.bindCore(extensionActions, customExtensionContextActions);
    await runner.emit({ reason: "startup", type: "session_start" });
    return { result, runner };
  }

  function makeReadResult(
    toolCallId: string,
    input: Record<string, any>,
    text: string,
    details?: any
  ) {
    return {
      content: [{ text, type: "text" as const }],
      details,
      input,
      isError: false,
      toolCallId,
      toolName: "read" as const,
      type: "tool_result" as const,
    };
  }

  function makeToolResultMessage(
    toolCallId: string,
    text: string,
    toolName = "read"
  ): AgentMessage {
    return {
      content: [{ text, type: "text" }],
      isError: false,
      role: "toolResult",
      timestamp: Date.now(),
      toolCallId,
      toolName,
    };
  }

  function makeBashResult(toolCallId: string, command: string, text: string) {
    return {
      content: [{ text, type: "text" as const }],
      details: undefined,
      input: { command },
      isError: false,
      toolCallId,
      toolName: "bash" as const,
      type: "tool_result" as const,
    };
  }

  function makeGrepResult(
    toolCallId: string,
    pattern: string,
    text: string,
    path?: string
  ) {
    return {
      content: [{ text, type: "text" as const }],
      details: undefined,
      input: { pattern, ...(path && { path }) },
      isError: false,
      toolCallId,
      toolName: "grep" as const,
      type: "tool_result" as const,
    };
  }

  function firstText(messages: AgentMessage[]): string {
    return ((messages[0] as any)?.content?.[0] as { text: string }).text;
  }

  it("should load the context trimmer extension and initialize recall_result tool", async () => {
    const { result } = await loadExtension();

    expect(result.errors).toHaveLength(0);
    expect(result.extensions).toHaveLength(1);

    const [ext] = result.extensions;
    expect(ext).toBeDefined();
    expect(ext?.tools.has("recall_result")).toBe(true);

    const recallTool = ext?.tools.get("recall_result");
    expect(recallTool).toBeDefined();
    expect(recallTool?.definition.name).toBe("recall_result");
  });

  it("should not replace read results immediately (returns raw result in full)", async () => {
    const { runner } = await loadExtension();

    const filePath = join(tempDir, "large_file.txt");
    const fileContent = `Line 1\n${"x".repeat(2500)}\nLine 3`;
    writeFileSync(filePath, fileContent, "utf8");

    const emitResult = await runner.emitToolResult(
      makeReadResult("call-1", { path: filePath }, fileContent)
    );

    // Verify it returned undefined (did not compress/replace tool result raw payload)
    expect(emitResult).toBeUndefined();

    // Verify custom results-archive entry exists in session
    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(
      (e) => e.type === "custom" && e.customType === "results-archive"
    );
    expect(archiveEntry).toBeDefined();

    const arcData = (archiveEntry as any).data;
    expect(arcData.parameterKey).toBe(filePath);
    expect(arcData.startLine).toBe(1);
    expect(arcData.lineHashes).toHaveLength(3);
  });

  it("should NOT archive a failed tool result (e.g. reading a directory)", async () => {
    const { runner } = await loadExtension();

    // pi returns an error result when the model reads a directory. The paramKey
    // would be the directory path, so archiving it creates a file-backed archive
    // whose later staleness check reads a directory and throws. Skip it.
    const emitResult = await runner.emitToolResult({
      content: [
        {
          text: "EISDIR: illegal operation on a directory, read",
          type: "text" as const,
        },
      ],
      details: undefined,
      input: { path: tempDir },
      isError: true,
      toolCallId: "call-err",
      toolName: "read" as const,
      type: "tool_result" as const,
    });

    expect(emitResult).toBeUndefined();

    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(
      (e) => e.type === "custom" && e.customType === "results-archive"
    );
    expect(archiveEntry).toBeUndefined();
  });

  it("should preserve raw content in context if the file on disk is unchanged", async () => {
    const { runner } = await loadExtension();

    const filePath = join(tempDir, "file.txt");
    const fileContent = `Line 1\n${"a".repeat(2100)}\nLine 3`;
    writeFileSync(filePath, fileContent, "utf8");

    await runner.emitToolResult(
      makeReadResult("call-1", { path: filePath }, fileContent)
    );

    const messages: AgentMessage[] = [
      makeToolResultMessage("call-1", fileContent),
    ];
    const compiled = await runner.emitContext(messages);
    const text = firstText(compiled);

    expect(text).toBe(fileContent);
    expect(text).not.toContain("Results Archive");
  });

  it("should NOT replace raw content when only disk content changes (no superseding read)", async () => {
    const { runner } = await loadExtension();

    const filePath = join(tempDir, "file.txt");
    const fileContent = `Line 1\n${"a".repeat(2100)}\nLine 3`;
    writeFileSync(filePath, fileContent, "utf8");

    await runner.emitToolResult(
      makeReadResult("call-1", { path: filePath }, fileContent)
    );

    // Modify the file on disk
    writeFileSync(filePath, "Line 1\ndifferent text\nLine 3", "utf8");

    const messages: AgentMessage[] = [
      makeToolResultMessage("call-1", fileContent),
    ];
    const compiled = await runner.emitContext(messages);
    const text = firstText(compiled);

    // Disk staleness alone should not replace content under the KV-cache-first design
    expect(text).toBe(fileContent);
    expect(text).not.toContain("Results Archive");
  });

  it("should NOT replace content when the file is deleted on disk (no superseding read)", async () => {
    const { runner } = await loadExtension();

    const filePath = join(tempDir, "file.txt");
    const fileContent = `Line 1\n${"a".repeat(2100)}`;
    writeFileSync(filePath, fileContent, "utf8");

    await runner.emitToolResult(
      makeReadResult("call-1", { path: filePath }, fileContent)
    );

    unlinkSync(filePath);

    const messages: AgentMessage[] = [
      makeToolResultMessage("call-1", fileContent),
    ];
    const compiled = await runner.emitContext(messages);
    const text = firstText(compiled);

    expect(text).toBe(fileContent);
    expect(text).not.toContain("Results Archive");
  });

  it("should NOT replace an old read when newer read overlap is below threshold", async () => {
    const { runner } = await loadExtension();

    const filePath = join(tempDir, "file.txt");
    const lines = Array.from(
      { length: 200 },
      (_, i) => `Line ${i + 1} ${"x".repeat(100)}`
    );
    writeFileSync(filePath, lines.join("\n"), "utf8");

    const oldText = lines.join("\n");
    await runner.emitToolResult(
      makeReadResult(
        "call-1",
        { limit: 200, offset: 1, path: filePath },
        oldText
      )
    );

    // Newer read covers lines 150-180 (15.5% of old read)
    const newText = lines.slice(149, 180).join("\n");
    await runner.emitToolResult(
      makeReadResult(
        "call-2",
        { limit: 31, offset: 150, path: filePath },
        newText
      )
    );

    const messages: AgentMessage[] = [
      makeToolResultMessage("call-1", oldText),
      makeToolResultMessage("call-2", newText),
    ];

    const compiled = await runner.emitContext(messages);

    // Old read at index 0 of 2 messages: threshold = 0.60, coverage ~0.155
    expect(((compiled[0] as any)?.content?.[0] as { text: string }).text).toBe(
      oldText
    );
    expect(((compiled[1] as any)?.content?.[0] as { text: string }).text).toBe(
      newText
    );
  });

  it("should NOT trim a fully superseded read when the freed amount is below the batch threshold", async () => {
    // The old read is dead (superseded), but on its own it frees far fewer than
    // minBatchTokens and there is no window pressure, so batching holds it: we
    // don't spend a KV-cache invalidation on a tiny lone removal. It will flush
    // with the next batch (or when pressure/overflow forces it).
    const { runner } = await loadExtension({
      contextWindow: 200_000,
      percent: 30,
      tokens: 60_000,
    });

    const filePath = join(tempDir, "file.txt");
    const lines = Array.from(
      { length: 100 },
      (_, i) => `Line ${i + 1} ${"x".repeat(100)}`
    );
    writeFileSync(filePath, lines.join("\n"), "utf8");

    const text = lines.join("\n");
    // Old read fully covered by an identical newer read (coverage = 100%).
    await runner.emitToolResult(
      makeReadResult("call-1", { limit: 100, offset: 1, path: filePath }, text)
    );
    await runner.emitToolResult(
      makeReadResult("call-2", { limit: 100, offset: 1, path: filePath }, text)
    );

    const messages: AgentMessage[] = [
      makeToolResultMessage("call-1", text),
      makeToolResultMessage("call-2", text),
    ];

    const compiled = await runner.emitContext(messages);

    expect(((compiled[0] as any)?.content?.[0] as { text: string }).text).toBe(
      text
    );
    expect(((compiled[1] as any)?.content?.[0] as { text: string }).text).toBe(
      text
    );
  });

  it("should not invalidate read content if the disk change is outside the read line range", async () => {
    const { runner } = await loadExtension();

    const filePath = join(tempDir, "file.txt");
    const lines = Array.from(
      { length: 10 },
      (_, i) => `Line ${i + 1} ${"x".repeat(300)}`
    );
    writeFileSync(filePath, lines.join("\n"), "utf8");

    const readLines = lines.slice(4, 7);
    const readText = readLines.join("\n");

    await runner.emitToolResult(
      makeReadResult(
        "call-1",
        { limit: 3, offset: 5, path: filePath },
        readText
      )
    );

    lines[0] = "Line 1 changed completely";
    lines[1] = "Line 2 changed completely";
    writeFileSync(filePath, lines.join("\n"), "utf8");

    const messages: AgentMessage[] = [
      makeToolResultMessage("call-1", readText),
    ];
    const compiled = await runner.emitContext(messages);
    const text = firstText(compiled);

    expect(text).toBe(readText);
    expect(text).not.toContain("Results Archive");
  });

  it("should strip read-tool footer before hashing (user limit with more content)", async () => {
    const { runner } = await loadExtension();

    const filePath = join(tempDir, "file.txt");
    const lines = Array.from(
      { length: 10 },
      (_, i) => `Line ${i + 1} ${"x".repeat(800)}`
    );
    writeFileSync(filePath, lines.join("\n"), "utf8");

    const readLines = lines.slice(4, 7);
    const readText = readLines.join("\n");
    const rawTextWithFooter = `${readText}\n\n[7 more lines in file. Use offset=8 to continue.]`;

    await runner.emitToolResult(
      makeReadResult(
        "call-1",
        { limit: 3, offset: 5, path: filePath },
        rawTextWithFooter
      )
    );

    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(
      (e) => e.type === "custom" && e.customType === "results-archive"
    );
    expect(archiveEntry).toBeDefined();

    const arcData = (archiveEntry as any).data;
    expect(arcData.startLine).toBe(5);
    expect(arcData.lineHashes).toHaveLength(3);

    const messages: AgentMessage[] = [
      makeToolResultMessage("call-1", rawTextWithFooter),
    ];
    const compiled = await runner.emitContext(messages);
    const text = firstText(compiled);
    expect(text).toBe(rawTextWithFooter);
    expect(text).not.toContain("Results Archive");
  });

  it("should use details.truncation.content when available", async () => {
    const { runner } = await loadExtension();

    const filePath = join(tempDir, "file.txt");
    const fileContent = `Line 1\n${"a".repeat(3000)}\nLine 3`;
    writeFileSync(filePath, fileContent, "utf8");

    const truncatedContent = `Line 1\n${"a".repeat(2100)}`;
    const rawText = fileContent;

    await runner.emitToolResult(
      makeReadResult("call-1", { path: filePath }, rawText, {
        truncation: {
          content: truncatedContent,
          firstLineExceedsLimit: false,
          lastLinePartial: false,
          maxBytes: 50 * 1024,
          maxLines: 2000,
          outputBytes: Buffer.byteLength(truncatedContent, "utf-8"),
          outputLines: 1,
          totalBytes: Buffer.byteLength(fileContent, "utf-8"),
          totalLines: 3,
          truncated: true,
          truncatedBy: "bytes",
        },
      })
    );

    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(
      (e) => e.type === "custom" && e.customType === "results-archive"
    );
    expect(archiveEntry).toBeDefined();

    const arcData = (archiveEntry as any).data;
    expect(arcData.lineHashes).toHaveLength(2);
    expect(arcData.startLine).toBe(1);
    expect(arcData.originalContent).toBe(
      JSON.stringify([{ text: rawText, type: "text" }])
    );
  });

  it("should skip archiving when first line exceeds byte limit", async () => {
    const { runner } = await loadExtension();

    const filePath = join(tempDir, "file.txt");
    writeFileSync(filePath, "placeholder", "utf8");

    await runner.emitToolResult(
      makeReadResult(
        "call-1",
        { path: filePath },
        "[Line 1 is 60KB, exceeds 50KB limit. Use bash: ...]",
        {
          truncation: {
            content: "",
            firstLineExceedsLimit: true,
            lastLinePartial: false,
            maxBytes: 50 * 1024,
            maxLines: 2000,
            outputBytes: 0,
            outputLines: 0,
            totalBytes: 60_000,
            totalLines: 1,
            truncated: true,
            truncatedBy: "bytes",
          },
        }
      )
    );

    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(
      (e) => e.type === "custom" && e.customType === "results-archive"
    );
    expect(archiveEntry).toBeUndefined();
  });

  it("should recall results correctly using recall_result tool", async () => {
    const { result, runner } = await loadExtension();

    const filePath = join(tempDir, "file.txt");
    const fileContent = `Line 1\n${"a".repeat(2100)}`;
    writeFileSync(filePath, fileContent, "utf8");

    await runner.emitToolResult(
      makeReadResult("call-1", { path: filePath }, fileContent)
    );

    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(
      (e) => e.type === "custom" && e.customType === "results-archive"
    );
    expect(archiveEntry).toBeDefined();
    const { data: arcData } = archiveEntry as {
      data: { pointerId: string };
    };
    const { pointerId } = arcData;

    const [ext] = result.extensions;
    if (!ext) {
      throw new Error("Extension not loaded");
    }
    const recallTool = ext.tools.get("recall_result");
    if (!recallTool) {
      throw new Error("recall_result tool not registered");
    }

    // Recall active result
    const activeResult = await recallTool.definition.execute(
      "recall-call-1",
      { pointer_id: pointerId },
      new AbortController().signal,
      () => undefined,
      runner.createContext()
    );

    expect((activeResult as { isError?: boolean }).isError).toBeFalsy();
    expect(
      (activeResult as { details?: { status?: string } }).details?.status
    ).toBe("active");
    expect((activeResult.content?.[0] as { text: string }).text).toBe(
      fileContent
    );

    // Modify file -> make it stale
    writeFileSync(filePath, "modified text", "utf8");

    // Recall stale result
    const staleResult = await recallTool.definition.execute(
      "recall-call-2",
      { pointer_id: pointerId },
      new AbortController().signal,
      () => undefined,
      runner.createContext()
    );

    expect((staleResult as { isError?: boolean }).isError).toBeFalsy();
    expect(
      (staleResult as { details?: { status?: string } }).details?.status
    ).toBe("invalidated");
    const staleText = (staleResult.content?.[0] as { text: string }).text;
    expect(staleText).toContain("<recalled-stale-content>");
    expect(staleText).toContain("Warning: Pointer");
    expect(staleText).toContain(fileContent);
    expect(staleText).toContain("</recalled-stale-content>");
  });

  it("should return not_found error from recall_result for unknown pointer", async () => {
    const { result, runner } = await loadExtension();

    const [ext] = result.extensions;
    if (!ext) {
      throw new Error("Extension not loaded");
    }
    const recallTool = ext.tools.get("recall_result");
    if (!recallTool) {
      throw new Error("recall_result tool not registered");
    }

    const result1 = await recallTool.definition.execute(
      "recall-call-1",
      { pointer_id: "ptr_does_not_exist" },
      new AbortController().signal,
      () => undefined,
      runner.createContext()
    );

    expect((result1 as { isError?: boolean }).isError).toBe(true);
    expect((result1 as { details?: { status?: string } }).details?.status).toBe(
      "not_found"
    );
    expect((result1.content?.[0] as { text: string }).text).toContain(
      "not found"
    );
  });

  it("should return error from recall_result when originalContent is corrupted", async () => {
    const { result, runner } = await loadExtension();

    // Inject a corrupt archive entry directly into the session.
    sessionManager.appendCustomEntry("results-archive", {
      lineHashes: [],
      originalContent: "this is not valid json",
      parameterKey: join(tempDir, "file.txt"),
      pointerId: "ptr_corrupt",
      startLine: 1,
      timestamp: Date.now(),
      toolCallId: "call-corrupt",
      toolName: "read",
    });

    const [ext] = result.extensions;
    if (!ext) {
      throw new Error("Extension not loaded");
    }
    const recallTool = ext.tools.get("recall_result");
    if (!recallTool) {
      throw new Error("recall_result tool not registered");
    }

    const result1 = await recallTool.definition.execute(
      "recall-call-1",
      { pointer_id: "ptr_corrupt" },
      new AbortController().signal,
      () => undefined,
      runner.createContext()
    );

    expect((result1 as { isError?: boolean }).isError).toBe(true);
    expect((result1 as { details?: { status?: string } }).details?.status).toBe(
      "error"
    );
  });

  it("should gracefully handle a corrupt archive entry in context compilation", async () => {
    const { runner } = await loadExtension();

    // Inject a corrupt archive entry with null lineHashes.
    sessionManager.appendCustomEntry("results-archive", {
      lineHashes: null as any,
      originalContent: "[]",
      parameterKey: join(tempDir, "file.txt"),
      pointerId: "ptr_corrupt",
      startLine: 1,
      timestamp: Date.now(),
      toolCallId: "call-corrupt",
      toolName: "read",
    });

    const messages: AgentMessage[] = [
      makeToolResultMessage("call-corrupt", "content"),
    ];

    // The context handler should catch the error and return undefined,
    // leaving the original messages untouched.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    const compiled = await runner.emitContext(messages);
    warnSpy.mockRestore();

    expect(firstText(compiled)).toBe("content");
  });

  it("should gracefully handle a tool_result with invalid input", async () => {
    const { runner } = await loadExtension();

    // Pass input as null to make policy.getParameterKey throw; the handler
    // should catch the error and return undefined without crashing.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    const emitResult = await runner.emitToolResult({
      content: [{ text: "Line 1", type: "text" }],
      details: undefined,
      input: null as any,
      isError: false,
      toolCallId: "call-bad",
      toolName: "read",
      type: "tool_result",
    } as any);
    warnSpy.mockRestore();

    expect(emitResult).toBeUndefined();

    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(
      (e) => e.type === "custom" && e.customType === "results-archive"
    );
    expect(archiveEntry).toBeUndefined();
  });

  it("should ignore unsupported tool results", async () => {
    const { runner } = await loadExtension();

    const emitResult = await runner.emitToolResult({
      content: [{ text: "wrote file", type: "text" }],
      details: undefined,
      input: { content: "hello", path: "file.txt" },
      isError: false,
      toolCallId: "call-write",
      toolName: "write",
      type: "tool_result",
    } as any);

    expect(emitResult).toBeUndefined();

    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(
      (e) => e.type === "custom" && e.customType === "results-archive"
    );
    expect(archiveEntry).toBeUndefined();
  });

  it("should archive bash tool results", async () => {
    const { runner } = await loadExtension();

    const emitResult = await runner.emitToolResult(
      makeBashResult("call-bash", "echo hello", "hello")
    );

    expect(emitResult).toBeUndefined();

    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(
      (e) => e.type === "custom" && e.customType === "results-archive"
    );
    expect(archiveEntry).toBeDefined();

    const arcData = (archiveEntry as any).data;
    expect(arcData.toolName).toBe("bash");
    expect(arcData.parameterKey).toBe("echo hello");
    expect(arcData.stalenessStrategy).toBe("immutable");
    expect(arcData.supersessionStrategy).toBe("exact-key");
  });

  it("should not supersede bash results with different commands", async () => {
    const { runner } = await loadExtension();

    const text1 = "output 1";
    const text2 = "output 2";

    await runner.emitToolResult(
      makeBashResult("call-bash-1", "git status", text1)
    );
    await runner.emitToolResult(
      makeBashResult("call-bash-2", "git log", text2)
    );

    const messages: AgentMessage[] = [
      makeToolResultMessage("call-bash-1", text1, "bash"),
      makeToolResultMessage("call-bash-2", text2, "bash"),
    ];

    const compiled = await runner.emitContext(messages);

    expect(((compiled[0] as any)?.content?.[0] as { text: string }).text).toBe(
      text1
    );
    expect(((compiled[1] as any)?.content?.[0] as { text: string }).text).toBe(
      text2
    );
  });

  it("should recall bash results as immutable/stale", async () => {
    const { result, runner } = await loadExtension();

    const output = "git status output";
    await runner.emitToolResult(
      makeBashResult("call-bash", "git status", output)
    );

    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(
      (e) => e.type === "custom" && e.customType === "results-archive"
    );
    expect(archiveEntry).toBeDefined();
    const { pointerId } = (archiveEntry as any).data;

    const [ext] = result.extensions;
    if (!ext) {
      throw new Error("Extension not loaded");
    }
    const recallTool = ext.tools.get("recall_result");
    if (!recallTool) {
      throw new Error("recall_result tool not registered");
    }

    const recallResult = await recallTool.definition.execute(
      "recall-call",
      { pointer_id: pointerId },
      new AbortController().signal,
      () => undefined,
      runner.createContext()
    );

    expect((recallResult as { isError?: boolean }).isError).toBeFalsy();
    expect(
      (recallResult as { details?: { status?: string } }).details?.status
    ).toBe("invalidated");
    const [firstContent] = recallResult.content ?? [];
    const { text } = firstContent as { text: string };
    expect(text).toContain("<recalled-stale-content>");
    expect(text).toContain(output);
  });

  it("should archive grep tool results", async () => {
    const { runner } = await loadExtension();

    await runner.emitToolResult(
      makeGrepResult("call-grep", "foo", "file.ts:1:foo")
    );

    const branch = sessionManager.getBranch();
    const archiveEntry = branch.find(
      (e) => e.type === "custom" && e.customType === "results-archive"
    );
    expect(archiveEntry).toBeDefined();

    const arcData = (archiveEntry as any).data;
    expect(arcData.toolName).toBe("grep");
    expect(arcData.parameterKey).toBe("foo");
    expect(arcData.stalenessStrategy).toBe("immutable");
    expect(arcData.supersessionStrategy).toBe("exact-key");
  });
});
