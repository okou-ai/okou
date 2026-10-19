import { z } from "zod";
import { seal, unseal } from "./crypto";
import type { EncryptedValue, Pending, ReceiverState, Updates } from "./types";
const encryptedSchema = z.object({ iv: z.string(), data: z.string() });
/** Chunk ciphertext below SQLite's row limit; stream it across the RPC size limit. */
export async function saveReceiver(
  storage: DurableObjectStorage,
  secret: string,
  connectionId: string,
  previous: ReceiverState,
  next: ReceiverState,
  updates?: Updates | null,
) {
  const records: Record<string, EncryptedValue> = {};
  if (updates?.msgs?.length) {
    const text = JSON.stringify(updates);
    const parts = Math.ceil(text.length / 100_000);
    for (let part = 0; part < parts; part++) {
      records[`pending:${part}`] = await seal(
        secret,
        connectionId,
        text.slice(part * 100_000, (part + 1) * 100_000),
      );
    }
    next = { ...next, pending: { id: crypto.randomUUID(), parts } };
  }
  await storage.transaction(async (txn) => {
    await txn.put({ ...records, receiver: next });
    if (next.generation && next.generation !== previous.generation) {
      await txn.put("generationHint", next.generation);
    }
    for (
      let part = next.pending?.parts ?? 0;
      part < (previous.pending?.parts ?? 0);
      part++
    ) {
      await txn.delete(`pending:${part}`);
    }
  });
  return next;
}
export async function readPendingBatch(
  storage: DurableObjectStorage,
  pending: Pending,
) {
  const parts: EncryptedValue[] = [];
  for (let part = 0; part < pending.parts; part++) {
    const value = await storage.get<EncryptedValue>(`pending:${part}`);
    if (!value) throw new Error("WeChat pending batch is incomplete");
    parts.push(value);
  }
  return new Response(JSON.stringify(parts)).body;
}
export async function decodePendingBatch(
  secret: string,
  connectionId: string,
  stream: ReadableStream,
) {
  const parts = z
    .array(encryptedSchema)
    .parse(await new Response(stream).json());
  const decoded: string[] = [];
  for (const part of parts)
    decoded.push(z.string().parse(await unseal(secret, connectionId, part)));
  return JSON.parse(decoded.join("")) as unknown;
}
