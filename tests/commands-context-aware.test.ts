import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCommand, createIssueWithAgent } from "../src/commands.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return 1;
    }),
    sendChatAction: vi.fn(),
  };
});

vi.mock("../src/acp-bridge.js", async () => {
  const actual = await vi.importActual("../src/acp-bridge.js") as Record<string, unknown>;
  return {
    ...actual,
    handleAcpCommand: vi.fn(),
    sendAgentPickerPage: vi.fn(async () => {}),
    getSessions: vi.fn(async () => []),
    buildAgentPickerContent: vi.fn(async () => ({ text: "picker", keyboard: [] })),
    resolveAgentByName: vi.fn(async (_ctx: unknown, name: string) => {
      if (name === "builder") return { id: "uuid-builder", name: "Builder" };
      if (name === "tester") return { id: "uuid-tester", name: "Tester" };
      return null;
    }),
  };
});

vi.mock("../src/topic-projects.js", async () => ({
  resolveMappedProjectIdForTopic: vi.fn(async () => undefined),
}));

const AGENTS = [
  { id: "uuid-ceo", name: "CEO", role: "ceo", status: "active" },
  { id: "uuid-builder", name: "Builder", role: "worker", status: "active" },
  { id: "uuid-tester", name: "Tester", role: "worker", status: "active" },
];

function mockCtx(): PluginContext {
  return {
    http: {
      fetch: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) }),
    },
    metrics: { write: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => { stateStore[key.stateKey] = value; }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: { emit: vi.fn(), on: vi.fn() },
    companies: {
      list: vi.fn().mockResolvedValue([{ id: "co-1", name: "Acme" }]),
      get: vi.fn().mockResolvedValue({ id: "co-1", name: "Acme", issuePrefix: "PROJ" }),
    },
    projects: {
      list: vi.fn().mockResolvedValue([
        { id: "proj-1", name: "Alpha" },
        { id: "proj-2", name: "Beta" },
      ]),
      get: vi.fn().mockResolvedValue(null),
    },
    agents: {
      list: vi.fn().mockResolvedValue(AGENTS),
      sessions: { create: vi.fn(), close: vi.fn() },
    },
    issues: {
      list: vi.fn().mockResolvedValue([
        { id: "i1", identifier: "PROJ-1", title: "Fix bug", status: "todo", project: { name: "Alpha", id: "proj-1" }, projectId: "proj-1" },
        { id: "i2", identifier: "PROJ-2", title: "Add feat", status: "done", project: { name: "Beta", id: "proj-2" }, projectId: "proj-2" },
      ]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "new-issue", identifier: "PROJ-99" }),
      update: vi.fn().mockImplementation(async (id: string) => ({ id, identifier: "PROJ-99", title: "Task" })),
    },
  } as unknown as PluginContext;
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
  vi.clearAllMocks();
});

// --- 3.3: /create @agent syntax ---

describe("/create with @agent", () => {
  it("resolves named agent and creates issue", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "create", "@builder Fix the login bug", undefined, undefined, undefined, "co-1");
    const msg = sentMessages.find((m) => m.text.includes("Task created") || m.text.includes("created"));
    expect(msg).toBeDefined();
    expect(ctx.issues.create).toHaveBeenCalled();
    const createCall = (ctx.issues.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(createCall.assigneeAgentId).toBeUndefined(); // created without assignee first
  });

  it("shows error when @agent not found", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "create", "@unknown-agent Do something", undefined, undefined, undefined, "co-1");
    expect(sentMessages.some((m) => m.text.toLowerCase().includes("not found"))).toBe(true);
    expect(ctx.issues.create).not.toHaveBeenCalled();
  });

  it("shows picker when no @agent prefix", async () => {
    const { sendAgentPickerPage } = await import("../src/acp-bridge.js");
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "create", "Create a report", undefined, undefined, undefined, "co-1");
    expect(sendAgentPickerPage).toHaveBeenCalled();
    expect(ctx.issues.create).not.toHaveBeenCalled();
  });

  it("saves pending text to state when showing picker", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "create", "Build the dashboard", 5, undefined, undefined, "co-1", undefined, undefined, "user-99");
    const pendingKey = "create_pending_chat-1_user-99";
    const saved = stateStore[pendingKey] as Record<string, unknown>;
    expect(saved).toBeDefined();
    expect(saved.text).toBe("Build the dashboard");
    expect(saved.messageThreadId).toBe(5);
  });

  it("extracts title and description from long text with @agent", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "create", "@builder Fix the auth bug. Also check token refresh.", undefined, undefined, undefined, "co-1");
    const updateCall = (ctx.issues.update as ReturnType<typeof vi.fn>).mock.calls[0];
    // update is called with status + assigneeAgentId
    expect(updateCall).toBeDefined();
    const createArg = (ctx.issues.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(createArg.title).toMatch(/Fix the auth bug/);
  });
});

// --- 3.3: createIssueWithAgent ---

describe("createIssueWithAgent", () => {
  it("creates issue and assigns agent", async () => {
    const ctx = mockCtx();
    await createIssueWithAgent(ctx, "tok", "chat-1", "co-1", "uuid-builder", "Builder", "Fix login", undefined, undefined, undefined);
    expect(ctx.issues.create).toHaveBeenCalledWith(expect.objectContaining({ title: "Fix login", companyId: "co-1" }));
    expect(ctx.issues.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ assigneeAgentId: "uuid-builder" }), "co-1");
    const confirmation = sentMessages[0]!;
    expect(confirmation.text).toContain("Task created");
    expect(confirmation.text).toContain("Builder");
  });

  it("includes link in confirmation when linkBaseUrl and issuePrefix available", async () => {
    const ctx = mockCtx();
    await createIssueWithAgent(ctx, "tok", "chat-1", "co-1", "uuid-builder", "Builder", "Task X", undefined, undefined, "https://app.example.com");
    const msg = sentMessages[0]!.text;
    expect(msg).toContain("app.example.com");
  });
});

