import {
  array,
  boolean,
  iso,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";

const identity = string().min(1);
const digest = string().regex(/^[a-f0-9]{64}$/u);
const revision = string().regex(/^\d+$/u);
const visibility = zEnum(["public", "private"]);
const content = object({
  hash: digest,
  bytes: number().int().nonnegative(),
  bundle: contentBundleSchema.nullable(),
}).strict();

export const snapshotSchema = object({
  format: literal("single-agent-inventory-v1"),
  target: identity,
  orgId: identity,
  database: identity,
  capturedAt: iso.datetime({ offset: true }),
  readOnly: literal(true),
  defaultAgentId: uuid().nullable(),
  members: array(object({ userId: identity, role: identity }).strict()),
  agents: array(
    object({
      id: uuid(),
      name: string(),
      displayName: string().nullable(),
      owner: identity,
      visibility,
      revision,
      instructions: content,
    }).strict(),
  ),
  personalInstructions: array(
    object({
      userId: identity,
      version: uuid(),
      revision,
      content,
    }).strict(),
  ),
  workflows: array(
    object({
      id: uuid(),
      agentId: uuid(),
      name: string(),
      owner: identity,
      visibility,
      revision,
      official: string().nullable(),
      bundle: contentBundleSchema.nullable(),
    }).strict(),
  ),
  automations: array(
    object({
      id: uuid(),
      workflowId: uuid(),
      owner: identity,
      enabled: boolean(),
      kind: identity,
      revision,
      fingerprint: digest,
    }).strict(),
  ),
  automationThreads: array(
    object({
      id: uuid(),
      workflowId: uuid(),
      owner: identity,
      chatThreadId: uuid().nullable(),
      revision,
    }).strict(),
  ),
  chats: array(
    object({
      id: uuid(),
      agentId: uuid(),
      owner: identity,
      projectId: uuid().nullable(),
      revision,
    }).strict(),
  ),
  projects: array(
    object({ id: uuid(), owner: identity, name: string(), revision }).strict(),
  ),
}).strict();

export type Snapshot = zInfer<typeof snapshotSchema>;

export class PlanningError extends Error {}

export function parseSnapshot(value: unknown): Snapshot {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw new PlanningError("InventorySchemaMismatch");
  const snapshot = parsed.data;
  for (const rows of [
    snapshot.agents,
    snapshot.workflows,
    snapshot.automations,
    snapshot.automationThreads,
    snapshot.chats,
    snapshot.projects,
  ]) {
    if (
      new Set(
        rows.map((row) => {
          return row.id;
        }),
      ).size !== rows.length
    )
      throw new PlanningError("DuplicateInventoryIdentity");
  }
  for (const rows of [snapshot.members, snapshot.personalInstructions]) {
    if (
      new Set(
        rows.map((row) => {
          return row.userId;
        }),
      ).size !== rows.length
    )
      throw new PlanningError("DuplicateMemberIdentity");
  }
  return snapshot;
}
