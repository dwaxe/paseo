// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { AGENT_NOTIFICATIONS_MUTED_LABEL } from "@getpaseo/protocol/agent-labels";
import { useSessionStore } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { AgentStoreProjection } from "@/runtime/directory-sync/internal/agent-store";
import {
  updateAgentNotificationMute,
  useAgentNotificationMute,
} from "./use-agent-notification-mute";
import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";

const SERVER_ID = "notification-mute-test";
const snapshot: AgentSnapshotPayload = {
  id: "agent-1",
  provider: "codex",
  cwd: "/repo",
  model: null,
  createdAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: "Helper",
  labels: { purpose: "communication" },
};

beforeEach(() => {
  useSessionStore.getState().initializeSession(SERVER_ID, null);
  const agent = normalizeAgentSnapshot(snapshot, SERVER_ID);
  useSessionStore.getState().setAgents(SERVER_ID, new Map([[agent.id, agent]]));
});
afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession(SERVER_ID);
});

const agentTab: WorkspaceTabDescriptor = {
  key: "agent_agent-1",
  tabId: "agent_agent-1",
  kind: "agent",
  target: { kind: "agent", agentId: snapshot.id },
};

function renderMuteActions() {
  useSessionStore.getState().updateSessionServerInfo(SERVER_ID, {
    serverId: SERVER_ID,
    hostname: null,
    version: "0.12.0",
    features: { agentNotificationMute: true },
  });
  const queryClient = new QueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return {
    ...renderHook(() => useAgentNotificationMute(SERVER_ID), { wrapper: Wrapper }),
    queryClient,
  };
}

describe("agent notification mute eligibility", () => {
  it("omits the action for archived agents retained in the directory", () => {
    new AgentStoreProjection(SERVER_ID).archive(snapshot.id, "2026-10-16T00:00:01.000Z");
    const { result } = renderMuteActions();
    expect(result.current(agentTab)).toBeUndefined();
  });

  it("ignores a menu action captured before the agent was archived", () => {
    const { result, queryClient } = renderMuteActions();
    const action = result.current(agentTab);
    if (!action) throw new Error("Expected an active agent mute action");
    act(() => {
      new AgentStoreProjection(SERVER_ID).archive(snapshot.id, "2026-10-16T00:00:01.000Z");
      action.onToggle();
    });
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });
});

function currentAgent() {
  const agent = useSessionStore.getState().sessions[SERVER_ID]?.agents.get(snapshot.id);
  if (!agent) throw new Error("Expected seeded agent");
  return agent;
}

function publishMutedAgent(): void {
  new AgentStoreProjection(SERVER_ID).accept(
    normalizeAgentSnapshot(
      {
        ...snapshot,
        updatedAt: "2026-10-16T00:00:01.000Z",
        status: "running",
        activeTurn: { turnId: "new-turn", startedAt: "2026-10-16T00:00:01.000Z" },
        labels: { purpose: "communication", [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true" },
      },
      SERVER_ID,
    ),
  );
}

describe("agent notification mute publication", () => {
  it("stays pending after acknowledgement until the authoritative directory changes", async () => {
    const acknowledged = Promise.withResolvers<void>();
    const requests: Array<{ agentId: string; labels?: Record<string, string> }> = [];
    let completed = false;
    const operation = updateAgentNotificationMute({
      serverId: SERVER_ID,
      agentId: snapshot.id,
      muted: true,
      client: {
        async updateAgent(agentId, updates) {
          requests.push({ agentId, ...updates });
          await acknowledged.promise;
        },
      },
    }).then(() => {
      completed = true;
      return undefined;
    });
    expect(requests).toEqual([
      { agentId: snapshot.id, labels: { [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true" } },
    ]);
    expect(currentAgent().labels).toEqual({ purpose: "communication" });
    acknowledged.resolve();
    await acknowledged.promise;
    expect(completed).toBe(false);
    expect(currentAgent().labels).toEqual({ purpose: "communication" });
    publishMutedAgent();
    await operation;
    expect(completed).toBe(true);
    expect(currentAgent()).toMatchObject({
      status: "running",
      turn: { phase: "open", turnId: "new-turn" },
      labels: { purpose: "communication", [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true" },
    });
  });

  it("handles authoritative publication arriving before acknowledgement", async () => {
    await updateAgentNotificationMute({
      serverId: SERVER_ID,
      agentId: snapshot.id,
      muted: true,
      client: {
        async updateAgent() {
          publishMutedAgent();
        },
      },
    });
    expect(currentAgent().labels[AGENT_NOTIFICATIONS_MUTED_LABEL]).toBe("true");
  });

  it("leaves the saved value intact when the daemon rejects the update", async () => {
    await expect(
      updateAgentNotificationMute({
        serverId: SERVER_ID,
        agentId: snapshot.id,
        muted: true,
        client: {
          async updateAgent() {
            throw new Error("disk unavailable");
          },
        },
      }),
    ).rejects.toThrow("disk unavailable");
    expect(currentAgent().labels).toEqual({ purpose: "communication" });
  });

  it("times out with a retryable failure if publication never arrives", async () => {
    await expect(
      updateAgentNotificationMute({
        serverId: SERVER_ID,
        agentId: snapshot.id,
        muted: true,
        publicationTimeoutMs: 1,
        client: { async updateAgent() {} },
      }),
    ).rejects.toThrow("Timed out waiting for the saved agent notification setting");
    expect(currentAgent().labels).toEqual({ purpose: "communication" });
  });
});