// --- 3.4: /status context-aware ---

describe("/status branch a — general (no thread)", () => {
  it("shows global status when no messageThreadId", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "status", "", undefined, undefined, undefined, "co-1");
    const msg = sentMessages[0]!.text;
    expect(msg).toContain("Paperclip Status");
    expect(msg).toContain("Active agents");
  });
});

describe("/status branch b — project topic", () => {
  it("shows project-scoped status when topic is mapped to a project", async () => {
    stateStore["topic-map-chat-1"] = {
      Alpha: { projectId: "proj-1", projectName: "Alpha", topicId: "10" },
    };
    const ctx = mockCtx();
    const { getSessions } = await import("../src/acp-bridge.js");
    (getSessions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await handleCommand(ctx, "tok", "chat-1", "status", "", 10, undefined, undefined, "co-1");
    const msg = sentMessages[0]!.text;
    expect(msg).toContain("Alpha");
    expect(msg).toContain("Status");
  });
});

describe("/status branch c — session topic", () => {
  it("shows session status when topic has active session", async () => {
    const { getSessions } = await import("../src/acp-bridge.js");
    (getSessions as ReturnType<typeof vi.fn>).mockResolvedValue([{
      sessionId: "sess-1",
      agentId: "uuid-builder",
      agentName: "builder",
      agentDisplayName: "Builder",
      transport: "native",
      status: "active",
      spawnedAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:10:00Z",
      topicId: 42,
    }]);
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "status", "", 42, undefined, undefined, "co-1");
    const msg = sentMessages[0]!.text;
    expect(msg).toContain("Session Status");
    expect(msg).toContain("sess"); // sessionId present (may be MarkdownV2-escaped)
    expect(msg).toContain("native");
  });

  it("includes action buttons (Close Session)", async () => {
    const { getSessions } = await import("../src/acp-bridge.js");
    (getSessions as ReturnType<typeof vi.fn>).mockResolvedValue([{
      sessionId: "sess-buttons",
      transport: "native",
      status: "active",
      spawnedAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
      topicId: 42,
    }]);
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "status", "", 42, undefined, undefined, "co-1");
    const opts = sentMessages[0]!.options as Record<string, unknown>;
    const keyboard = opts.inlineKeyboard as Array<Array<{ callback_data?: string }>>;
    const hasClose = keyboard.some((row) => row.some((b) => b.callback_data?.startsWith("acp_close_")));
    expect(hasClose).toBe(true);
  });

  it("session branch takes priority over project branch", async () => {
    stateStore["topic-map-chat-1"] = {
      Alpha: { projectId: "proj-1", projectName: "Alpha", topicId: "42" },
    };
    const { getSessions } = await import("../src/acp-bridge.js");
    (getSessions as ReturnType<typeof vi.fn>).mockResolvedValue([{
      sessionId: "sess-priority",
      transport: "native",
      status: "active",
      spawnedAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
      topicId: 42,
    }]);
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "status", "", 42, undefined, undefined, "co-1");
    const msg = sentMessages[0]!.text;
    expect(msg).toContain("Session Status");
    expect(msg).not.toContain("Status — Alpha");
  });
});

// --- 3.5: /issues context-aware ---

describe("/issues branch a — no topic (default)", () => {
  it("shows all issues when not in a mapped topic", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "issues", "", undefined, undefined, undefined, "co-1");
    const msg = sentMessages[0]!.text;
    expect(msg).toContain("Open Issues");
  });

  it("filters by text arg when not in mapped topic", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "issues", "Beta", undefined, undefined, undefined, "co-1");
    const msg = sentMessages[0]!.text;
    expect(msg).toContain("Add feat"); // PROJ-2 is in Beta
    expect(msg).not.toContain("Fix bug"); // PROJ-1 is in Alpha
  });
});

describe("/issues branch b — project topic", () => {
  it("auto-detects project from topic mapping and filters issues", async () => {
    stateStore["topic-map-chat-1"] = {
      Alpha: { projectId: "proj-1", projectName: "Alpha", topicId: "10" },
    };
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "issues", "", 10, undefined, undefined, "co-1");
    const msg = sentMessages[0]!.text;
    expect(msg).toContain("Issues");
    expect(msg).toContain("Alpha"); // project name in header (may be MarkdownV2-escaped)
    expect(msg).toContain("Fix bug"); // PROJ-1 is in Alpha
    expect(msg).not.toContain("Add feat"); // PROJ-2 is in Beta
  });

  it("shows project name in header", async () => {
    stateStore["topic-map-chat-1"] = {
      Beta: { projectId: "proj-2", projectName: "Beta", topicId: "20" },
    };
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "issues", "", 20, undefined, undefined, "co-1");
    expect(sentMessages[0]!.text).toContain("Beta");
  });

  it("shows 'no issues found' when project has no matching issues", async () => {
    stateStore["topic-map-chat-1"] = {
      Gamma: { projectId: "proj-9", projectName: "Gamma", topicId: "30" },
    };
    const ctx = mockCtx();
    await handleCommand(ctx, "tok", "chat-1", "issues", "", 30, undefined, undefined, "co-1");
    expect(sentMessages[0]!.text).toContain("No issues found");
  });
});
