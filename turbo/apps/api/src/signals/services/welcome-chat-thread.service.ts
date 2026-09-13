import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";

import { env } from "../../lib/env";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { welcomeThreadContent } from "../../lib/welcome-thread-content";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { insertChatEvent } from "./chat-event.service";
import { createChatThreadInTransaction } from "./chat-thread.service";
import { loadNewChatThreadMediaModels } from "./chat-thread-media-model.service";
import { chatThreadModelPinColumns } from "./chat-thread-model.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveDefaultModelFirstPin } from "./model-selection.service";
import { userPreferences } from "./user-data.service";

interface WelcomeThreadAction {
  readonly userId: string;
  readonly orgId: string;
  readonly clientThreadId: string;
}

interface WelcomeThreadRecipient {
  readonly userId: string;
  readonly orgId: string;
}

/**
 * Permanent server namespace for automatically delivered welcome threads. It
 * identifies the thread, never the seed event, and is independent of template
 * versions and localized copy.
 */
const AUTOMATIC_WELCOME_THREAD_NAMESPACE =
  "92aa933e-a5fe-4b89-8d50-955b93b40459";

/**
 * The single welcome thread id a recipient may ever hold in a workspace. The
 * server derives it from identity instead of accepting it from a caller, so
 * `chat_threads`'s primary key is the deduplication key and concurrent
 * triggers converge on `onConflictDoNothing`. The manual
 * `POST /api/welcome-chat-threads` path keeps its per-action caller id.
 */
export function automaticWelcomeChatThreadId(
  recipient: WelcomeThreadRecipient,
): string {
  return uuidv5(
    `${recipient.userId}:${recipient.orgId}`,
    AUTOMATIC_WELCOME_THREAD_NAMESPACE,
  );
}

export type WelcomeThreadDeliveryOutcome =
  | {
      readonly outcome: "delivered" | "already-delivered";
      readonly threadId: string;
    }
  | {
      readonly outcome: "skipped";
      readonly reason: "disabled" | "default-agent-not-ready";
    };

export const createWelcomeChatThread$ = command(
  async ({ get, set }, args: WelcomeThreadAction, signal: AbortSignal) => {
    const db = set(writeDb$);
    const switches = await loadUserFeatureSwitchContext(
      db,
      args.orgId,
      args.userId,
    );
    signal.throwIfAborted();
    if (!isFeatureEnabled(FeatureSwitchKey.WelcomeThread, switches)) {
      return {
        status: 403 as const,
        body: {
          error: {
            code: "FORBIDDEN",
            message: "Welcome thread is not enabled",
          },
        },
      };
    }

    const [agent] = await db
      .select({ id: agents.id })
      .from(orgMetadata)
      .innerJoin(
        agents,
        and(
          eq(agents.id, orgMetadata.defaultAgentId),
          eq(agents.orgId, orgMetadata.orgId),
          visibleJoinedAgentCondition(args.userId),
        ),
      )
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return conflict(
        "The workspace default agent is unavailable. Ask a workspace admin to configure it, then retry.",
      );
    }

    const pin = await resolveDefaultModelFirstPin(db, args.orgId, args.userId);
    signal.throwIfAborted();
    const media = await loadNewChatThreadMediaModels(db, args);
    signal.throwIfAborted();
    const preferences = await get(userPreferences(args));
    signal.throwIfAborted();
    const content = welcomeThreadContent({
      locale: preferences.locale ?? "en-US",
      appUrl: env("APP_URL"),
    });

    const result = await db.transaction(async (tx) => {
      const thread = await createChatThreadInTransaction(tx, {
        ...args,
        agentId: agent.id,
        title: content.title,
        eventId: undefined,
        ...chatThreadModelPinColumns(pin),
        codexServiceTier: pin.serviceTier === "priority" ? "fast" : null,
        ...media,
      });
      signal.throwIfAborted();
      if (thread.kind === "created") {
        await insertChatEvent(tx, {
          chatThreadId: thread.id,
          eventType: "output.message",
          content: content.content,
          createdAt: nowDate(),
        });
        signal.throwIfAborted();
      }
      return thread;
    });
    signal.throwIfAborted();
    if (result.kind === "invalid_connector_selection") {
      return badRequestMessage(result.message);
    }
    // The id already belongs to another thread. Answer exactly like a thread
    // that does not exist so a collision discloses no ownership.
    if (result.kind === "client_thread_conflict") {
      return notFound("Chat thread not found");
    }
    return { status: 201 as const, body: { id: result.id } };
  },
);

/**
 * Deliver the welcome thread a registration event owes one recipient, using the
 * identity-derived id so redeliveries and concurrent triggers converge on the
 * same row. Every non-delivery is a terminal outcome for this invocation: the
 * caller logs it and gives up. Nothing here retries, polls, enqueues or
 * schedules, and nothing re-checks the recipient later.
 */
export const deliverWelcomeChatThread$ = command(
  async (
    { set },
    recipient: WelcomeThreadRecipient,
    signal: AbortSignal,
  ): Promise<WelcomeThreadDeliveryOutcome> => {
    const threadId = automaticWelcomeChatThreadId(recipient);
    const result = await set(
      createWelcomeChatThread$,
      { ...recipient, clientThreadId: threadId },
      signal,
    );
    signal.throwIfAborted();
    if (result.status === 201) {
      return { outcome: "delivered", threadId: result.body.id };
    }
    if (result.status === 404) {
      // Creation answers the id collision exactly like a missing thread. Only
      // this recipient's own earlier delivery can hold an id derived from this
      // recipient's identity, so the welcome is already there.
      return { outcome: "already-delivered", threadId };
    }
    if (result.status === 403) {
      return { outcome: "skipped", reason: "disabled" };
    }
    if (result.status === 409) {
      return { outcome: "skipped", reason: "default-agent-not-ready" };
    }
    // Creation's only remaining answer is the invalid-connector-selection 400,
    // which automatic delivery cannot reach because it selects no connectors.
    // Report it as the broken invariant it would be, not as a routine skip.
    throw new Error(
      `Unexpected welcome thread creation status ${result.status}`,
    );
  },
);
