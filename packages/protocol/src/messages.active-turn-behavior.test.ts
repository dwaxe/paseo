import {
  AgentSnapshotPayloadSchema,
  CreationSnapshotSchema,
  AgentStreamEventPayloadSchema,
  AgentTimelineEntryPayloadSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  SendAgentMessageRequestSchema,
  type AgentMessageSendIfCurrentResult,
  type AgentRunCancelIfCurrentResult,
} from "./messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

describe("conditional agent delivery", () => {
  it("keeps exact creation proof separate and optional for earlier hosts", () => {
    const legacy = {
      kind: "agent",
      idempotencyKey: "creation",
      revision: 3,
      phase: "completed",
      workspaceId: null,
      agentId: "created-agent",
      error: null,
    };
    expect(CreationSnapshotSchema.parse(legacy)).toEqual(legacy);
    for (const initialRunId of [null, "initial-invocation"]) {
      const creation = { ...legacy, initialRunId };
      expect(CreationSnapshotSchema.parse(creation)).toEqual(creation);
      const message = {
        type: "agent.create.response",
        payload: {
          requestId: "create",
          agent: null,
          error: null,
          creation,
        },
      };
      expect(validateWSOutboundMessage({ type: "session", message })).toEqual({
        success: true,
        data: { type: "session", message },
      });
    }
    expect(CreationSnapshotSchema.safeParse({ ...legacy, initialRunId: "" }).success).toBe(false);
  });

  const request = {
    type: "agent.message.send_if_current.request",
    requestId: "request-conditional",
    agentId: "550e8400-e29b-41d4-a716-446655440000",
    messageId: "delivery-conditional",
    text: "Follow this instruction",
    expected: { kind: "idle" },
  };

  it("accepts an idle expectation without changing legacy send semantics", () => {
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    expect(
      SendAgentMessageRequestSchema.parse({
        type: "send_agent_message_request",
        requestId: "request-legacy",
        agentId: "agent-prefix",
        text: "legacy message",
      }).activeTurnBehavior,
    ).toBeUndefined();
  });

  it("requires an exact target, delivery key, and observed run identity", () => {
    const running = { ...request, expected: { kind: "run", runId: "run-A" } };
    expect(SessionInboundMessageSchema.parse(running)).toEqual(running);
    for (const invalid of [
      { ...request, agentId: "550e8400" },
      { ...request, agentId: "agent title" },
      { ...request, messageId: "" },
      { ...request, messageId: undefined },
      { ...request, expected: undefined },
      { ...request, expected: { kind: "run" } },
      { ...request, expected: { kind: "run", runId: "" } },
      { ...request, attachments: [{ type: "invalid" }] },
    ]) {
      expect(SessionInboundMessageSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it.each<AgentMessageSendIfCurrentResult>([
    { status: "accepted", runId: "run-new", turnId: null },
    { status: "accepted", runId: "run-new", turnId: "turn-new" },
    { status: "busy", currentRun: { runId: "run-A", phase: "starting", turnId: null } },
    { status: "mismatch", currentRun: { runId: "run-B", phase: "running", turnId: "turn-B" } },
    { status: "mismatch", currentRun: null },
  ])("retains the definitive conditional result %j in both wire validators", (result) => {
    const response = {
      type: "agent.message.send_if_current.response",
      payload: { requestId: request.requestId, agentId: request.agentId, result, error: null },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
    const envelope = { type: "session", message: response };
    expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
  });

  it("accepts an operation error without inventing an admission result", () => {
    const response = {
      type: "agent.message.send_if_current.response",
      payload: {
        requestId: request.requestId,
        agentId: request.agentId,
        result: null,
        error: "agent_request_outcome_unknown",
      },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });

  it.each([
    { status: "accepted", runId: "", turnId: null },
    { status: "accepted", runId: "run-new" },
    { status: "busy" },
    { status: "mismatch", currentRun: { runId: "run-B", phase: "idle", turnId: null } },
  ])("rejects a malformed conditional result in both wire validators: %j", (result) => {
    const response = {
      type: "agent.message.send_if_current.response",
      payload: { requestId: request.requestId, agentId: request.agentId, result, error: null },
    };
    expect(SessionOutboundMessageSchema.safeParse(response).success).toBe(false);
    expect(validateWSOutboundMessage({ type: "session", message: response }).success).toBe(false);
  });

  it("keeps optional capability and run observations compatible with earlier daemons", () => {
    const serverInfo = {
      status: "server_info",
      serverId: "server-1",
      hostname: null,
      version: null,
    };
    expect(ServerInfoStatusPayloadSchema.parse(serverInfo)).toEqual(serverInfo);
    const capable = { ...serverInfo, features: { agentConditionalDelivery: true } };
    expect(ServerInfoStatusPayloadSchema.parse(capable)).toEqual(capable);

    const snapshot = {
      id: request.agentId,
      provider: "codex",
      cwd: "/workspace",
      model: null,
      createdAt: "2026-10-14T00:00:00.000Z",
      updatedAt: "2026-10-14T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      activeTurn: null,
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
      title: null,
      labels: {},
    };
    const legacy = AgentSnapshotPayloadSchema.parse(snapshot);
    expect(legacy.activeRun).toBeUndefined();
    const idle = { ...snapshot, activeRun: null };
    expect(AgentSnapshotPayloadSchema.parse(idle)).toEqual({ ...legacy, activeRun: null });
    const pending = {
      ...snapshot,
      activeRun: { runId: "run-A", phase: "starting", turnId: null },
    };
    expect(AgentSnapshotPayloadSchema.parse(pending)).toEqual({
      ...legacy,
      activeRun: pending.activeRun,
    });
    const running = {
      ...snapshot,
      status: "running",
      activeRun: { runId: "run-A", phase: "running", turnId: "turn-A" },
      activeTurn: { turnId: "turn-A", startedAt: "2026-10-14T00:00:01.000Z" },
    };
    expect(AgentSnapshotPayloadSchema.parse(running)).toEqual({
      ...legacy,
      status: "running",
      activeRun: running.activeRun,
      activeTurn: running.activeTurn,
    });
  });
});

describe("conditional agent cancellation", () => {
  const request = {
    type: "agent.run.cancel_if_current.request",
    requestId: "request-cancel",
    agentId: "550e8400-e29b-41d4-a716-446655440000",
    messageId: "cancel-operation",
    expectedRunId: "run-A",
  };

  it("requires caller-selected run identity without changing legacy cancellation", () => {
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    const legacy = { type: "cancel_agent_request", agentId: "agent-prefix" };
    expect(SessionInboundMessageSchema.parse(legacy)).toEqual(legacy);
  });

  it("rejects ambiguous targets and missing cancellation identities", () => {
    for (const invalid of [
      { ...request, agentId: "550e8400" },
      { ...request, agentId: "agent title" },
      { ...request, messageId: "" },
      { ...request, messageId: undefined },
      { ...request, expectedRunId: "" },
      { ...request, expectedRunId: undefined },
    ]) {
      expect(SessionInboundMessageSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it.each<AgentRunCancelIfCurrentResult>([
    { status: "cancelled", runId: "run-A" },
    { status: "busy", currentRun: { runId: "run-A", phase: "starting", turnId: null } },
    { status: "mismatch", currentRun: { runId: "run-B", phase: "running", turnId: "turn-B" } },
    { status: "mismatch", currentRun: null },
  ])("preserves exact cancellation outcomes in both wire validators: %j", (result) => {
    const response = {
      type: "agent.run.cancel_if_current.response",
      payload: { requestId: request.requestId, agentId: request.agentId, result, error: null },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
    const envelope = { type: "session", message: response };
    expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
  });

  it.each([
    { status: "cancelled", runId: "" },
    { status: "cancelled" },
    { status: "busy" },
    { status: "mismatch", currentRun: { runId: "run-B", phase: "idle", turnId: null } },
  ])("rejects malformed cancellation proof in both wire validators: %j", (result) => {
    const response = {
      type: "agent.run.cancel_if_current.response",
      payload: { requestId: request.requestId, agentId: request.agentId, result, error: null },
    };
    expect(SessionOutboundMessageSchema.safeParse(response).success).toBe(false);
    expect(validateWSOutboundMessage({ type: "session", message: response }).success).toBe(false);
  });

  it("keeps a completed run identity available while accepting earlier snapshots", () => {
    const observations = AgentSnapshotPayloadSchema.pick({
      status: true,
      activeRun: true,
      latestRunId: true,
    });
    const legacy = { status: "idle", activeRun: null };
    expect(observations.parse(legacy)).toEqual(legacy);
    const neverStarted = { ...legacy, latestRunId: null };
    expect(observations.parse(neverStarted)).toEqual(neverStarted);
    const completed = { ...legacy, latestRunId: "run-A" };
    expect(observations.parse(completed)).toEqual(completed);
    const running = {
      status: "running",
      activeRun: { runId: "run-B", phase: "running", turnId: "turn-B" },
      latestRunId: "run-B",
    };
    expect(observations.parse(running)).toEqual(running);

    const info = { status: "server_info", serverId: "host" };
    expect(ServerInfoStatusPayloadSchema.parse(info).features).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...info, features: { agentConditionalCancel: true } })
        .features,
    ).toEqual({ agentConditionalCancel: true });
  });
});

describe("send_agent_message_request active-turn behavior", () => {
  it("accepts an optional steer intent while retaining interrupt compatibility", () => {
    expect(
      SendAgentMessageRequestSchema.parse({
        type: "send_agent_message_request",
        requestId: "request-1",
        agentId: "agent-1",
        text: "Follow this instruction",
        activeTurnBehavior: "steer",
      }).activeTurnBehavior,
    ).toBe("steer");

    expect(
      SendAgentMessageRequestSchema.parse({
        type: "send_agent_message_request",
        requestId: "request-2",
        agentId: "agent-1",
        text: "Keep the old behavior",
      }).activeTurnBehavior,
    ).toBeUndefined();
  });
});

describe("canonical timeline turn ID compatibility", () => {
  it("accepts both new turn-tagged wire rows and legacy rows without IDs", () => {
    const entry = {
      provider: "codex" as const,
      item: { type: "assistant_message" as const, text: "done" },
      timestamp: "2026-01-01T00:00:00.000Z",
      seqStart: 1,
      seqEnd: 1,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
      collapsed: [],
    };
    expect(AgentTimelineEntryPayloadSchema.parse(entry).turnId).toBeUndefined();
    expect(AgentTimelineEntryPayloadSchema.parse({ ...entry, turnId: "turn-1" }).turnId).toBe(
      "turn-1",
    );

    const timeline = {
      type: "timeline" as const,
      provider: "codex" as const,
      item: { type: "assistant_message" as const, text: "done" },
    };
    expect(AgentStreamEventPayloadSchema.parse(timeline).turnId).toBeUndefined();
    expect(AgentStreamEventPayloadSchema.parse({ ...timeline, turnId: "turn-1" }).turnId).toBe(
      "turn-1",
    );
  });
});

describe("legacy daemon send request schema compatibility", () => {
  const LegacySendAgentMessageRequestSchema = z.object({
    type: z.literal("send_agent_message_request"),
    requestId: z.string(),
    agentId: z.string(),
    text: z.string(),
    messageId: z.string().optional(),
  });

  it("ignores a new client's active-turn intent and retains legacy interrupt dispatch", () => {
    const newClientRequest = SendAgentMessageRequestSchema.parse({
      type: "send_agent_message_request",
      requestId: "request-legacy",
      agentId: "agent-1",
      text: "replace the turn",
      activeTurnBehavior: "steer",
    });
    const legacyRequest = LegacySendAgentMessageRequestSchema.parse(newClientRequest);

    expect(legacyRequest).toEqual({
      type: "send_agent_message_request",
      requestId: "request-legacy",
      agentId: "agent-1",
      text: "replace the turn",
    });
    expect("activeTurnBehavior" in legacyRequest).toBe(false);
  });
});
