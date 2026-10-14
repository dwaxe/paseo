import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import {
  AgentMessageSendIfCurrentResultSchema,
  AgentRunCancelIfCurrentResultSchema,
  type AgentMessageSendIfCurrentResult,
  type AgentRunCancelIfCurrentResult,
} from "@getpaseo/protocol/messages";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  agentId: z.string(),
});
interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  send: () => Promise<void>;
  prepare?: () => Promise<void>;
}

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly pendingConditional = new Map<
    string,
    Promise<AgentMessageSendIfCurrentResult | AgentRunCancelIfCurrentResult>
  >();
  constructor(private readonly directory: string) {}

  send(input: SendMessageInput): Promise<void> {
    // Preserve the existing on-disk identity and shape across daemon upgrades.
    const key = digest(["send", input.agentId, input.messageId]);
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.sendOnce(key, input),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  async sendIfCurrent(input: {
    agentId: string;
    messageId: string;
    request: unknown;
    send: (beforeEffect: () => Promise<void>) => Promise<AgentMessageSendIfCurrentResult>;
  }): Promise<AgentMessageSendIfCurrentResult> {
    const result = await this.conditionalMutation({ ...input, cancelOnly: false });
    if (result.status === "cancelled") throw new Error("Invalid conditional send receipt");
    return result;
  }

  async cancelIfCurrent(input: {
    agentId: string;
    messageId: string;
    request: unknown;
    send: (beforeEffect: () => Promise<void>) => Promise<AgentRunCancelIfCurrentResult>;
  }): Promise<AgentRunCancelIfCurrentResult> {
    const result = await this.conditionalMutation({ ...input, cancelOnly: true });
    if (result.status === "accepted") throw new Error("Invalid conditional cancellation receipt");
    return result;
  }

  private conditionalMutation(input: {
    agentId: string;
    messageId: string;
    request: unknown;
    cancelOnly: boolean;
    send: (
      beforeEffect: () => Promise<void>,
    ) => Promise<AgentMessageSendIfCurrentResult | AgentRunCancelIfCurrentResult>;
  }): Promise<AgentMessageSendIfCurrentResult | AgentRunCancelIfCurrentResult> {
    const key = digest([
      input.cancelOnly ? "conditional-cancel" : "conditional-send",
      input.agentId,
      input.messageId,
    ]);
    const previous = this.pendingConditional.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(
      async () => {
        const file = path.join(this.directory, `${key}.json`);
        const fingerprint = digest(input.request);
        const existing = await readConditionalReceipt(file);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
          if (existing.state !== "completed") throw new Error("agent_request_outcome_unknown");
          const storedResult = input.cancelOnly
            ? AgentRunCancelIfCurrentResultSchema.parse(existing.result)
            : AgentMessageSendIfCurrentResultSchema.parse(existing.result);
          if (storedResult.status !== "accepted" && storedResult.status !== "cancelled")
            throw new Error("Invalid conditional mutation receipt");
          return storedResult;
        }
        const receipt = { fingerprint, agentId: input.agentId };
        let recordedPending = false;
        const delivered = await input.send(async () => {
          if (recordedPending) throw new Error("Conditional delivery effect was admitted twice");
          await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
          recordedPending = true;
        });
        if (delivered.status === "accepted" || delivered.status === "cancelled") {
          if (!recordedPending) throw new Error("Conditional delivery started without a receipt");
          await writeJsonFileAtomic(file, { ...receipt, state: "completed", result: delivered });
        } else if (recordedPending) {
          // Admission proved no prompt was started. Busy/mismatch can safely retry the same key.
          await rm(file);
        }
        return delivered;
      },
    );
    this.pendingConditional.set(key, result);
    void result
      .finally(() => {
        if (this.pendingConditional.get(key) === result) this.pendingConditional.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private async sendOnce(key: string, input: SendMessageInput): Promise<void> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = digest(input.request);
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      if (existing.state === "completed") return;
      // A provider may have accepted the message before its receipt was committed.
      throw new Error("agent_request_outcome_unknown");
    }
    await input.prepare?.();
    const receipt = { fingerprint, agentId: input.agentId };
    await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
    await input.send();
    await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
  }
}

const ConditionalReceiptSchema = ReceiptSchema.extend({ result: z.unknown().optional() });

async function readConditionalReceipt(
  file: string,
): Promise<z.infer<typeof ConditionalReceiptSchema> | null> {
  try {
    return ConditionalReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readReceipt(file: string): Promise<z.infer<typeof ReceiptSchema> | null> {
  try {
    return ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}
