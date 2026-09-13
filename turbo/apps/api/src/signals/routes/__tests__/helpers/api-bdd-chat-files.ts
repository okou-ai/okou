import { randomUUID } from "node:crypto";
import {
  chatEventsContract,
  chatSearchContract,
  chatThreadArtifactsContract,
  chatThreadByIdContract,
  chatThreadComputerUseHostContract,
  chatThreadDraftContract,
  chatThreadEventsContract,
  chatThreadImageModelContract,
  chatThreadVideoModelContract,
  chatThreadMarkAgentReadContract,
  chatThreadMarkReadContract,
  chatThreadMarkUnreadContract,
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  chatThreadPinContract,
  chatThreadRenameContract,
  chatThreadUnpinContract,
  chatThreadsContract,
  type ChatEvent,
  type ChatSearchResponse,
  type ChatThreadArtifactRun,
  type ChatThreadDetail,
  type ChatThreadDraft,
  type ChatThreadMetadata,
  type ChatThreadSnapshotProjection,
  type ChatRunOptionsRequest,
  type CodexServiceTier,
  type ReasoningEffort,
  type PersistedAttachment,
  type UserMessageDocument,
  type UserMessageInputDocument,
  type Indicators,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ImageModelId } from "@okouai/api-contracts/contracts/image-models";
import type { VideoModelId } from "@okouai/api-contracts/contracts/video-models";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventCursor,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import {
  artifactCatalogContract,
  type ArtifactCatalogKind,
  type ArtifactDetail,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import type { ApiErrorResponse } from "@okouai/api-contracts/contracts/errors";
import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import {
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  hostContract,
  type HostedSiteCompleteResponse,
  type HostedSiteDeploymentsResponse,
  type HostedSitePrepareRequest,
  type HostedSitePrepareResponse,
} from "@okouai/api-contracts/contracts/host";
import {
  uploadsContract,
  type UploadCompleteResponse,
  type UploadPrepareResponse,
} from "@okouai/api-contracts/contracts/uploads";
import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import type { UsagePricingResolution } from "../../../context/usage-pricing-resolution";
import {
  buildArtifactKey,
  sanitizeArtifactFilename,
} from "../../../../lib/file-url";
import { agentsRoutes } from "../../agents";
import { chatEventsRoutes } from "../../chat-events";
import { artifactCatalogRoutes } from "../../artifact-catalog";
import { chatThreadComputerUseHostRoutes } from "../../chat-threads-computer-use-host";
import { chatThreadCreateRoutes } from "../../chat-threads-create";
import { chatThreadDeleteRoutes } from "../../chat-threads-delete";
import { chatThreadImageModelRoutes } from "../../chat-threads-image-model";
import { chatThreadVideoModelRoutes } from "../../chat-threads-video-model";
import { chatThreadMarkReadRoutes } from "../../chat-threads-mark-read";
import { chatThreadModelSelectionRoutes } from "../../chat-threads-model-selection";
import { chatThreadPatchRoutes } from "../../chat-threads-patch";
import { chatThreadPinRoutes } from "../../chat-threads-pin";
import { chatThreadRenameRoutes } from "../../chat-threads-rename";
import { chatThreadRoutes } from "../../chat-threads";
import { chatThreadUnpinRoutes } from "../../chat-threads-unpin";
import { chatThreadsArtifactsSyncRoutes } from "../../chat-threads-artifacts-sync";
import { hostRoutes } from "../../host";
import { modelPoliciesRoutes } from "../../model-policies";
import { uploadsCompleteRoutes } from "../../uploads-complete";
import { uploadsPrepareRoutes } from "../../uploads-prepare";
import { userModelPreferenceRoutes } from "../../user-model-preference";
import type { ApiTestUser } from "./api-bdd";
import {
  projectChatEventRows,
  readProjectedChatEvents,
} from "./chat-event-test-reader";
import { createRouteMocks } from "./route-test";

interface AuthHeaders {
  readonly authorization?: string;
}

type BddSendEventBody =
  | {
      readonly agentId: string;
      readonly prompt: string;
      readonly threadId?: string;
      readonly clientThreadId?: string;
      readonly model?: SupportedRunModel;
      readonly runOptions?: ChatRunOptionsRequest;
      readonly userMessage?: UserMessageDocument;
      readonly hasTextContent?: boolean;
      readonly computerUseHostId?: string | null;
      readonly cloudBrowserEnabled?: boolean;
      readonly clientEventId?: string;
      readonly chatThreadSortEventId?: string;
      readonly realAgentInPreview?: boolean;
      readonly captureNetworkBodies?: boolean;
      readonly revokesEventId?: string;
      readonly sourceRunId?: string;
    }
  | {
      readonly agentId: string;
      readonly threadId: string;
      readonly revokesEventId: string;
      readonly clientEventId?: string;
    }
  | {
      readonly agentId: string;
      readonly threadId: string;
      readonly interruptsRunId: string;
      readonly clientEventId?: string;
    };

interface RequestSendEventOptions {
  readonly usagePricingResolution?: UsagePricingResolution;
}

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor
    ? {
        authorization: "Bearer clerk-session",
      }
    : {};
}

