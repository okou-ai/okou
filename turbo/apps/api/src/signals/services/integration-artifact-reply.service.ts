import { createHash, randomUUID } from "node:crypto";
import { command, createStore } from "ccstate";
import { eq } from "drizzle-orm";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { integrationArtifactDeliveries } from "@okouai/db/schema/integration-artifact-delivery";
import { sharedThreads } from "@okouai/db/schema/shared-thread";
import type { Db } from "../external/db";
import { now } from "../../lib/time";
import { onRejection } from "../utils";
import {
  prepareSharedThreadArtifacts$,
  type SharedThreadArtifactPlan,
} from "./shared-thread-artifact-snapshot.service";
import {
  initializeSharedThreadArtifacts$,
  publishSharedThreadArtifacts$,
  readSharedThreadArtifactPolicy,
  removeSharedThreadArtifactCopies,
} from "./shared-thread-artifacts.service";

interface IntegrationReply {
  readonly db: Db;
  readonly runId: string;
  readonly deliveryKey: string;
  readonly publicBrand: PublicBrand;
  readonly content: string;
}

interface ReplyOwner {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string | null;
}

interface ReplyIdentity extends IntegrationReply, ReplyOwner {
  readonly sourceContentHash: string;
}

const PREPARATION_RECOVERY_DELAY_MS = 5 * 60 * 1000;

/** Lock against publication and account erasure before reusing or recovering. */
const existingReply$ = command(
  async (
    { get },
    args: ReplyIdentity,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    return await args.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          snapshot: sharedThreads,
          sourceContentHash: integrationArtifactDeliveries.sourceContentHash,
        })
        .from(integrationArtifactDeliveries)
        .innerJoin(
          sharedThreads,
          eq(sharedThreads.id, integrationArtifactDeliveries.snapshotId),
        )
        .where(eq(integrationArtifactDeliveries.deliveryKey, args.deliveryKey))
        .for("update", { of: sharedThreads });
      signal.throwIfAborted();
      if (!existing) {
        return undefined;
      }
      const { snapshot } = existing;
      if (
        snapshot.userId !== args.userId ||
        snapshot.orgId !== args.orgId ||
        snapshot.publicBrand !== args.publicBrand ||
        existing.sourceContentHash !== args.sourceContentHash ||
        !snapshot.hasArtifactSnapshot
      ) {
        throw new Error("Integration reply snapshot identity does not match");
      }
      const current = await get(
        readSharedThreadArtifactPolicy(snapshot, signal),
      );
      signal.throwIfAborted();
      if (current?.policy.status === "active") {
        const message = snapshot.messages[0];
        if (snapshot.messages.length !== 1 || message?.role !== "assistant") {
          throw new Error("Integration reply snapshot content is unavailable");
        }
        return message.content;
      }
      if (current?.policy.status === "revoked") {
        throw new Error("Integration reply snapshot was revoked");
      }
      if (
        now() - snapshot.createdAt.getTime() <
        PREPARATION_RECOVERY_DELAY_MS
      ) {
        throw new Error("Integration reply snapshot is still being prepared");
      }
      // A crashed preparation never becomes a reply. Revoke its aliases before
      // reclaiming the identity; the next attempt gets fresh snapshot URLs.
      await get(removeSharedThreadArtifactCopies(snapshot, signal));
      signal.throwIfAborted();
      await tx.delete(sharedThreads).where(eq(sharedThreads.id, snapshot.id));
      return undefined;
    });
  },
);

