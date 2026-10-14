import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type { AgentSession } from "../agent/agent-sdk-types.js";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const CREATED_AT = "2026-06-29T11:12:42.000Z";
const HEALTHY_UPDATED_AT = "2026-06-29T11:40:00.000Z";
const ORPHAN_ARCHIVED_AT = "2026-06-29T11:35:35.000Z";

interface StaleAgentFixture {
  healthyProjectId: string;
  healthyWorkspaceId: string;
  orphanWorkspaceId: string;
  healthyAgentId: string;
  orphanAgentId: string;
  paseoHomeRoot: string;
  cleanupPaths: string[];
}

test("agent fetch RPCs tolerate an agent whose workspace project record is gone", async () => {
  const fixture = seedStaleAgentFixture();
  let daemon: TestPaseoDaemon | null = null;
  let client: DaemonClient | null = null;

  try {
    daemon = await createTestPaseoDaemon({ paseoHomeRoot: fixture.paseoHomeRoot, cleanup: false });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();

    const agents = await client.fetchAgents({
      requestId: "req-agent-rpc-list",
      filter: { includeArchived: true },
    });
    const history = await client.fetchAgentHistory({
      requestId: "req-agent-rpc-history",
    });
    const orphanAgent = await client.fetchAgent({
      requestId: "req-agent-rpc-detail",
      agentId: fixture.orphanAgentId,
    });

    expect(agents.entries.map(toAgentEntrySummary)).toEqual([healthyAgentSummary(fixture)]);
    expect(agents.pageInfo).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
    });
    expect(history.entries.map(toAgentEntrySummary)).toEqual([healthyAgentSummary(fixture)]);
    expect(history.pageInfo).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
    });
    expect({
      agentId: orphanAgent?.agent.id,
      workspaceId: orphanAgent?.agent.workspaceId,
      archivedAt: orphanAgent?.agent.archivedAt,
      project: orphanAgent?.project,
    }).toEqual({
      agentId: fixture.orphanAgentId,
      workspaceId: fixture.orphanWorkspaceId,
      archivedAt: ORPHAN_ARCHIVED_AT,
      project: null,
    });
  } finally {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    for (const target of fixture.cleanupPaths) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

test("history search filters before pagination and keeps newest matches first", async () => {
  const fixture = seedStaleAgentFixture();
  let daemon: TestPaseoDaemon | null = null;
  let client: DaemonClient | null = null;
  try {
    const agentsDir = path.join(fixture.paseoHomeRoot, ".paseo", "agents");
    const template = JSON.parse(
      readFileSync(path.join(agentsDir, `${fixture.healthyAgentId}.json`), "utf8"),
    );
    for (const [id, title, updatedAt] of [
      ["newer-partial", "Unbilled usage", "2026-06-29T13:00:00.000Z"],
      ["unrelated", "Terminal resizing", "2026-06-29T12:00:00.000Z"],
      ["older-exact", "bill", "2026-06-28T12:00:00.000Z"],
    ]) {
      writeJson(path.join(agentsDir, `${id}.json`), {
        ...template,
        id,
        title,
        updatedAt,
        lastActivityAt: updatedAt,
      });
    }
    daemon = await createTestPaseoDaemon({ paseoHomeRoot: fixture.paseoHomeRoot, cleanup: false });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    const first = await client.fetchAgentHistory({ search: "bill", page: { limit: 1 } });
    expect(first.entries.map((entry) => entry.agent.id)).toEqual(["newer-partial"]);
    expect(first.pageInfo.hasMore).toBe(true);
    expect(first.pageInfo.nextCursor).toBeTypeOf("string");
    const second = await client.fetchAgentHistory({
      search: "bill",
      page: { limit: 1, cursor: first.pageInfo.nextCursor! },
    });
    expect(second.entries.map((entry) => entry.agent.id)).toEqual(["older-exact"]);
    expect(second.pageInfo.hasMore).toBe(false);
    expect(second.entries[0].searchMatches).toBeUndefined();
  } finally {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    for (const target of fixture.cleanupPaths) rmSync(target, { recursive: true, force: true });
  }
});

function seedStaleAgentFixture(): StaleAgentFixture {
  const healthyCwd = mkdtempSync(path.join(os.tmpdir(), "paseo-healthy-agent-"));
  const orphanCwd = mkdtempSync(path.join(os.tmpdir(), "paseo-orphan-agent-"));
  const paseoHomeRoot = mkdtempSync(path.join(os.tmpdir(), "paseo-orphan-agent-home-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  const projectsDir = path.join(paseoHome, "projects");
  const agentsDir = path.join(paseoHome, "agents");
  const healthyProjectId = "proj-healthy-agent-rpc";
  const healthyWorkspaceId = "ws-healthy-agent-rpc";
  const orphanWorkspaceId = "c:\\Users\\paseo\\stale-project";
  const orphanProjectId = "proj-removed-agent-rpc";
  const healthyAgentId = "agent-healthy-rpc";
  const orphanAgentId = "agent-orphan-rpc";

  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeJson(path.join(projectsDir, "projects.json"), [
    {
      projectId: healthyProjectId,
      rootPath: healthyCwd,
      kind: "non_git",
      displayName: "healthy",
      customName: null,
      createdAt: CREATED_AT,
      updatedAt: HEALTHY_UPDATED_AT,
      archivedAt: null,
    },
  ]);
  writeJson(path.join(projectsDir, "workspaces.json"), [
    {
      workspaceId: healthyWorkspaceId,
      projectId: healthyProjectId,
      cwd: healthyCwd,
      kind: "directory",
      displayName: "healthy",
      title: null,
      branch: null,
      baseBranch: null,
      createdAt: CREATED_AT,
      updatedAt: HEALTHY_UPDATED_AT,
      archivedAt: null,
    },
    {
      workspaceId: orphanWorkspaceId,
      projectId: orphanProjectId,
      cwd: orphanCwd,
      kind: "directory",
      displayName: "stale project",
      title: null,
      branch: null,
      baseBranch: null,
      createdAt: CREATED_AT,
      updatedAt: ORPHAN_ARCHIVED_AT,
      archivedAt: ORPHAN_ARCHIVED_AT,
    },
  ]);
  writeJson(path.join(agentsDir, `${healthyAgentId}.json`), {
    id: healthyAgentId,
    provider: "codex",
    cwd: healthyCwd,
    workspaceId: healthyWorkspaceId,
    createdAt: CREATED_AT,
    updatedAt: HEALTHY_UPDATED_AT,
    lastActivityAt: HEALTHY_UPDATED_AT,
    lastUserMessageAt: null,
    title: "Healthy Agent",
    labels: {},
    lastStatus: "idle",
    lastModeId: "full-access",
    config: null,
    persistence: null,
  });
  writeJson(path.join(agentsDir, `${orphanAgentId}.json`), {
    id: orphanAgentId,
    provider: "codex",
    cwd: orphanCwd,
    workspaceId: orphanWorkspaceId,
    createdAt: CREATED_AT,
    updatedAt: ORPHAN_ARCHIVED_AT,
    lastActivityAt: ORPHAN_ARCHIVED_AT,
    lastUserMessageAt: null,
    title: "Orphaned Archived Agent",
    labels: {},
    lastStatus: "closed",
    lastModeId: "full-access",
    config: null,
    persistence: null,
    archivedAt: ORPHAN_ARCHIVED_AT,
  });

  return {
    healthyProjectId,
    healthyWorkspaceId,
    orphanWorkspaceId,
    healthyAgentId,
    orphanAgentId,
    paseoHomeRoot,
    cleanupPaths: [healthyCwd, orphanCwd, paseoHomeRoot],
  };
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface AgentDirectoryEntrySummaryInput {
  agent: {
    id: string;
    workspaceId?: string;
    archivedAt?: string | null;
  };
  project: {
    projectKey: string;
    projectName: string;
    workspaceName?: string | null;
  };
}

function healthyAgentSummary(fixture: StaleAgentFixture) {
  return {
    agentId: fixture.healthyAgentId,
    workspaceId: fixture.healthyWorkspaceId,
    archivedAt: null,
    projectKey: fixture.healthyProjectId,
    projectName: "healthy",
    workspaceName: "healthy",
  };
}

function toAgentEntrySummary(entry: AgentDirectoryEntrySummaryInput) {
  return {
    agentId: entry.agent.id,
    workspaceId: entry.agent.workspaceId,
    archivedAt: entry.agent.archivedAt ?? null,
    projectKey: entry.project.projectKey,
    projectName: entry.project.projectName,
    workspaceName: entry.project.workspaceName ?? null,
  };
}

test("conditional delivery RPC preserves invocation identity and retries across reconnect", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "paseo-conditional-rpc-"));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const starts: string[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => {
        starts.push(typeof prompt === "string" ? prompt : "structured");
      },
      beforeTurnComplete: () => held,
    }),
  });
  let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    expect(client.getLastServerInfoMessage()?.features?.agentConditionalDelivery).toBe(true);
    const agent = await client.createAgent({ provider: "codex", cwd, modeId: "full-access" });
    const invocation = { messageId: "conditional-invocation", expected: { kind: "idle" } } as const;
    const accepted = await client.sendAgentMessageIfCurrent(agent.id, "hello", invocation);
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") throw new Error("Expected accepted invocation");
    await daemon.daemon.agentManager.waitForAgentRunStart(agent.id);
    const current = await client.fetchAgent({ agentId: agent.id });
    expect(current?.agent.activeRun).toMatchObject({ runId: accepted.runId, phase: "running" });
    expect(await client.sendAgentMessageIfCurrent(agent.id, "hello", invocation)).toEqual(accepted);
    expect(
      await client.sendAgentMessageIfCurrent(agent.id, "later", {
        messageId: "deferred-invocation",
        expected: { kind: "idle" },
      }),
    ).toEqual({ status: "busy", currentRun: current!.agent.activeRun });
    await expect(
      client.sendAgentMessageIfCurrent(agent.id, "different", invocation),
    ).rejects.toThrow("agent_request_key_conflict");
    release();
    await client.waitForFinish(agent.id, 5000);
    await client.close();
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    expect(await client.sendAgentMessageIfCurrent(agent.id, "hello", invocation)).toEqual(accepted);
    const restarted = await client.sendAgentMessageIfCurrent(agent.id, "later", {
      messageId: "deferred-invocation",
      expected: { kind: "idle" },
    });
    expect(restarted.status).toBe("accepted");
    expect(starts).toEqual(["hello", "later"]);
  } finally {
    release();
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("creation RPC retains exact initial invocation proof across reconnect", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "paseo-creation-run-proof-rpc-"));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({ beforeTurnComplete: () => held }),
  });
  let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const intent = {
    provider: "codex",
    cwd,
    modeId: "full-access",
    initialPrompt: "A",
    idempotencyKey: "creation-run-proof",
  };
  try {
    await client.connect();
    const creation = await client.createAgentWithRun(intent);
    expect(creation.initialRunId).toEqual(expect.any(String));
    expect(creation.agent.activeRun?.runId).toBe(creation.initialRunId);
    release();
    await client.waitForFinish(creation.agent.id, 5000);
    await client.close();
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    expect((await client.createAgentWithRun(intent)).initialRunId).toBe(creation.initialRunId);
    const unprompted = await client.createAgentWithRun({
      provider: "codex",
      cwd,
      modeId: "full-access",
    });
    expect(unprompted.initialRunId).toBeNull();
  } finally {
    release();
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("conditional cancellation RPC replays its original proof and preserves a successor", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "paseo-conditional-cancel-rpc-"));
  let releaseOld!: () => void;
  let releaseSuccessor!: () => void;
  const heldOld = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const heldSuccessor = new Promise<void>((resolve) => {
    releaseSuccessor = resolve;
  });
  const clients = createTestAgentClients({
    beforeTurnComplete: (prompt) => (prompt === "old" ? heldOld : heldSuccessor),
  });
  const codex = clients.codex!;
  const createSession = codex.createSession.bind(codex);
  const interruptedTurns: string[] = [];
  codex.createSession = async (...args) => {
    const session: AgentSession = await createSession(...args);
    let currentTurnId: string | null = null;
    session.subscribe((event) => {
      if (event.type === "turn_started") currentTurnId = event.turnId ?? null;
      if (event.type === "turn_completed" || event.type === "turn_canceled") currentTurnId = null;
    });
    session.interruptExpectedTurn = async (expectedTurnId) => {
      if (currentTurnId !== expectedTurnId) return { status: "mismatch" };
      interruptedTurns.push(expectedTurnId);
      releaseOld();
      return { status: "interrupted" };
    };
    return session;
  };
  const daemon = await createTestPaseoDaemon({ agentClients: clients });
  let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    expect(client.getLastServerInfoMessage()?.features?.agentConditionalCancel).toBe(true);
    const agent = await client.createAgent({ provider: "codex", cwd, modeId: "full-access" });
    const original = await client.sendAgentMessageIfCurrent(agent.id, "old", {
      messageId: "original-send",
      expected: { kind: "idle" },
    });
    if (original.status !== "accepted") throw new Error("Expected accepted original run");
    await daemon.daemon.agentManager.waitForAgentRunStart(agent.id);
    const originalTurn = (await client.fetchAgent({ agentId: agent.id }))!.agent.activeRun!.turnId;
    const cancellation = { messageId: "original-cancel", expectedRunId: original.runId };
    const proof = await client.cancelAgentRunIfCurrent(agent.id, cancellation);
    expect(proof).toEqual({ status: "cancelled", runId: original.runId });
    expect((await client.fetchAgent({ agentId: agent.id }))!.agent).toMatchObject({
      activeRun: null,
      latestRunId: original.runId,
    });

    const successor = await client.sendAgentMessageIfCurrent(agent.id, "successor", {
      messageId: "successor-send",
      expected: { kind: "idle" },
    });
    if (successor.status !== "accepted") throw new Error("Expected accepted successor run");
    await daemon.daemon.agentManager.waitForAgentRunStart(agent.id);
    await client.close();
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    expect(await client.cancelAgentRunIfCurrent(agent.id, cancellation)).toEqual(proof);
    const current = (await client.fetchAgent({ agentId: agent.id }))!.agent.activeRun;
    expect(current?.runId).toBe(successor.runId);
    expect(
      await client.cancelAgentRunIfCurrent(agent.id, {
        messageId: "obsolete-cancel",
        expectedRunId: original.runId,
      }),
    ).toEqual({ status: "mismatch", currentRun: current });
    await expect(
      client.cancelAgentRunIfCurrent(agent.id, { ...cancellation, expectedRunId: successor.runId }),
    ).rejects.toThrow("agent_request_key_conflict");
    expect(interruptedTurns).toEqual([originalTurn]);
    expect((await client.fetchAgent({ agentId: agent.id }))!.agent.activeRun?.runId).toBe(
      successor.runId,
    );
  } finally {
    releaseOld();
    releaseSuccessor();
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("conditional idle send resumes an archived original owner", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "paseo-review3-archived-owner-"));
  const starts: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => starts.push(typeof prompt === "string" ? prompt : "structured"),
      beforeTurnComplete: () => held,
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const agent = await client.createAgent({ provider: "codex", cwd, modeId: "full-access" });
    const archived = await daemon.daemon.agentManager.archiveAgent(agent.id);
    expect((await daemon.daemon.agentStorage.get(agent.id))!.archivedAt).toBe(archived.archivedAt);
    const accepted = await client.sendAgentMessageIfCurrent(agent.id, "resume original owner", {
      messageId: "review3-archived-owner",
      expected: { kind: "idle" },
    });
    expect(accepted.status).toBe("accepted");
    expect((await daemon.daemon.agentStorage.get(agent.id))!.archivedAt).toBeNull();
    await daemon.daemon.agentManager.waitForAgentRunStart(agent.id);
    expect(starts).toEqual(["resume original owner"]);
  } finally {
    release();
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("conditional idle send restores archive state when archive wins during loading", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "paseo-review3-concurrent-archive-"));
  const starts: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => starts.push(typeof prompt === "string" ? prompt : "structured"),
      beforeTurnComplete: () => held,
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const manager = daemon.daemon.agentManager;
  const realWait = manager.waitForAgentClose.bind(manager);
  try {
    await client.connect();
    const agent = await client.createAgent({ provider: "codex", cwd, modeId: "full-access" });
    let archivedAt: string | null = null;
    manager.waitForAgentClose = async (agentId) => {
      manager.waitForAgentClose = realWait;
      archivedAt = (await manager.archiveAgent(agentId)).archivedAt;
      await realWait(agentId);
    };
    const delivered = await client.sendAgentMessageIfCurrent(agent.id, "conditional prompt", {
      messageId: "review3-concurrent-archive",
      expected: { kind: "idle" },
    });
    await manager.waitForAgentRunStart(agent.id);
    expect(archivedAt).not.toBeNull();
    expect(delivered.status).toBe("accepted");
    expect((await daemon.daemon.agentStorage.get(agent.id))!.archivedAt).toBeNull();
    expect(starts).toEqual(["conditional prompt"]);
  } finally {
    manager.waitForAgentClose = realWait;
    release();
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.each(["send", "cancel"])(
  "conditional archived %s mismatch preserves archival and unread state",
  async (operation) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "paseo-conditional-archived-rejection-"));
    const starts: string[] = [];
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients({
        onStartTurn: (prompt) => starts.push(typeof prompt === "string" ? prompt : "structured"),
      }),
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      await client.connect();
      const agent = await client.createAgent({ provider: "codex", cwd, modeId: "full-access" });
      const archived = await daemon.daemon.agentManager.archiveAgent(agent.id);
      const original = (await daemon.daemon.agentStorage.get(agent.id))!;
      await daemon.daemon.agentStorage.upsert({
        ...original,
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: archived.archivedAt,
      });
      const result =
        operation === "send"
          ? await client.sendAgentMessageIfCurrent(agent.id, "obsolete replacement", {
              messageId: "archived-rejected-send",
              expected: { kind: "run", runId: "obsolete-run" },
            })
          : await client.cancelAgentRunIfCurrent(agent.id, {
              messageId: "archived-rejected-cancel",
              expectedRunId: "obsolete-run",
            });
      expect(result).toEqual({ status: "mismatch", currentRun: null });
      expect((await daemon.daemon.agentStorage.get(agent.id))!).toMatchObject({
        archivedAt: archived.archivedAt,
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: archived.archivedAt,
      });
      expect(starts).toEqual([]);
    } finally {
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