function authenticate(
  context: TestContext,
  actor: ApiTestUser | null,
): AuthHeaders {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return authHeaders(actor);
}

function authenticateChatEvent(
  context: TestContext,
  actor: ApiTestUser | null,
) {
  return {
    ...authenticate(context, actor),
    [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
  };
}

function commandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
}

function mockObjectStorageObjectsExist(context: TestContext): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const name = commandName(command);
    if (name === "HeadObjectCommand") {
      return Promise.resolve({ ContentLength: 1024 });
    }
    return Promise.resolve({});
  });
}

const chatFilesRoutes = [
  ...agentsRoutes,
  ...artifactCatalogRoutes,
  ...chatThreadRoutes,
  ...chatThreadCreateRoutes,
  ...chatThreadDeleteRoutes,
  ...chatThreadPatchRoutes,
  ...chatThreadMarkReadRoutes,
  ...chatThreadPinRoutes,
  ...chatThreadUnpinRoutes,
  ...chatThreadRenameRoutes,
  ...chatThreadImageModelRoutes,
  ...chatThreadVideoModelRoutes,
  ...chatThreadModelSelectionRoutes,
  ...chatThreadComputerUseHostRoutes,
  ...chatThreadsArtifactsSyncRoutes,
  ...chatEventsRoutes,
  ...uploadsPrepareRoutes,
  ...uploadsCompleteRoutes,
  ...hostRoutes,
  ...modelPoliciesRoutes,
  ...userModelPreferenceRoutes,
] as const;

function chatFilesApp(context: TestContext) {
  return setupAppWithRoutes({ context, routes: chatFilesRoutes });
}

export function persistedAttachment(
  id: string,
  filename: string,
  contentType: string,
  size: number,
): PersistedAttachment {
  return {
    id,
    filename,
    contentType,
    size,
    url: `https://cdn.vm7.io/artifacts/test/${id}/${filename}`,
  };
}

