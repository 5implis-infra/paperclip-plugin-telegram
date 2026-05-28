import { describe, it, expect } from "vitest";
import {
  formatIssueCreated,
  formatIssueDone,
  formatIssueAssigned,
  formatApprovalCreated,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
} from "../src/formatters.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

function mockEvent(overrides: Record<string, unknown> = {}): PluginEvent {
  return {
    eventType: "issue.created",
    entityId: "iss-123",
    entityType: "issue",
    companyId: "co-1",
    occurredAt: new Date().toISOString(),
    payload: { identifier: "PROJ-42", title: "Test issue", ...overrides },
  } as PluginEvent;
}

describe("formatIssueCreated", () => {
  it("includes identifier and title", () => {
    const msg = formatIssueCreated(mockEvent());
    expect(msg.text).toContain("PROJ\\-42");
    expect(msg.text).toContain("Test issue");
  });

  it("falls back to entityId when no identifier", () => {
    const msg = formatIssueCreated(mockEvent({ identifier: undefined }));
    expect(msg.text).toContain("iss\\-123");
  });

  it("uses MarkdownV2 parse mode", () => {
    const msg = formatIssueCreated(mockEvent());
    expect(msg.options.parseMode).toBe("MarkdownV2");
  });

  it("includes metadata fields when available", () => {
    const msg = formatIssueCreated(mockEvent({
      status: "open",
      priority: "high",
      assigneeName: "Alice",
      projectName: "Backend",
    }));
    expect(msg.text).toContain("open");
    expect(msg.text).toContain("high");
    expect(msg.text).toContain("Alice");
    expect(msg.text).toContain("Backend");
  });

  it("includes description snippet", () => {
    const msg = formatIssueCreated(mockEvent({ description: "A long description about this issue" }));
    expect(msg.text).toContain("A long description");
  });

  it("truncates long descriptions at word boundary", () => {
    const words = Array(50).fill("word").join(" ");
    const msg = formatIssueCreated(mockEvent({ description: words }));
    expect(msg.text).toContain("\\.\\.\\.");
    expect(msg.text.length).toBeLessThan(words.length * 2);
  });

  it("omits metadata line when no metadata", () => {
    const msg = formatIssueCreated(mockEvent({
      status: undefined,
      priority: undefined,
      assigneeName: undefined,
      projectName: undefined,
    }));
    expect(msg.text).not.toContain("\\|");
  });
});

describe("formatIssueDone", () => {
  it("includes identifier and done text", () => {
    const msg = formatIssueDone(mockEvent());
    expect(msg.text).toContain("PROJ\\-42");
    expect(msg.text).toContain("done");
  });

  it("falls back to entityId", () => {
    const msg = formatIssueDone(mockEvent({ identifier: undefined }));
    expect(msg.text).toContain("iss\\-123");
  });

  it("includes comment when provided", () => {
    const msg = formatIssueDone(mockEvent({ comment: "Board prep package completed for Q3" }));
    expect(msg.text).toContain("Board prep package completed for Q3");
  });

  it("truncates long comments", () => {
    const longComment = Array(80).fill("word").join(" ");
    const msg = formatIssueDone(mockEvent({ comment: longComment }));
    expect(msg.text).toContain("\\.\\.\\.");
  });

  it("omits comment section when no comment", () => {
    const msg = formatIssueDone(mockEvent());
    // Should only have the title and done line, no blockquote
    const lines = msg.text.split("\n").filter((l: string) => l.trim());
    expect(lines.length).toBe(2);
  });
});

describe("formatIssueAssigned", () => {
  it("shows the assigned user when assigning from nobody", () => {
    const msg = formatIssueAssigned(mockEvent({
      assigneeUserId: "user-me",
      assigneeName: "Nuno",
      _previous: { assigneeUserId: null, assigneeName: null },
    }));
    expect(msg.text).toContain("Issue Assigned");
    expect(msg.text).toContain("PROJ\\-42");
    expect(msg.text).toContain("Nuno");
    // No previous-name line
    expect(msg.text).not.toContain("→");
  });

  it("shows 'previous → new' when reassigning from another user", () => {
    const msg = formatIssueAssigned(mockEvent({
      assigneeUserId: "user-me",
      assigneeName: "Nuno",
      _previous: { assigneeUserId: "user-other", assigneeName: "Alice" },
    }));
    expect(msg.text).toContain("Alice");
    expect(msg.text).toContain("Nuno");
    expect(msg.text).toContain("→");
  });

  it("shows 'Unassigned' when the new assignee is null", () => {
    const msg = formatIssueAssigned(mockEvent({
      assigneeUserId: null,
      assigneeName: null,
      _previous: { assigneeUserId: "user-me", assigneeName: "Nuno" },
    }));
    expect(msg.text).toContain("Unassigned");
  });

  it("uses MarkdownV2 parse mode", () => {
    const msg = formatIssueAssigned(mockEvent({ assigneeName: "Nuno" }));
    expect(msg.options.parseMode).toBe("MarkdownV2");
  });

  it("falls back to entityId when no identifier", () => {
    const msg = formatIssueAssigned(mockEvent({ identifier: undefined, assigneeName: "Nuno" }));
    expect(msg.text).toContain("iss\\-123");
  });
});

