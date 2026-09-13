import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  type CodexServiceTier,
  chatThreadsContract,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  isImageModelId,
  type ImageModelId,
} from "@okouai/api-contracts/contracts/image-models";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { type Db, writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { badRequestMessage, notFound } from "../../lib/error";
import {
  createChatThread$,
  type CreatedChatThread,
  type ExistingChatThread,
} from "../services/chat-thread.service";
import { agentExistsInOrg } from "../services/agent-deletion.service";
import { loadNewChatThreadMediaModels } from "../services/chat-thread-media-model.service";
import {
  resolveModelSelectionPin,
  validateCodexServiceTier,
} from "../services/model-selection.service";
import { chatThreadModelPinColumns } from "../services/chat-thread-model.service";
import { chatThreadServiceTierFromCodex } from "../services/chat-thread-event.service";
import { loadNewChatThreadModelSettings } from "../services/chat-thread-model-settings.service";
import { resolveChatReasoningEffort } from "../services/chat-reasoning-effort.service";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { RouteEntry } from "../route-entry";

const createBody$ = bodyResultOf(chatThreadsContract.create);

function modelFirstSelection(selectedModel: string) {
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel,
  };
}

interface ChatThreadCreateSettings {
  readonly title: string | null;
  readonly selectedModel: string;
  readonly codexServiceTier: CodexServiceTier | null;
}

function chatThreadCreatedResponse(
  thread: { readonly id: string; readonly createdAt: Date },
  settings: ChatThreadCreateSettings,
) {
  return {
    status: 201 as const,
    body: {
      id: thread.id,
      title: settings.title,
      createdAt: thread.createdAt.toISOString(),
      selectedModel: settings.selectedModel,
      serviceTier: chatThreadServiceTierFromCodex(settings.codexServiceTier),
    },
  };
}

/**
 * The created thread, or the one a duplicate delivery replays. A replay answers
 * with the stored settings rather than the repeated request, because the member
 * may have renamed or repinned the thread since the original delivery.
 *
 * A replay is an expected, non-actionable outcome, so it emits no log of its
 * own: the request log already records both deliveries under one
 * `x_client_request_id`, now as two 201s instead of a 201 and a 500.
 */
function chatThreadCreateResponse(
  thread: CreatedChatThread | ExistingChatThread,
  requested: ChatThreadCreateSettings,
) {
  if (thread.kind === "created") {
    return chatThreadCreatedResponse(thread, requested);
  }
  return chatThreadCreatedResponse(thread, {
    title: thread.title,
    selectedModel: thread.selectedModel ?? requested.selectedModel,
    codexServiceTier: thread.codexServiceTier,
  });
}

/**
 * Model, priority, and media models a caller inherits when it omits them. The
 * model belongs to the run that owns its token; the other settings belong to
 * that run's chat thread.
 */
async function inheritedRunChatSettings(
  db: Db,
  runId: string | undefined,
): Promise<{
  readonly selectedModel: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly selectedVideoModel: string | null;
  readonly selectedImageModel: ImageModelId | null;
}> {
  if (!runId) {
    return {
      selectedModel: null,
      codexServiceTier: null,
      selectedVideoModel: null,
      selectedImageModel: null,
    };
  }

  const [run] = await db
    .select({
      selectedModel: agentRuns.selectedModel,
      codexServiceTier: chatThreads.codexServiceTier,
      selectedVideoModel: chatThreads.selectedVideoModel,
      selectedImageModel: chatThreads.selectedImageModel,
    })
    .from(agentRuns)
    .leftJoin(chatThreads, eq(agentRuns.chatThreadId, chatThreads.id))
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  return {
    selectedModel: run?.selectedModel ?? null,
    codexServiceTier: run?.codexServiceTier ?? null,
    selectedVideoModel: run?.selectedVideoModel ?? null,
    selectedImageModel: isImageModelId(run?.selectedImageModel)
      ? run.selectedImageModel
      : null,
  };
}

const createInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(createBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const exists = await get(
    agentExistsInOrg({
      orgId: auth.orgId,
      agentId: body.data.agentId,
    }),
  );
  signal.throwIfAborted();
  if (!exists) {
    return notFound("Agent not found");
  }

  const writeDb = set(writeDb$);
  const connectorSelections = body.data.connectorSelections ?? [];
  const callerRunId =
    auth.tokenType === "sandbox" || auth.tokenType === "agent"
      ? auth.runId
      : undefined;
  const inherited = await inheritedRunChatSettings(writeDb, callerRunId);
  signal.throwIfAborted();
  const selectedModel = body.data.model ?? inherited.selectedModel;
  if (!selectedModel) {
    return badRequestMessage("A model selection is required");
  }
  const codexServiceTier: CodexServiceTier | null =
    body.data.serviceTier === undefined
      ? inherited.codexServiceTier
      : body.data.serviceTier === "priority"
        ? "fast"
        : null;
  // Explicit request, then what the caller's own thread pinned, then the
  // member and catalog defaults. The last step is what keeps a thread from
  // following a default the member changes after this thread exists.
  const mediaDefaults = await loadNewChatThreadMediaModels(writeDb, {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  signal.throwIfAborted();
  const selectedVideoModel =
    body.data.videoModel ??
    inherited.selectedVideoModel ??
    mediaDefaults.selectedVideoModel;
  const selectedImageModel =
    body.data.imageModel ??
    inherited.selectedImageModel ??
    mediaDefaults.selectedImageModel;

  const pin = await resolveModelSelectionPin({
    db: writeDb,
    orgId: auth.orgId,
    userId: auth.userId,
    modelSelection: modelFirstSelection(selectedModel),
  });
  signal.throwIfAborted();
  if ("status" in pin) {
    return pin;
  }
  const codexServiceTierError = await validateCodexServiceTier({
    db: writeDb,
    orgId: auth.orgId,
    userId: auth.userId,
    pin,
    codexServiceTier,
  });
  signal.throwIfAborted();
  if (codexServiceTierError) {
    return codexServiceTierError;
  }

  const [modelSettings, featureSwitchContext] = await Promise.all([
    loadNewChatThreadModelSettings(writeDb, {
      orgId: auth.orgId,
      userId: auth.userId,
    }),
    loadUserFeatureSwitchContext(writeDb, auth.orgId, auth.userId),
  ]);
  signal.throwIfAborted();
  const effort = resolveChatReasoningEffort({
    selectedModel: pin.selectedModel,
    modelSettings,
    requested: body.data.reasoningEffort,
    enabled: isFeatureEnabled(
      FeatureSwitchKey.ChatReasoningEffort,
      featureSwitchContext,
    ),
  });
  if ("status" in effort) {
    return effort;
  }

  const thread = await set(
    createChatThread$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      agentId: body.data.agentId,
      title: body.data.title,
      clientThreadId: body.data.clientThreadId,
      eventId: body.data.eventId,
      ...chatThreadModelPinColumns(pin),
      modelSettings: effort.modelSettings,
      codexServiceTier,
      selectedVideoModel,
      selectedImageModel,
      connectorSelections,
    },
    signal,
  );
  signal.throwIfAborted();
  if (thread.kind === "invalid_connector_selection") {
    return badRequestMessage(thread.message);
  }
  // The id already belongs to another member, org, or agent. Answer exactly
  // like a thread that does not exist so a collision discloses no ownership.
  if (thread.kind === "client_thread_conflict") {
    return notFound("Chat thread not found");
  }

  // The thread list invalidation is idempotent, so a replay also repairs a
  // realtime notification the original delivery may have lost.
  await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
  signal.throwIfAborted();

  return chatThreadCreateResponse(thread, {
    title: body.data.title ?? null,
    selectedModel,
    codexServiceTier,
  });
});

export const chatThreadCreateRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadsContract.create,
    handler: authRoute(
      {
        requiredCapability: "chat-thread:write",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      createInner$,
    ),
  },
];