export function createChatFilesBddApi(context: TestContext) {
  const mocks = createRouteMocks(context);

  function mockCompletedUploadObjects(
    actor: ApiTestUser,
    objects: readonly {
      readonly id: string;
      readonly filename: string;
      readonly size: number;
    }[],
  ): void {
    mocks.s3.listObjects(
      objects.map((object) => {
        return {
          bucket: "test-user-artifacts",
          key: buildArtifactKey(
            actor.userId,
            object.id,
            sanitizeArtifactFilename(object.filename),
          ),
          size: object.size,
        };
      }),
    );
  }

  function threadsClient() {
    return chatFilesApp(context)(chatThreadsContract);
  }

  function modelPoliciesClient() {
    return chatFilesApp(context)(modelPoliciesMainContract);
  }

  async function defaultCreateThreadModel(
    actor: ApiTestUser | null,
  ): Promise<SupportedRunModel> {
    if (!actor?.orgId) {
      return DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
    }
    const response = await accept(
      modelPoliciesClient().list({ headers: authenticate(context, actor) }),
      [200],
    );
    const model =
      response.body.workspaceDefaultModel ??
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
    return isSupportedRunModel(model)
      ? model
      : DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
  }

  function threadByIdClient() {
    return chatFilesApp(context)(chatThreadByIdContract);
  }

  function threadMetadataClient() {
    return chatFilesApp(context)(chatThreadMetadataContract);
  }

  function threadDraftClient() {
    return chatFilesApp(context)(chatThreadDraftContract);
  }

  function threadEventsClient() {
    return chatFilesApp(context)(chatThreadEventsContract);
  }

  function threadArtifactsClient() {
    return chatFilesApp(context)(chatThreadArtifactsContract);
  }

  function artifactCatalogClient() {
    return chatFilesApp(context)(artifactCatalogContract);
  }

  function threadMarkReadClient() {
    return chatFilesApp(context)(chatThreadMarkReadContract);
  }

  function threadMarkUnreadClient() {
    return chatFilesApp(context)(chatThreadMarkUnreadContract);
  }

  function threadMarkAgentReadClient() {
    return chatFilesApp(context)(chatThreadMarkAgentReadContract);
  }

  function threadPinClient() {
    return chatFilesApp(context)(chatThreadPinContract);
  }

  function threadUnpinClient() {
    return chatFilesApp(context)(chatThreadUnpinContract);
  }

  function threadRenameClient() {
    return chatFilesApp(context)(chatThreadRenameContract);
  }

  function threadModelSelectionClient() {
    return chatFilesApp(context)(chatThreadModelSelectionContract);
  }

  function threadImageModelClient() {
    return chatFilesApp(context)(chatThreadImageModelContract);
  }

  function threadVideoModelClient() {
    return chatFilesApp(context)(chatThreadVideoModelContract);
  }

  function userModelPreferenceClient() {
    return chatFilesApp(context)(userModelPreferenceContract);
  }

  function threadComputerUseHostClient() {
    return chatFilesApp(context)(chatThreadComputerUseHostContract);
  }

  function chatSearchClient() {
    return chatFilesApp(context)(chatSearchContract);
  }

  /**
   * Raw-bearer auth headers for tokens that are not Clerk sessions (PATs,
   * run-scoped sandbox tokens). Forces the Clerk fall-through branch to
   * report unauthenticated so a stale session mock can never leak in.
   */
  function bearerAuth(authorization: string | undefined): AuthHeaders {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return authorization === undefined ? {} : { authorization };
  }

  function uploadsClient() {
    return chatFilesApp(context)(uploadsContract);
  }

  function hostClient() {
    return chatFilesApp(context)(hostContract);
  }

  return {
    async getDefaultCreateThreadModel(
      actor: ApiTestUser,
    ): Promise<SupportedRunModel> {
      return await defaultCreateThreadModel(actor);
    },

    mockCompletedUploadObject(
      actor: ApiTestUser,
      uploadId: string,
      filename: string,
      size: number,
    ): void {
      mockCompletedUploadObjects(actor, [{ id: uploadId, filename, size }]);
    },

    mockCompletedUploadObjects,

    // Allocating an artifact key lists the bucket first, so a prepare-only
    // test still has to answer that call.
    mockEmptyObjectStorage(): void {
      mocks.s3.listObjects([]);
    },

    mockObjectStorageObjectsExist(): void {
      mockObjectStorageObjectsExist(context);
    },

    async createAgentForChatThread(
      actor: ApiTestUser,
      displayName = `BDD chat ${randomUUID().slice(0, 8)}`,
    ): Promise<AgentResponse> {
      const response = await accept(
        chatFilesApp(context)(agentsMainContract).create({
          headers: authenticate(context, actor),
          body: { displayName, visibility: "private" },
        }),
        [201],
      );
      return response.body;
    },

    async createThread(
      actor: ApiTestUser,
      body: {
        readonly agentId: string;
        readonly title?: string;
        readonly clientThreadId?: string;
        readonly eventId?: string;
        readonly model?: SupportedRunModel;
      },
    ): Promise<{ readonly id: string; readonly title: string | null }> {
      const response = await accept(
        threadsClient().create({
          headers: authenticate(context, actor),
          body: {
            agentId: body.agentId,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.clientThreadId === undefined
              ? {}
              : { clientThreadId: body.clientThreadId }),
            ...(body.eventId === undefined ? {} : { eventId: body.eventId }),
            model: body.model ?? (await defaultCreateThreadModel(actor)),
          },
        }),
        [201],
      );
      return response.body;
    },

    async requestCreateThread(
      actor: ApiTestUser | null,
      body: {
        readonly agentId: string;
        readonly title?: string;
        readonly clientThreadId?: string;
        readonly eventId?: string;
        readonly model?: SupportedRunModel;
      },
      statuses: readonly (201 | 400 | 401 | 402 | 404)[],
    ) {
      return await accept(
        threadsClient().create({
          headers: authenticate(context, actor),
          body: {
            agentId: body.agentId,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.clientThreadId === undefined
              ? {}
              : { clientThreadId: body.clientThreadId }),
            ...(body.eventId === undefined ? {} : { eventId: body.eventId }),
            model: body.model ?? (await defaultCreateThreadModel(actor)),
          },
        }),
        statuses,
      );
    },

    async getThreadSnapshot(actor: ApiTestUser): Promise<{
      readonly chatThreads: readonly ChatThreadSnapshotProjection[];
      readonly latestEventId: string | null;
      readonly latestSeqId: number | null;
    }> {
      const response = await accept(
        threadsClient().snapshot({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      if (response.body.latestSeqId === undefined) {
        throw new Error("Expected snapshot sequence cursor");
      }
      return {
        ...response.body,
        latestSeqId: response.body.latestSeqId,
      };
    },

    async requestThreadEvents(
      actor: ApiTestUser,
      query: {
        readonly sinceSeqId?: number;
      },
      statuses: readonly (200 | 410)[],
    ) {
      return await accept(
        threadsClient().events({
          headers: authenticate(context, actor),
          query,
        }),
        statuses,
      );
    },

    async listThreadDrafts(actor: ApiTestUser): Promise<readonly string[]> {
      const response = await accept(
        threadsClient().drafts({
          headers: authenticate(context, actor),
          query: {},
        }),
        [200],
      );
      return response.body.draftThreadIds;
    },

    async listThreadUnreads(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<readonly { threadId: string; unreadAt: string }[]> {
      const response = await accept(
        threadsClient().unreads({
          headers: authenticate(context, actor),
          query: { agentId },
        }),
        [200],
      );
      return response.body.unreads;
    },

    async listActiveChatThreadIds(
      actor: ApiTestUser,
    ): Promise<readonly string[]> {
      const response = await accept(
        threadsClient().indicators({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return Object.entries(response.body.threads).flatMap(
        ([threadId, indicator]) => {
          return indicator === "active" ? [threadId] : [];
        },
      );
    },

    async listIndicators(actor: ApiTestUser): Promise<Indicators> {
      const response = await accept(
        threadsClient().indicators({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },

    async listUnreadChatThreadIds(
      actor: ApiTestUser,
    ): Promise<readonly string[]> {
      const response = await accept(
        threadsClient().indicators({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return Object.entries(response.body.threads).flatMap(
        ([threadId, indicator]) => {
          return indicator === "unread" ? [threadId] : [];
        },
      );
    },

    async requestIndicators(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401)[],
    ) {
      return await accept(
        threadsClient().indicators({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async listUnreadAgents(actor: ApiTestUser): Promise<readonly string[]> {
      const response = await accept(
        threadsClient().indicators({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return Object.entries(response.body.agents).flatMap(
        ([agentId, indicator]) => {
          return indicator === "unread" ? [agentId] : [];
        },
      );
    },

    async markAgentThreadsRead(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<void> {
      await accept(
        threadMarkAgentReadClient().markAgentRead({
          headers: authenticate(context, actor),
          body: { agentId },
        }),
        [204],
      );
    },

    async requestMarkAgentThreadsRead(
      actor: ApiTestUser | null,
      agentId: string,
      statuses: readonly (204 | 400 | 401 | 403)[],
    ) {
      return await accept(
        threadMarkAgentReadClient().markAgentRead({
          headers: authenticate(context, actor),
          body: { agentId },
        }),
        statuses,
      );
    },

    async readThread(
      actor: ApiTestUser,
      threadId: string,
    ): Promise<ChatThreadDetail> {
      const response = await accept(
        threadByIdClient().get({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [200],
      );
      return response.body;
    },

    async readThreadMetadata(
      actor: ApiTestUser,
      threadId: string,
    ): Promise<ChatThreadMetadata> {
      const response = await accept(
        threadMetadataClient().get({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadThread(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (200 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadByIdClient().get({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        statuses,
      );
    },

    async readThreadDraft(
      actor: ApiTestUser,
      threadId: string,
    ): Promise<ChatThreadDraft> {
      const response = await accept(
        threadDraftClient().get({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadThreadDraft(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (200 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadDraftClient().get({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        statuses,
      );
    },

    async patchThread(
      actor: ApiTestUser,
      threadId: string,
      body: {
        readonly draftUserMessage: UserMessageInputDocument | null;
        readonly draftAttachments?: readonly PersistedAttachment[] | null;
      },
    ): Promise<void> {
      const requestBody = {
        draftUserMessage: body.draftUserMessage,
        ...(body.draftAttachments === undefined
          ? {}
          : {
              draftAttachments: body.draftAttachments
                ? [...body.draftAttachments]
                : null,
            }),
      };

      await accept(
        threadByIdClient().patch({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: requestBody,
        }),
        [204],
      );
    },

    async requestPatchThread(
      actor: ApiTestUser | null,
      threadId: string,
      body: {
        readonly draftUserMessage: UserMessageInputDocument | null;
        readonly draftAttachments?: readonly PersistedAttachment[] | null;
      },
      statuses: readonly (204 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadByIdClient().patch({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: {
            draftUserMessage: body.draftUserMessage,
            ...(body.draftAttachments === undefined
              ? {}
              : {
                  draftAttachments: body.draftAttachments
                    ? [...body.draftAttachments]
                    : null,
                }),
          },
        }),
        statuses,
      );
    },

    async renameThread(
      actor: ApiTestUser,
      threadId: string,
      title: string,
      eventId?: string,
    ): Promise<void> {
      await accept(
        threadRenameClient().rename({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: { title, ...(eventId === undefined ? {} : { eventId }) },
        }),
        [204],
      );
    },

    async requestRenameThread(
      actor: ApiTestUser | null,
      threadId: string,
      title: string,
      statuses: readonly (204 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadRenameClient().rename({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: { title },
        }),
        statuses,
      );
    },

    async pinThread(actor: ApiTestUser, threadId: string): Promise<void> {
      await accept(
        threadPinClient().pin({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [204],
      );
    },

    async requestPinThread(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (204 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadPinClient().pin({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        statuses,
      );
    },

    async unpinThread(actor: ApiTestUser, threadId: string): Promise<void> {
      await accept(
        threadUnpinClient().unpin({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [204],
      );
    },

    async requestUnpinThread(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (204 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadUnpinClient().unpin({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        statuses,
      );
    },

    async markThreadRead(
      actor: ApiTestUser,
      threadId: string,
    ): Promise<{
      readonly lastReadAt: string | null;
      readonly unreads: readonly { threadId: string; unreadAt: string }[];
    }> {
      const response = await accept(
        threadMarkReadClient().markRead({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [200],
      );
      return response.body;
    },

    async requestMarkThreadRead(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (200 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadMarkReadClient().markRead({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        statuses,
      );
    },

    async markThreadUnread(
      actor: ApiTestUser,
      threadId: string,
    ): Promise<{
      readonly lastReadAt: string | null;
      readonly unreads: readonly { threadId: string; unreadAt: string }[];
    }> {
      const response = await accept(
        threadMarkUnreadClient().markUnread({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [200],
      );
      return response.body;
    },

    async requestMarkThreadUnread(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (200 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadMarkUnreadClient().markUnread({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        statuses,
      );
    },

    async updateThreadModelSelection(
      actor: ApiTestUser,
      threadId: string,
      model: SupportedRunModel | null,
      options?: {
        readonly codexServiceTier?: CodexServiceTier | null;
        readonly reasoningEffort?: ReasoningEffort;
        readonly eventId?: string;
      },
    ): Promise<void> {
      await accept(
        threadModelSelectionClient().update({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: {
            model,
            codexServiceTier: options?.codexServiceTier,
            reasoningEffort: options?.reasoningEffort,
            eventId: options?.eventId,
          },
        }),
        [204],
      );
    },

    async updateThreadImageModel(
      actor: ApiTestUser,
      threadId: string,
      imageModel: ImageModelId | null,
    ): Promise<void> {
      await accept(
        threadImageModelClient().update({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: { model: imageModel },
        }),
        [204],
      );
    },

    async updateThreadVideoModel(
      actor: ApiTestUser,
      threadId: string,
      videoModel: VideoModelId | null,
    ): Promise<void> {
      await accept(
        threadVideoModelClient().update({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: { model: videoModel },
        }),
        [204],
      );
    },

    async updateUserModelPreference(
      actor: ApiTestUser,
      selectedModel: SupportedRunModel | null,
      selectedImageModel?: ImageModelId | null,
      selectedVideoModel?: VideoModelId | null,
    ): Promise<void> {
      await accept(
        userModelPreferenceClient().update({
          headers: authenticate(context, actor),
          body: {
            selectedModel,
            serviceTier: null,
            ...(selectedImageModel === undefined ? {} : { selectedImageModel }),
            ...(selectedVideoModel === undefined ? {} : { selectedVideoModel }),
          },
        }),
        [200],
      );
    },

    async requestUpdateThreadModelSelection(
      actor: ApiTestUser | null,
      threadId: string,
      model: SupportedRunModel | null,
      statuses: readonly (204 | 400 | 401 | 402 | 404)[],
      options?: {
        readonly codexServiceTier?: CodexServiceTier | null;
        readonly reasoningEffort?: ReasoningEffort;
        readonly eventId?: string;
      },
    ) {
      return await accept(
        threadModelSelectionClient().update({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: {
            model,
            codexServiceTier: options?.codexServiceTier,
            reasoningEffort: options?.reasoningEffort,
            eventId: options?.eventId,
          },
        }),
        statuses,
      );
    },

    async updateThreadComputerUseHost(
      actor: ApiTestUser,
      threadId: string,
      computerUseHostId: string | null,
    ): Promise<void> {
      await accept(
        threadComputerUseHostClient().update({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: { computerUseHostId },
        }),
        [204],
      );
    },

    async requestUpdateThreadComputerUseHost(
      actor: ApiTestUser | null,
      threadId: string,
      computerUseHostId: string | null,
      statuses: readonly (204 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        threadComputerUseHostClient().update({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: { computerUseHostId },
        }),
        statuses,
      );
    },

    async deleteThread(actor: ApiTestUser, threadId: string): Promise<void> {
      await accept(
        threadByIdClient().delete({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [204],
      );
    },

    async requestDeleteThread(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (204 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadByIdClient().delete({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        statuses,
      );
    },

    async listThreadEvents(
      actor: ApiTestUser,
      threadId: string,
      query: {
        readonly limit?: number;
      } & (
        | { readonly sinceSeqId?: 0; readonly sinceEventId?: never }
        | { readonly sinceSeqId: number; readonly sinceEventId: string }
      ) = {},
    ): Promise<{ readonly events: readonly ChatEvent[] }> {
      return {
        events: await readProjectedChatEvents(context, {
          threadId,
          headers: authenticate(context, actor),
          ...query,
        }),
      };
    },

    async requestListThreadEvents(
      actor: ApiTestUser | null,
      threadId: string,
      query: {
        readonly limit?: number;
      } & (
        | { readonly sinceSeqId?: 0; readonly sinceEventId?: never }
        | { readonly sinceSeqId: number; readonly sinceEventId: string }
      ),
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 410)[],
    ) {
      const response = await accept(
        threadEventsClient().rows({
          headers: authenticateChatEvent(context, actor),
          params: { threadId },
          query:
            query.sinceEventId === undefined
              ? {
                  sinceSeqId: 0,
                  ...(query.limit === undefined ? {} : { limit: query.limit }),
                }
              : {
                  sinceSeqId: query.sinceSeqId,
                  sinceEventId: query.sinceEventId,
                  ...(query.limit === undefined ? {} : { limit: query.limit }),
                },
        }),
        statuses,
      );
      if (response.status !== 200) {
        return response;
      }
      return {
        ...response,
        body: { events: projectChatEventRows(response.body.rows) },
      };
    },

    async listThreadEventRows(
      actor: ApiTestUser,
      threadId: string,
      cursor: ChatEventCursor = { lastEventId: null, lastSeqId: 0 },
    ) {
      const response = await accept(
        threadEventsClient().rows({
          headers: authenticateChatEvent(context, actor),
          params: { threadId },
          query:
            cursor.lastEventId === null
              ? { sinceSeqId: 0 }
              : {
                  sinceSeqId: cursor.lastSeqId,
                  sinceEventId: cursor.lastEventId,
                },
        }),
        [200],
      );
      return response.body.rows;
    },

    async listThreadArtifacts(
      actor: ApiTestUser,
      threadId: string,
    ): Promise<{ readonly runs: readonly ChatThreadArtifactRun[] }> {
      const response = await accept(
        threadArtifactsClient().list({
          headers: authenticate(context, actor),
          params: { threadId },
        }),
        [200],
      );
      return response.body;
    },

    async requestListThreadArtifacts(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        threadArtifactsClient().list({
          headers: authenticate(context, actor),
          params: { threadId },
        }),
        statuses,
      );
    },

    async listArtifactCatalog(
      actor: ApiTestUser,
      query: {
        readonly limit?: number;
        readonly cursor?: string;
        readonly kind?: ArtifactCatalogKind;
        readonly chatThreadId?: string;
        readonly keyword?: string;
      } = {},
    ): Promise<{
      readonly artifacts: readonly ArtifactSummary[];
      readonly nextCursor: string | null;
    }> {
      const response = await accept(
        artifactCatalogClient().list({
          headers: authenticate(context, actor),
          query,
        }),
        [200],
      );
      return response.body;
    },

    async getArtifactCatalogEntry(
      actor: ApiTestUser,
      artifactId: string,
    ): Promise<ArtifactDetail> {
      const response = await accept(
        artifactCatalogClient().get({
          headers: authenticate(context, actor),
          params: { artifactId },
        }),
        [200],
      );
      return response.body;
    },

    async requestArtifactCatalogEntry(
      actor: ApiTestUser | null,
      artifactId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        artifactCatalogClient().get({
          headers: authenticate(context, actor),
          params: { artifactId },
        }),
        statuses,
      );
    },
    async searchChat(
      actor: ApiTestUser,
      keyword: string,
      query: {
        readonly agentId?: string;
        readonly since?: number;
      } = {},
    ): Promise<ChatSearchResponse> {
      const response = await accept(
        chatSearchClient().search({
          headers: authenticate(context, actor),
          query: { keyword, ...query },
        }),
        [200],
      );
      return response.body;
    },

    async requestSearchChat(
      actor: ApiTestUser | null,
      keyword: string,
      query: {
        readonly agentId?: string;
        readonly since?: number;
        // Previous clients still send this retired parameter during rollout.
        readonly limit?: number;
      },
      statuses: readonly (200 | 400 | 401 | 403)[],
    ) {
      return await accept(
        chatSearchClient().search({
          headers: authenticate(context, actor),
          query: { keyword, ...query },
        }),
        statuses,
      );
    },

    async searchChatWithBearer(
      authorization: string,
      keyword: string,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        chatSearchClient().search({
          headers: bearerAuth(authorization),
          query: { keyword },
        }),
        statuses,
      );
    },

    async requestSyncThreadArtifact(
      actor: ApiTestUser | null,
      threadId: string,
      body: { readonly runId: string; readonly fileId: string },
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        threadArtifactsClient().syncGoogleDrive({
          headers: authenticate(context, actor),
          params: { threadId },
          body,
        }),
        statuses,
      );
    },

    async requestSyncThreadArtifactUnchecked(
      actor: ApiTestUser,
      threadId: string,
      body: unknown,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        threadArtifactsClient().syncGoogleDrive({
          headers: authenticate(context, actor),
          params: { threadId },
          body: body as { runId: string; fileId: string },
        }),
        statuses,
      );
    },

    async requestSendEvent(
      actor: ApiTestUser | null,
      body: BddSendEventBody,
      statuses: readonly (
        | 201
        | 400
        | 401
        | 402
        | 403
        | 404
        | 409
        | 422
        | 429
        | 503
      )[],
      options: RequestSendEventOptions = {},
      signal?: AbortSignal,
    ) {
      const client = setupAppWithRoutes({
        context,
        routes: chatFilesRoutes,
        ...(signal === undefined ? {} : { signal }),
        ...(options.usagePricingResolution === undefined
          ? {}
          : { usagePricingResolution: options.usagePricingResolution }),
      })(chatEventsContract);
      const defaultModel =
        "prompt" in body &&
        body.threadId === undefined &&
        body.model === undefined
          ? await defaultCreateThreadModel(actor)
          : undefined;
      const requestBody =
        "prompt" in body
          ? (() => {
              const selectedModel = body.model ?? defaultModel;
              return {
                agentId: body.agentId,
                prompt: body.prompt,
                ...(body.threadId === undefined
                  ? {}
                  : { threadId: body.threadId }),
                ...(body.clientThreadId === undefined
                  ? {}
                  : { clientThreadId: body.clientThreadId }),
                ...(selectedModel === undefined
                  ? {}
                  : { model: selectedModel }),
                ...(body.runOptions === undefined
                  ? {}
                  : { runOptions: body.runOptions }),
                userMessage:
                  body.userMessage ??
                  ({
                    version: 1,
                    parts: [{ type: "text", text: body.prompt }],
                  } satisfies UserMessageInputDocument),
                hasTextContent:
                  body.hasTextContent ?? body.prompt.trim().length > 0,
                // Explicit null clears the thread's sticky computer-use host;
                // omitting the field keeps it, so the two must stay distinct.
                ...(body.computerUseHostId === undefined
                  ? {}
                  : { computerUseHostId: body.computerUseHostId }),
                ...(body.cloudBrowserEnabled === undefined
                  ? {}
                  : { cloudBrowserEnabled: body.cloudBrowserEnabled }),
                ...(body.clientEventId === undefined
                  ? {}
                  : { clientEventId: body.clientEventId }),
                ...(body.chatThreadSortEventId === undefined
                  ? {}
                  : { chatThreadSortEventId: body.chatThreadSortEventId }),
                ...(body.realAgentInPreview === undefined
                  ? {}
                  : { realAgentInPreview: body.realAgentInPreview }),
                ...(body.captureNetworkBodies === undefined
                  ? {}
                  : { captureNetworkBodies: body.captureNetworkBodies }),
                ...(body.revokesEventId === undefined
                  ? {}
                  : { revokesEventId: body.revokesEventId }),
                ...(body.sourceRunId === undefined
                  ? {}
                  : { sourceRunId: body.sourceRunId }),
              };
            })()
          : "interruptsRunId" in body
            ? {
                agentId: body.agentId,
                threadId: body.threadId,
                interruptsRunId: body.interruptsRunId,
                ...(body.clientEventId === undefined
                  ? {}
                  : { clientEventId: body.clientEventId }),
              }
            : {
                agentId: body.agentId,
                threadId: body.threadId,
                revokesEventId: body.revokesEventId,
                ...(body.clientEventId === undefined
                  ? {}
                  : { clientEventId: body.clientEventId }),
              };

      return await accept(
        client.send({
          headers: authenticate(context, actor),
          body: requestBody,
        }),
        statuses,
      );
    },

    async prepareUpload(
      actor: ApiTestUser,
      body: {
        readonly filename: string;
        readonly contentType: string;
        readonly size: number;
      },
    ): Promise<UploadPrepareResponse> {
      const response = await accept(
        uploadsClient().prepare({
          headers: authenticate(context, actor),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestPrepareUpload(
      actor: ApiTestUser | null,
      body: {
        readonly filename: string;
        readonly contentType: string;
        readonly size: number;
      },
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 500)[],
    ) {
      return await accept(
        uploadsClient().prepare({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async completeUpload(
      actor: ApiTestUser,
      body: { readonly id: string; readonly contentType?: string },
    ): Promise<UploadCompleteResponse> {
      const response = await accept(
        uploadsClient().complete({
          headers: authenticate(context, actor),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestCompleteUpload(
      actor: ApiTestUser | null,
      body: { readonly id: string; readonly contentType?: string },
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 404 | 500)[],
    ) {
      return await accept(
        uploadsClient().complete({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    /** Upload complete with a run-scoped bearer so the file records its run. */
    async completeUploadWithBearer(
      authorization: string,
      body: { readonly id: string; readonly contentType?: string },
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 404 | 500)[],
    ) {
      return await accept(
        uploadsClient().complete({
          headers: bearerAuth(authorization),
          body,
        }),
        statuses,
      );
    },

    async prepareHostedSite(
      actor: ApiTestUser,
      body: HostedSitePrepareRequest,
    ): Promise<HostedSitePrepareResponse> {
      const response = await accept(
        hostClient().prepare({
          headers: authenticate(context, actor),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestPrepareHostedSite(
      actor: ApiTestUser | null,
      body: HostedSitePrepareRequest,
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 409 | 500)[],
    ) {
      return await accept(
        hostClient().prepare({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async completeHostedSite(
      actor: ApiTestUser,
      deploymentId: string,
    ): Promise<HostedSiteCompleteResponse> {
      const response = await accept(
        hostClient().complete({
          headers: authenticate(context, actor),
          params: { deploymentId },
          body: {},
        }),
        [200],
      );
      return response.body;
    },

    async requestCompleteHostedSite(
      actor: ApiTestUser | null,
      deploymentId: string,
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 404 | 409 | 500)[],
    ) {
      return await accept(
        hostClient().complete({
          headers: authenticate(context, actor),
          params: { deploymentId },
          body: {},
        }),
        statuses,
      );
    },

    /** Hosted-site prepare with a run-scoped bearer (deployment records the run). */
    async prepareHostedSiteWithBearer(
      authorization: string,
      body: HostedSitePrepareRequest,
    ): Promise<HostedSitePrepareResponse> {
      const response = await accept(
        hostClient().prepare({
          headers: bearerAuth(authorization),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestPrepareHostedSiteWithBearer(
      authorization: string,
      body: HostedSitePrepareRequest,
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 409 | 500)[],
    ) {
      return await accept(
        hostClient().prepare({
          headers: bearerAuth(authorization),
          body,
        }),
        statuses,
      );
    },

    async completeHostedSiteWithBearer(
      authorization: string,
      deploymentId: string,
    ): Promise<HostedSiteCompleteResponse> {
      const response = await accept(
        hostClient().complete({
          headers: bearerAuth(authorization),
          params: { deploymentId },
          body: {},
        }),
        [200],
      );
      return response.body;
    },

    async requestCompleteHostedSiteWithBearer(
      authorization: string,
      deploymentId: string,
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 404 | 409 | 500)[],
    ) {
      return await accept(
        hostClient().complete({
          headers: bearerAuth(authorization),
          params: { deploymentId },
          body: {},
        }),
        statuses,
      );
    },

    async readHostedSiteDeploymentsWithBearer(
      authorization: string,
      site: string,
    ): Promise<HostedSiteDeploymentsResponse> {
      const response = await accept(
        hostClient().deployments({
          headers: bearerAuth(authorization),
          params: { site },
        }),
        [200],
      );
      return response.body;
    },

    expectApiError(body: unknown): asserts body is ApiErrorResponse {
      if (
        typeof body !== "object" ||
        body === null ||
        !("error" in body) ||
        typeof body.error !== "object" ||
        body.error === null
      ) {
        throw new Error("Expected API error response body");
      }
    },
  };
}
