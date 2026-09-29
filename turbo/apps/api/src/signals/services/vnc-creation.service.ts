import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { command } from "ccstate";
import { eq, getTableName } from "drizzle-orm";
import { isUniqueViolation } from "../../lib/pg-errors";
import { writeDb$ } from "../external/db";
import { vncFailure, type VncResult } from "./vnc-configuration.utils";
import type { VncOwner } from "./vnc-owner-lifecycle.service";

type VncCreationResource = "connection" | "credential";

// A live resource makes creation a no-op without requiring KMS. Once deleted,
// its ID can be created again. The primary key arbitrates racing inserts.
export const inspectVncCreationId$ = command(
  async (
    { set },
    owner: VncOwner,
    resource: VncCreationResource,
    id: string,
    signal: AbortSignal,
  ): Promise<VncResult<boolean>> => {
    const db = set(writeDb$);
    const table = resource === "connection" ? vncConnections : vncCredentials;
    const [existing] = await db
      .select({ orgId: table.orgId, userId: table.userId })
      .from(table)
      .where(eq(table.id, id));
    signal.throwIfAborted();
    if (
      existing &&
      (existing.orgId !== owner.orgId || existing.userId !== owner.userId)
    ) {
      return vncFailure("resourceIdConflict");
    }
    return { ok: true, value: existing === undefined };
  },
);

// The failed transaction has already rolled back any inline credential insert.
export const resolveVncCreationConflict$ = command(
  async (
    { set },
    owner: VncOwner,
    resource: VncCreationResource,
    id: string,
    error: unknown,
    signal: AbortSignal,
  ): Promise<VncResult<undefined>> => {
    const table = resource === "connection" ? vncConnections : vncCredentials;
    if (!isUniqueViolation(error, `${getTableName(table)}_pkey`)) {
      throw error;
    }
    const creation = await set(
      inspectVncCreationId$,
      owner,
      resource,
      id,
      signal,
    );
    signal.throwIfAborted();
    return creation.ok && !creation.value
      ? { ok: true, value: undefined }
      : vncFailure("resourceIdConflict");
  },
);