describe("formatApprovalCreated", () => {
  it("includes approve and reject buttons", () => {
    const msg = formatApprovalCreated(mockEvent({
      type: "deploy",
      approvalId: "apr-1",
      title: "Deploy to prod",
    }));
    expect(msg.options.inlineKeyboard).toBeDefined();
    const buttons = msg.options.inlineKeyboard![0];
    expect(buttons.length).toBe(2);
    expect(buttons[0].text).toBe("Approve");
    expect(buttons[0].callback_data).toBe("approve_apr-1");
    expect(buttons[1].text).toBe("Reject");
    expect(buttons[1].callback_data).toBe("reject_apr-1");
  });

  it("falls back to entityId for approvalId", () => {
    const msg = formatApprovalCreated(mockEvent({ approvalId: undefined }));
    const buttons = msg.options.inlineKeyboard![0];
    expect(buttons[0].callback_data).toBe("approve_iss-123");
  });

  it("includes agent name when provided", () => {
    const msg = formatApprovalCreated(mockEvent({
      agentName: "Builder",
      type: "deploy",
    }));
    expect(msg.text).toContain("Builder");
  });

  it("includes linked issues", () => {
    const msg = formatApprovalCreated(mockEvent({
      linkedIssues: [
        { identifier: "ISS-1", title: "First", status: "open" },
        { identifier: "ISS-2", title: "Second", status: "done" },
      ],
    }));
    expect(msg.text).toContain("ISS\\-1");
    expect(msg.text).toContain("ISS\\-2");
    expect(msg.text).toContain("Linked Issues");
  });

  it("truncates description at word boundary", () => {
    const longDesc = Array(80).fill("word").join(" ");
    const msg = formatApprovalCreated(mockEvent({ description: longDesc }));
    expect(msg.text).toContain("\\.\\.\\.");
  });
});

describe("formatAgentError", () => {
  it("includes agent name and error", () => {
    const msg = formatAgentError(mockEvent({
      agentName: "Builder",
      error: "Connection refused",
    }));
    expect(msg.text).toContain("Builder");
    expect(msg.text).toContain("Connection refused");
  });

  it("truncates long error messages", () => {
    const longError = "x".repeat(600);
    const msg = formatAgentError(mockEvent({ error: longError }));
    expect(msg.text).toContain("\\.\\.\\.");
    expect(msg.text).not.toContain("x".repeat(501));
  });

  it("falls back to entityId for agent name", () => {
    const msg = formatAgentError(mockEvent({ agentName: undefined, name: undefined }));
    expect(msg.text).toContain("iss\\-123");
  });
});

describe("formatAgentRunStarted", () => {
  it("includes agent name", () => {
    const msg = formatAgentRunStarted(mockEvent({ agentName: "Deployer" }));
    expect(msg.text).toContain("Deployer");
    expect(msg.text).toContain("started");
  });

  it("disables notification", () => {
    const msg = formatAgentRunStarted(mockEvent());
    expect(msg.options.disableNotification).toBe(true);
  });
});

describe("formatAgentRunFinished", () => {
  it("includes agent name and completion text", () => {
    const msg = formatAgentRunFinished(mockEvent({ agentName: "Deployer" }));
    expect(msg.text).toContain("Deployer");
    expect(msg.text).toContain("completed");
  });

  it("disables notification", () => {
    const msg = formatAgentRunFinished(mockEvent());
    expect(msg.options.disableNotification).toBe(true);
  });
});

// --- Session button (Etapa 4.1) ---

