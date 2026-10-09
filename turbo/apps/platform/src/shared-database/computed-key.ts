import { computerUseHostStatusSchema } from "@okouai/api-contracts/contracts/computer-use";
import {
  queueResponseSchema,
  type QueueResponse,
} from "@okouai/api-contracts/contracts/runs";
import { z } from "zod";

import {
  chatThreadIndicatorsSchema,
  type ChatThreadIndicators,
} from "./data-key.ts";

export const computedKeySchema = z.enum([
  "chat-thread-indicators",
  "computer-use-hosts",
  "indexeddb-diagnostics",
  "indexeddb-snapshot-measurement",
  "queue-data",
]);

export type ComputedKey = z.infer<typeof computedKeySchema>;

export const listedComputerUseHostSchema = z
  .object({
    id: z.string(),
    hostName: z.string(),
    displayName: z.string(),
    lastSeenAt: z.string(),
    status: computerUseHostStatusSchema,
  })
  .strict();

export type ListedComputerUseHost = z.infer<typeof listedComputerUseHostSchema>;

const indexedDbDiagnosticsSchema = z
  .object({
    version: z.number().int().nonnegative(),
    stores: z.array(
      z
        .object({
          name: z.string().min(1),
          recordCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export type IndexedDbDiagnostics = z.infer<typeof indexedDbDiagnosticsSchema>;

const indexedDbSnapshotMeasurementSchema = z
  .object({
    threadCount: z.number().int().nonnegative(),
    payloadBytes: z.number().int().nonnegative(),
    readDurationMs: z.number().nonnegative(),
  })
  .strict();

export type IndexedDbSnapshotMeasurement = z.infer<
  typeof indexedDbSnapshotMeasurementSchema
>;

interface ComputedValueMap {
  readonly "chat-thread-indicators": ChatThreadIndicators;
  readonly "computer-use-hosts": ListedComputerUseHost[];
  readonly "indexeddb-diagnostics": IndexedDbDiagnostics;
  readonly "indexeddb-snapshot-measurement": IndexedDbSnapshotMeasurement | null;
  readonly "queue-data": QueueResponse;
}

export type ComputedValue<TKey extends ComputedKey> = ComputedValueMap[TKey];

export function parseComputedValue<TKey extends ComputedKey>(
  computedKey: TKey,
  value: unknown,
): ComputedValue<TKey>;
export function parseComputedValue(
  computedKey: ComputedKey,
  value: unknown,
): ComputedValue<ComputedKey> {
  if (computedKey === "chat-thread-indicators") {
    return chatThreadIndicatorsSchema.parse(value);
  }
  if (computedKey === "computer-use-hosts") {
    return listedComputerUseHostSchema.array().parse(value);
  }
  if (computedKey === "indexeddb-diagnostics") {
    return indexedDbDiagnosticsSchema.parse(value);
  }
  if (computedKey === "indexeddb-snapshot-measurement") {
    return indexedDbSnapshotMeasurementSchema.nullable().parse(value);
  }
  return queueResponseSchema.parse(value);
}
