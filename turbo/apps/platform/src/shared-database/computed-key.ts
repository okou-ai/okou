import { computerUseHostStatusSchema } from "@okouai/api-contracts/validators/computer-use";
import { queueResponseSchema } from "@okouai/api-contracts/validators/runs";
import type { QueueResponse } from "@okouai/api-contracts/contracts/runs";
import {
  array,
  number,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import {
  chatThreadIndicatorsSchema,
  type ChatThreadIndicators,
} from "./data-key.ts";

export const computedKeySchema = zEnum([
  "chat-thread-indicators",
  "computer-use-hosts",
  "indexeddb-diagnostics",
  "indexeddb-snapshot-measurement",
  "queue-data",
]);

export type ComputedKey = zInfer<typeof computedKeySchema>;

export const listedComputerUseHostSchema = object({
  id: string(),
  hostName: string(),
  displayName: string(),
  lastSeenAt: string(),
  status: computerUseHostStatusSchema,
}).strict();

export type ListedComputerUseHost = zInfer<typeof listedComputerUseHostSchema>;

const indexedDbDiagnosticsSchema = object({
  version: number().int().nonnegative(),
  stores: array(
    object({
      name: string().min(1),
      recordCount: number().int().nonnegative(),
    }).strict(),
  ),
}).strict();

export type IndexedDbDiagnostics = zInfer<typeof indexedDbDiagnosticsSchema>;

const indexedDbSnapshotMeasurementSchema = object({
  threadCount: number().int().nonnegative(),
  payloadBytes: number().int().nonnegative(),
  readDurationMs: number().nonnegative(),
}).strict();

export type IndexedDbSnapshotMeasurement = zInfer<
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