describe("formatAgentError — enableSessionButton", () => {
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const runId = "run-abc123";

  it("adds session button row when enableSessionButton is true", () => {
    const msg = formatAgentError(
      mockEvent({ agentId, runId, error: "boom" }),
      undefined,
      { enableSessionButton: true },
    );
    const keyboard = msg.options.inlineKeyboard!;
    const sessionRow = keyboard.find((row) => row.some((btn) => "callback_data" in btn && (btn as { callback_data?: string }).callback_data?.startsWith("open_session_")));
    expect(sessionRow).toBeDefined();
    expect(sessionRow![0].text).toBe("🗂 Abrir/Criar Sessão");
  });

  it("callback_data encodes agentId and runId", () => {
    const msg = formatAgentError(
      mockEvent({ agentId, runId, error: "boom" }),
      undefined,
      { enableSessionButton: true },
    );
    const keyboard = msg.options.inlineKeyboard!;
    const sessionBtn = keyboard.flat().find((btn) => (btn as { callback_data?: string }).callback_data?.startsWith("open_session_")) as { callback_data: string };
    expect(sessionBtn.callback_data).toBe(`open_session_${agentId}_${runId}`);
  });

  it("callback_data uses only agentId when runId is absent", () => {
    const msg = formatAgentError(
      mockEvent({ agentId, error: "boom" }),
      undefined,
      { enableSessionButton: true },
    );
    const keyboard = msg.options.inlineKeyboard!;
    const sessionBtn = keyboard.flat().find((btn) => (btn as { callback_data?: string }).callback_data?.startsWith("open_session_")) as { callback_data: string };
    expect(sessionBtn.callback_data).toBe(`open_session_${agentId}`);
  });

  it("session button is in a separate row from URL buttons", () => {
    const msg = formatAgentError(
      mockEvent({ agentId, runId, error: "boom" }),
      { baseUrl: "https://app.example.com", issuePrefix: "PRJ" },
      { enableSessionButton: true },
    );
    const keyboard = msg.options.inlineKeyboard!;
    expect(keyboard.length).toBeGreaterThanOrEqual(2);
    const sessionRowIdx = keyboard.findIndex((row) => row.some((btn) => (btn as { callback_data?: string }).callback_data?.startsWith("open_session_")));
    const urlRowIdx = keyboard.findIndex((row) => row.some((btn) => "url" in btn));
    expect(sessionRowIdx).not.toBe(urlRowIdx);
  });

  it("does not add session button when enableSessionButton is false", () => {
    const msg = formatAgentError(mockEvent({ agentId, error: "boom" }), undefined, { enableSessionButton: false });
    const hasSessionBtn = msg.options.inlineKeyboard?.flat().some((btn) => (btn as { callback_data?: string }).callback_data?.startsWith("open_session_"));
    expect(hasSessionBtn).toBeFalsy();
  });

  it("does not add session button when opts2 is omitted", () => {
    const msg = formatAgentError(mockEvent({ agentId, error: "boom" }));
    const hasSessionBtn = msg.options.inlineKeyboard?.flat().some((btn) => (btn as { callback_data?: string }).callback_data?.startsWith("open_session_"));
    expect(hasSessionBtn).toBeFalsy();
  });
});

describe("formatAgentRunStarted — enableSessionButton", () => {
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const runId = "run-xyz789";

  it("adds session button when enableSessionButton is true", () => {
    const msg = formatAgentRunStarted(
      mockEvent({ agentId, agentName: "Builder", runId }),
      undefined,
      { enableSessionButton: true },
    );
    const sessionBtn = msg.options.inlineKeyboard?.flat().find((btn) => (btn as { callback_data?: string }).callback_data?.startsWith("open_session_")) as { callback_data: string } | undefined;
    expect(sessionBtn).toBeDefined();
    expect(sessionBtn!.callback_data).toBe(`open_session_${agentId}_${runId}`);
  });

  it("session button is in a separate row from View Run button", () => {
    const msg = formatAgentRunStarted(
      mockEvent({ agentId, agentName: "Builder", runId }),
      { baseUrl: "https://app.example.com" },
      { enableSessionButton: true },
    );
    const keyboard = msg.options.inlineKeyboard!;
    expect(keyboard.length).toBeGreaterThanOrEqual(2);
  });

  it("no session button without enableSessionButton flag", () => {
    const msg = formatAgentRunStarted(mockEvent({ agentId, agentName: "Builder", runId }));
    const hasSessionBtn = msg.options.inlineKeyboard?.flat().some((btn) => (btn as { callback_data?: string }).callback_data?.startsWith("open_session_"));
    expect(hasSessionBtn).toBeFalsy();
  });
});

describe("formatAgentRunFinished — enableSessionButton", () => {
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const runId = "run-done42";

  it("adds session button when enableSessionButton is true", () => {
    const msg = formatAgentRunFinished(
      mockEvent({ agentId, agentName: "Builder", runId }),
      undefined,
      { enableSessionButton: true },
    );
    const sessionBtn = msg.options.inlineKeyboard?.flat().find((btn) => (btn as { callback_data?: string }).callback_data?.startsWith("open_session_")) as { callback_data: string } | undefined;
    expect(sessionBtn).toBeDefined();
    expect(sessionBtn!.callback_data).toBe(`open_session_${agentId}_${runId}`);
  });

  it("no session button without enableSessionButton flag", () => {
    const msg = formatAgentRunFinished(mockEvent({ agentId, agentName: "Builder", runId }));
    const hasSessionBtn = msg.options.inlineKeyboard?.flat().some((btn) => (btn as { callback_data?: string }).callback_data?.startsWith("open_session_"));
    expect(hasSessionBtn).toBeFalsy();
  });
});
