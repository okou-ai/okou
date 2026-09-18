import { resolveChatReasoningEffort } from "../services/chat-reasoning-effort.service";
import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import type { z } from "zod";
import {
  chatThreadModelSelectionContract,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
} from "@okouai/api-contracts/contracts/chat-threads";
import { modelSettingsSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";
import type { Tx } from "../../lib/db-types";
import {
  appendChatThreadEvent,
  chatThreadServiceTierFromCodex,
} from "../services/chat-thread-event.service";
import { withChatThreadContentWrite } from "../services/chat-thread-content-erasure-admission.service";
import { chatThreadOrganizationCondition } from "../services/chat-thread-organization.service";
import {
  resolveModelSelectionPin,
  validateCodexServiceTier,
} from "../services/model-selection.service";
import { chatThreadModelPinColumns } from "../services/chat-thread-model.service";
import type { RouteEntry } from "../route-entry";

const modelSelectionBody$ = bodyResultOf(
  chatThreadModelSelectionContract.update,
);

type ModelSelectionUpdateBody = z.infer<
  typeof chatThreadModelSelectionContract.update.body
>;

/**
 * `resolveModelSelectionPin` is not a pure validator: for a model-first
 * selection it calls `ensureOrgModelPolicies`, which lazily seeds and repairs
 * this organization's model policies and attributes `created_by_user_id` /
 * `updated_by_user_id` to the requester. Those are account-associated durable
 * writes, so the transaction argument must be the admitted transaction itself.
 * Drizzle turns the resolver's nested `transaction` into a `SAVEPOINT` on this
 * connection, never a second connection that could commit independently.
 */
async function resolveRequestedModelPin(
  tx: Tx,
  auth: { readonly orgId: string; readonly userId: string },
  model: string | null,
) {
  if (model === null) {
    return {
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: null,
    };
  }
  return await resolveModelSelectionPin({
    db: tx,
    orgId: auth.orgId,
    userId: auth.userId,
    modelSelection: {
      modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
      selectedModel: model,
    },
  });
}

/**
 * The admitted write itself: it runs only after the shared admission has
 * resolved the canonical identity, cleared B1 and retained the Agent and thread
 * identity locks, so every statement here is already fenced.
 */
async function writeModelSelection(
  tx: Tx,
  args: {
    readonly auth: { readonly orgId: string; readonly userId: string };
    readonly threadId: string;
    readonly body: ModelSelectionUpdateBody;
  },
  signal: AbortSignal,
) {
  const { auth, body } = args;
  const condition = and(
    eq(chatThreads.id, args.threadId),
    eq(chatThreads.userId, auth.userId),
    chatThreadOrganizationCondition(tx, auth.orgId),
    isNotNull(chatThreads.agentId),
  );
  // `FOR NO KEY UPDATE`, not `FOR UPDATE`: the admission helper already
  // retains `FOR KEY SHARE` on this row, and `FOR UPDATE` conflicts with
  // it, so two concurrent settings writers would each wait for the
  // other's retained KEY SHARE and deadlock. NO KEY UPDATE conflicts
  // with another settings, rename or pin writer -- which is what
  // serializes the sparse `model_settings` read/modify/write -- but not
  // with a retained KEY SHARE. Taking it before the policy resolver also
  // keeps the established thread -> model-policy lock order that
  // `resolvePersistedChatThreadModel` already uses.
  const [current] = await tx
    .select({
      modelSettings: chatThreads.modelSettings,
      codexServiceTier: chatThreads.codexServiceTier,
    })
    .from(chatThreads)
    .where(condition)
    .for("no key update");
  if (!current) {
    return notFound("Chat thread not found");
  }
  const pin = await resolveRequestedModelPin(tx, auth, body.model);
  signal.throwIfAborted();
  if ("status" in pin) {
    return pin;
  }
  const effort = resolveChatReasoningEffort({
    selectedModel: pin.selectedModel,
    modelSettings: modelSettingsSchema.parse(current.modelSettings),
    requested: body.reasoningEffort,
  });
  if ("status" in effort) {
    return effort;
  }
  // An effort-only update preserves Fast. Legacy model updates keep their
  // existing omission semantics until clients send independent fields.
  const codexServiceTier =
    body.codexServiceTier === undefined && body.reasoningEffort !== undefined
      ? current.codexServiceTier
      : (body.codexServiceTier ?? null);
  const tierError = await validateCodexServiceTier({
    db: tx,
    orgId: auth.orgId,
    userId: auth.userId,
    pin,
    codexServiceTier,
  });
  if (tierError) {
    return tierError;
  }
  const updatedAt = nowDate();
  const pinColumns = chatThreadModelPinColumns(pin);
  const [thread] = await tx
    .update(chatThreads)
    .set({
      modelProviderId: pinColumns.modelProviderId,
      modelProviderType: pinColumns.modelProviderType,
      modelProviderCredentialScope: pinColumns.modelProviderCredentialScope,
      selectedModel: pinColumns.selectedModel,
      codexServiceTier,
      modelSettings: effort.modelSettings,
      updatedAt,
    })
    .where(condition)
    .returning({
      id: chatThreads.id,
      agentId: chatThreads.agentId,
    });
  if (!thread?.agentId) {
    return false;
  }
  await appendChatThreadEvent(tx, {
    kind: "model_selection_updated",
    userId: auth.userId,
    orgId: auth.orgId,
    chatThreadId: thread.id,
    agentId: thread.agentId,
    eventId: body.eventId,
    selectedModel: pin.selectedModel,
    modelSettingsPatch: effort.modelSettingsPatch,
    createdAt: updatedAt,
  });
  await appendChatThreadEvent(tx, {
    kind: "service_tier_updated",
    userId: auth.userId,
    orgId: auth.orgId,
    chatThreadId: thread.id,
    agentId: thread.agentId,
    eventId: body.serviceTierEventId,
    serviceTier: chatThreadServiceTierFromCodex(codexServiceTier),
    createdAt: updatedAt,
  });
  return true;
}

const updateModelSelectionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(chatThreadModelSelectionContract.update));
    const body = await get(modelSelectionBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const writeDb = set(writeDb$);

    // A thread's model pin, its per-model reasoning effort and its Codex
    // service tier are account content, and so are the two sidebar events and
    // the durable sequence ids they consume. The whole write now runs inside
    // the shared B1 admission and the canonical Agent/thread locks, including
    // the lazy model-policy bootstrap the pin resolver performs: leaving that
    // resolver outside would still let a closed account create or repair
    // policy rows attributed to itself. B1 closure reuses this route's
    // existing 404, alongside its unchanged organization, `chat-thread:write`
    // and non-null Agent requirements.
    const result = await withChatThreadContentWrite(
      writeDb,
      {
        chatThreadId: params.id,
        authorize: (identity) => {
          return (
            identity.userId === auth.userId &&
            identity.agentId !== null &&
            identity.orgId === auth.orgId
          );
        },
      },
      async (tx) => {
        return await writeModelSelection(
          tx,
          { auth, threadId: params.id, body: body.data },
          signal,
        );
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.outcome !== "written") {
      return notFound("Chat thread not found");
    }
    const updated = result.value;
    if (typeof updated === "object") {
      return updated;
    }
    if (!updated) {
      return notFound("Chat thread not found");
    }

    await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const chatThreadModelSelectionRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadModelSelectionContract.update,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      updateModelSelectionInner$,
    ),
  },
];
