import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { resolveChatReasoningEffort } from "../services/chat-reasoning-effort.service";
import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  chatThreadModelSelectionContract,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
} from "@okouai/api-contracts/contracts/chat-threads";
import { modelSettingsSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";
import {
  appendChatThreadEvent,
  chatThreadServiceTierFromCodex,
} from "../services/chat-thread-event.service";
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

async function resolveRequestedModelPin(
  db: Db,
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
    db,
    orgId: auth.orgId,
    userId: auth.userId,
    modelSelection: {
      modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
      selectedModel: model,
    },
  });
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
    const pin = await resolveRequestedModelPin(writeDb, auth, body.data.model);
    signal.throwIfAborted();

    if ("status" in pin) {
      return pin;
    }
    const context = await loadUserFeatureSwitchContext(
      writeDb,
      auth.orgId,
      auth.userId,
    );
    signal.throwIfAborted();
    const updated = await writeDb.transaction(async (tx) => {
      const condition = and(
        eq(chatThreads.id, params.id),
        eq(chatThreads.userId, auth.userId),
        chatThreadOrganizationCondition(tx, auth.orgId),
        isNotNull(chatThreads.agentId),
      );
      const [current] = await tx
        .select({
          modelSettings: chatThreads.modelSettings,
          codexServiceTier: chatThreads.codexServiceTier,
        })
        .from(chatThreads)
        .where(condition)
        .for("update");
      if (!current) {
        return notFound("Chat thread not found");
      }
      const effort = resolveChatReasoningEffort({
        selectedModel: pin.selectedModel,
        modelSettings: modelSettingsSchema.parse(current.modelSettings),
        requested: body.data.reasoningEffort,
        enabled: isFeatureEnabled(
          FeatureSwitchKey.ChatReasoningEffort,
          context,
        ),
      });
      if ("status" in effort) {
        return effort;
      }
      // An effort-only update preserves Fast. Legacy model updates keep their
      // existing omission semantics until clients send independent fields.
      const codexServiceTier =
        body.data.codexServiceTier === undefined &&
        body.data.reasoningEffort !== undefined
          ? current.codexServiceTier
          : (body.data.codexServiceTier ?? null);
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
        eventId: body.data.eventId,
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
        eventId: body.data.serviceTierEventId,
        serviceTier: chatThreadServiceTierFromCodex(codexServiceTier),
        createdAt: updatedAt,
      });
      return true;
    });
    signal.throwIfAborted();

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
