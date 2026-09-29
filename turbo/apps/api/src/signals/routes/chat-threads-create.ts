import { command } from "ccstate";
import {
  type CodexServiceTier,
  type ChatThreadServiceTier,
  chatThreadsContract,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { InitialRemoteAccessOverride } from "@okouai/api-contracts/contracts/chat-remote-access";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { clerk$ } from "../external/clerk";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { publishThreadListChanged } from "../external/realtime";
import {
  badRequestMessage,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import {
  createChatThread$,
  type CreatedChatThread,
  type ExistingChatThread,
} from "../services/chat-thread.service";
import { agentExistsInOrg } from "../services/agent-deletion.service";
import {
  resolveDefaultModelFirstPin$,
  resolveModelSelectionPin$,
  validateCodexServiceTier,
} from "../services/model-selection.service";
import { chatThreadModelPinColumns } from "../services/chat-thread-model.service";
import { chatThreadServiceTierFromCodex } from "../services/chat-thread-event.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { hasCurrentVncMembership } from "../services/vnc-owner-lifecycle.service";
import { loadNewChatThreadDefaults$ } from "../services/chat-thread-defaults.service";
import { resolveChatReasoningEffort } from "../services/chat-reasoning-effort.service";
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

const validateInitialRemoteAccess$ = command(
  async (
    { get },
    args: {
      readonly owner: { readonly orgId: string; readonly userId: string };
      readonly tokenType: string;
      readonly overrides: readonly InitialRemoteAccessOverride[];
    },
    signal: AbortSignal,
  ) => {
    if (args.overrides.length === 0) {
      return null;
    }
    if (args.tokenType !== "session") {
      return resourceUnavailable("Remote access selection is not available");
    }
    const featureContext = await get(
      userFeatureSwitchContext(args.owner.orgId, args.owner.userId),
    );
    signal.throwIfAborted();
    if (
      args.overrides.some((item) => {
        return item.protocol === "vnc";
      }) &&
      (!isFeatureEnabled(FeatureSwitchKey.VncAccess, featureContext) ||
        !(await hasCurrentVncMembership(get(clerk$), args.owner, signal)))
    ) {
      return badRequestMessage("VNC access is not available");
    }
    return null;
  },
);

const initialThreadModel$ = command(
  async (
    { set },
    owner: { readonly orgId: string; readonly userId: string },
    requested: {
      readonly model?: string;
      readonly serviceTier?: ChatThreadServiceTier | null;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly selectedModel: string | null;
    readonly codexServiceTier: CodexServiceTier | null;
  }> => {
    const initial =
      requested.model === undefined
        ? await set(resolveDefaultModelFirstPin$, owner, signal)
        : { selectedModel: requested.model, serviceTier: null };
    signal.throwIfAborted();
    const serviceTier =
      requested.serviceTier === undefined
        ? initial.serviceTier
        : requested.serviceTier;
    return {
      selectedModel: initial.selectedModel,
      codexServiceTier: serviceTier === "priority" ? "fast" : null,
    };
  },
);

const createInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(createBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const initialRemoteAccessOverrides =
    body.data.initialRemoteAccessOverrides ?? [];
  const remoteAccessError = await set(
    validateInitialRemoteAccess$,
    {
      owner: auth,
      tokenType: auth.tokenType,
      overrides: initialRemoteAccessOverrides,
    },
    signal,
  );
  if (remoteAccessError) {
    return remoteAccessError;
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

  const connectorSelections = body.data.connectorSelections ?? [];
  const { selectedModel, codexServiceTier } = await set(
    initialThreadModel$,
    auth,
    body.data,
    signal,
  );
  signal.throwIfAborted();
  if (!selectedModel) {
    return badRequestMessage("A model selection is required");
  }
  const pin = await set(
    resolveModelSelectionPin$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      modelSelection: modelFirstSelection(selectedModel),
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in pin) {
    return pin;
  }
  const codexServiceTierError = validateCodexServiceTier({
    pin,
    codexServiceTier,
  });
  if (codexServiceTierError) {
    return codexServiceTierError;
  }

  const defaults = await set(
    loadNewChatThreadDefaults$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
    },
    signal,
  );
  signal.throwIfAborted();
  const effort = resolveChatReasoningEffort({
    selectedModel: pin.selectedModel,
    modelSettings: defaults.modelSettings,
    requested: body.data.reasoningEffort,
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
      cloudBrowserEnabled: defaults.cloudBrowserEnabled,
      codexServiceTier,
      connectorSelections,
      initialRemoteAccessOverrides,
    },
    signal,
  );
  signal.throwIfAborted();
  if (thread.kind === "invalid_connector_selection") {
    return badRequestMessage(thread.message);
  }
  if (thread.kind === "invalid_remote_access_selection") {
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
