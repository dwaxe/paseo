import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { AgentSnapshotPayloadSchema } from "@getpaseo/protocol/messages";
import { renderJson } from "../../output/json.js";
import { resolveCallerAgentId as resolveRunCallerAgentId } from "../../utils/caller-agent.js";
import {
  resolveExistingRunWorkspace,
  runRunCommand,
  toRunResult,
  agentRunSchema,
  finishCreatedAgentRun,
  waitsForFinish,
  type AgentRunOptions,
} from "./run";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

// Answers fetchAgent the way a daemon does: an unknown id is an error.
function daemonWithAgents(...agentIds: string[]) {
  return {
    async fetchAgent({ agentId }: { agentId: string }) {
      if (!agentIds.includes(agentId)) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      return { agent: { id: agentId } };
    },
  };
}

describe("run wait policy", () => {
  it("waits by default and stops waiting on --no-wait or a legacy alias", () => {
    expect(waitsForFinish({})).toBe(true);
    expect(waitsForFinish({ wait: false })).toBe(false);
    expect(waitsForFinish({ background: true })).toBe(false);
    expect(waitsForFinish({ detach: true })).toBe(false);
  });
});

describe("run invocation receipts", () => {
  const snapshot = AgentSnapshotPayloadSchema.parse({
    id: "created-agent",
    provider: "codex",
    cwd: "/workspace",
    model: null,
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
  });

  it("includes a starting run's identity in JSON output", () => {
    const data = toRunResult(
      {
        ...snapshot,
        activeRun: { runId: "initial-run", phase: "starting", turnId: null },
      },
      undefined,
      "initial-run",
    );
    expect(
      JSON.parse(renderJson({ type: "single", data, schema: agentRunSchema }, { format: "json" })),
    ).toMatchObject({ agentId: "created-agent", runId: "initial-run" });
  });

  it("retains a completed creation run when its active run has cleared", () => {
    expect(
      toRunResult(
        { ...snapshot, activeRun: null, latestRunId: "initial-run" },
        undefined,
        "initial-run",
      ).runId,
    ).toBe("initial-run");
  });

  it("keeps the creation run's identity when a successor starts before foreground wait finishes", () => {
    expect(
      toRunResult(
        {
          ...snapshot,
          activeRun: { runId: "successor-run", phase: "running", turnId: "successor-turn" },
          latestRunId: "successor-run",
        },
        "completed",
        "initial-run",
      ).runId,
    ).toBe("initial-run");
    expect(
      toRunResult({ ...snapshot, latestRunId: "successor-run" }, "completed", null).runId,
    ).toBeNull();
  });

  it.each([
    { wait: true, initialRunId: "initial-run" },
    { wait: false, initialRunId: "initial-run" },
    { wait: true, initialRunId: null },
    { wait: false, initialRunId: null },
  ])("keeps exact or unavailable creation proof in JSON: %j", async ({ wait, initialRunId }) => {
    const successor = {
      ...snapshot,
      status: "running" as const,
      activeRun: { runId: "successor-run", phase: "running" as const, turnId: "native-B" },
      latestRunId: "successor-run",
    };
    const waits: Array<{ agentId: string; timeoutMs?: number }> = [];
    let closed = false;
    const result = await finishCreatedAgentRun({
      client: {
        async waitForFinish(agentId, timeoutMs) {
          waits.push({ agentId, timeoutMs });
          return {
            status: "idle",
            final: { ...successor, status: "idle", activeRun: null },
            error: null,
            lastMessage: null,
          };
        },
        async close() {
          closed = true;
        },
      },
      creation: { agent: successor, initialRunId },
      wait,
      waitTimeoutMs: 1234,
    });
    expect(JSON.parse(renderJson(result, { format: "json" }))).toMatchObject({
      agentId: snapshot.id,
      runId: initialRunId,
      status: wait ? "completed" : "running",
    });
    expect(waits).toEqual(wait ? [{ agentId: snapshot.id, timeoutMs: 1234 }] : []);
    expect(closed).toBe(true);
  });

  it("does not infer a creation invocation from a current or latest run", () => {
    expect(
      toRunResult({
        ...snapshot,
        activeRun: { runId: "successor-run", phase: "running", turnId: "native-B" },
        latestRunId: "successor-run",
      }).runId,
    ).toBeNull();
  });
});

describe("managed agent caller context", () => {
  it("uses a trimmed PASEO_AGENT_ID when the target daemon runs that agent", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("parent-agent"), {
        PASEO_AGENT_ID: "  parent-agent  ",
      }),
    ).resolves.toBe("parent-agent");
  });

  it("runs without a caller when PASEO_AGENT_ID belongs to another daemon", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("other-agent"), {
        PASEO_AGENT_ID: "parent-agent",
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["DAEMON_CONNECTION_LOST", "DAEMON_REQUEST_TIMEOUT"] as const)(
    "preserves %s instead of dropping the caller",
    async (code) => {
      const disconnectedDaemon = {
        async fetchAgent(): Promise<never> {
          throw new DaemonConnectionError("Caller lookup transport failed", code);
        },
      };

      await expect(
        resolveRunCallerAgentId(disconnectedDaemon, { PASEO_AGENT_ID: "parent-agent" }),
      ).rejects.toBeInstanceOf(DaemonConnectionError);
    },
  );

  it("omits blank caller ids", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents(), { PASEO_AGENT_ID: "   " }),
    ).resolves.toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  async function expectInvalidOptions(
    options: Omit<AgentRunOptions, "daemonTarget">,
    messageMatch: RegExp,
  ) {
    await expect(
      runRunCommand("do something", { ...options, daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand(
        "do something",
        { newWorkspace: "worktree", provider: undefined, daemonTarget },
        {} as never,
      ),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });
});
