import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MessageReceipts } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-requests-"));
  directories.push(directory);
  return { directory, requests: new MessageReceipts(directory) };
}

test("message retries survive reconstruction without submitting twice", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: { text: "hello" },
    send: async () => {
      deliveries++;
    },
  };
  await Promise.all([requests.send(input), requests.send(input)]);
  await new MessageReceipts(directory).send(input);
  expect(deliveries).toBe(1);
  await requests.send({ ...input, agentId: "another" });
  expect(deliveries).toBe(2);
});

test("ambiguous provider delivery is never blindly replayed after restart", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: {},
    send: async () => {
      deliveries++;
      throw new Error("connection lost");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("connection lost");
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(deliveries).toBe(1);
});

test("failed local message preparation does not leave an ambiguous receipt", async () => {
  const { requests, directory } = await fixture();
  let available = false;
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "message",
    request: {},
    prepare: async () => {
      if (!available) throw new Error("load failed");
    },
    send: async () => {
      sends++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("load failed");
  available = true;
  await new MessageReceipts(directory).send(input);
  available = false;
  await requests.send(input);
  expect(sends).toBe(1);
});

test("conditional busy is retryable and accepted replay preserves the original run across restart", async () => {
  const { requests, directory } = await fixture();
  let busy = true;
  let deliveries = 0;
  const accepted = { status: "accepted", runId: "original-run", turnId: null } as const;
  const input = {
    agentId: "agent",
    messageId: "invocation",
    request: { prompt: "hello", expected: { kind: "idle" } },
    send: async (beforeEffect: () => Promise<void>) => {
      if (busy) return { status: "busy", currentRun: null } as const;
      await beforeEffect();
      deliveries++;
      return accepted;
    },
  };
  expect(await requests.sendIfCurrent(input)).toEqual({ status: "busy", currentRun: null });
  busy = false;
  expect(await Promise.all([requests.sendIfCurrent(input), requests.sendIfCurrent(input)])).toEqual(
    [accepted, accepted],
  );
  busy = true;
  expect(await new MessageReceipts(directory).sendIfCurrent(input)).toEqual(accepted);
  expect(deliveries).toBe(1);
  await expect(
    requests.sendIfCurrent({
      ...input,
      request: { prompt: "hello", expected: { kind: "run", runId: "other-run" } },
    }),
  ).rejects.toThrow("agent_request_key_conflict");
  expect(deliveries).toBe(1);
});

test("conditional pending outcome never repeats provider effects after reconstruction", async () => {
  const { requests, directory } = await fixture();
  let effects = 0;
  const input = {
    agentId: "agent",
    messageId: "uncertain",
    request: { prompt: "hello" },
    send: async (beforeEffect: () => Promise<void>): Promise<never> => {
      await beforeEffect();
      effects++;
      throw new Error("connection lost after admission");
    },
  };
  await expect(requests.sendIfCurrent(input)).rejects.toThrow("connection lost after admission");
  await expect(new MessageReceipts(directory).sendIfCurrent(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(effects).toBe(1);
});

test("conditional mismatch after receipt preparation remains retryable", async () => {
  const { requests, directory } = await fixture();
  const input = {
    agentId: "agent",
    messageId: "rejected",
    request: { prompt: "hello" },
    send: async (beforeEffect: () => Promise<void>) => {
      await beforeEffect();
      return { status: "mismatch", currentRun: null } as const;
    },
  };
  expect(await requests.sendIfCurrent(input)).toEqual({ status: "mismatch", currentRun: null });
  expect(await new MessageReceipts(directory).sendIfCurrent(input)).toEqual({
    status: "mismatch",
    currentRun: null,
  });
});

test("conditional cancellation receipts replay their proof without cancelling a successor", async () => {
  const { requests, directory } = await fixture();
  let cancellations = 0;
  const proof = { status: "cancelled", runId: "original-run" } as const;
  const input = {
    agentId: "agent",
    messageId: "cancel-original",
    request: { expectedRunId: "original-run" },
    send: async (beforeEffect: () => Promise<void>) => {
      await beforeEffect();
      cancellations++;
      return proof;
    },
  };
  expect(
    await Promise.all([requests.cancelIfCurrent(input), requests.cancelIfCurrent(input)]),
  ).toEqual([proof, proof]);
  expect(await new MessageReceipts(directory).cancelIfCurrent(input)).toEqual(proof);
  await expect(
    requests.cancelIfCurrent({ ...input, request: { expectedRunId: "successor-run" } }),
  ).rejects.toThrow("agent_request_key_conflict");
  expect(cancellations).toBe(1);
});