const discardIncompleteReply$ = command(
  async (
    { get },
    args: { readonly db: Db; readonly plan: SharedThreadArtifactPlan },
    signal: AbortSignal,
  ) => {
    const { plan } = args;
    await args.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(sharedThreads)
        .where(eq(sharedThreads.id, plan.policy.threadId))
        .for("update");
      const identity = row ?? {
        id: plan.policy.threadId,
        userId: plan.policy.ownerId,
        orgId: plan.policy.orgId,
        publicBrand: plan.policy.publicBrand,
        hasArtifactSnapshot: true,
      };
      const current = await get(
        readSharedThreadArtifactPolicy(identity, signal),
      );
      signal.throwIfAborted();
      // An ambiguous activation/DB commit may already have published the whole
      // snapshot. Its durable message is reusable on the next delivery attempt.
      if (row && current?.policy.status === "active") {
        return;
      }
      await get(removeSharedThreadArtifactCopies(identity, signal));
      signal.throwIfAborted();
      await tx.delete(sharedThreads).where(eq(sharedThreads.id, identity.id));
    });
  },
);

const prepareIntegrationReply$ = command(
  async ({ set }, args: IntegrationReply, signal: AbortSignal) => {
    const [owner] = await args.db
      .select({
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        chatThreadId: agentRuns.chatThreadId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, args.runId))
      .limit(1);
    signal.throwIfAborted();
    if (!owner) {
      throw new Error("Integration reply run is unavailable");
    }
    const identity: ReplyIdentity = {
      ...args,
      ...owner,
      sourceContentHash: createHash("sha256")
        .update(args.content)
        .digest("hex"),
    };
    const existing = await set(existingReply$, identity, signal);
    if (existing !== undefined) {
      return existing;
    }
    const plan = await set(
      prepareSharedThreadArtifacts$,
      {
        ...owner,
        threadId: randomUUID(),
        publicBrand: args.publicBrand,
        preserveUnmanagedMessageLinks: true,
        messages: [
          { messageIndex: 0, role: "assistant", content: args.content },
        ],
      },
      signal,
    );
    if (!plan) {
      return args.content;
    }
    if (Buffer.byteLength(JSON.stringify(plan.messages)) > 2 * 1024 * 1024) {
      throw new Error("Integration reply snapshot is too large");
    }

    const publish = async () => {
      const claimed = await args.db.transaction(async (tx) => {
        await tx.insert(sharedThreads).values({
          id: plan.policy.threadId,
          userId: owner.userId,
          orgId: owner.orgId,
          sourceChatThreadId: owner.chatThreadId,
          hasArtifactSnapshot: true,
          publicBrand: args.publicBrand,
          title: "Integration reply",
          messages: plan.messages,
        });
        const [delivery] = await tx
          .insert(integrationArtifactDeliveries)
          .values({
            deliveryKey: args.deliveryKey,
            snapshotId: plan.policy.threadId,
            sourceContentHash: identity.sourceContentHash,
          })
          .onConflictDoNothing({
            target: integrationArtifactDeliveries.deliveryKey,
          })
          .returning({ snapshotId: integrationArtifactDeliveries.snapshotId });
        if (!delivery) {
          await tx
            .delete(sharedThreads)
            .where(eq(sharedThreads.id, plan.policy.threadId));
          return false;
        }
        // Commit the parent and rewritten message before activation. The same
        // parent lock and fresh membership check as thread sharing own publish.
        await set(initializeSharedThreadArtifacts$, plan, signal);
        signal.throwIfAborted();
        return true;
      });
      signal.throwIfAborted();
      if (!claimed) {
        const content = await set(existingReply$, identity, signal);
        if (content === undefined) {
          throw new Error(
            "Integration reply snapshot preparation must be retried",
          );
        }
        return content;
      }
      await set(publishSharedThreadArtifacts$, plan, signal);
      signal.throwIfAborted();
      return plan.messages[0]!.content;
    };
    return await onRejection(publish(), async () => {
      // Cleanup must finish even when the callback/request has been cancelled.
      await set(
        discardIncompleteReply$,
        { db: args.db, plan },
        AbortSignal.timeout(30_000),
      );
    });
  },
);

/** Prepare the final reply before provider-specific formatting or truncation. */
export async function snapshotIntegrationReply(
  args: IntegrationReply,
  signal: AbortSignal,
): Promise<string> {
  return await createStore().set(prepareIntegrationReply$, args, signal);
}
