import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
/** Canonical ChatEvent route adapter. */
import { command } from "ccstate";
import {
  chatEventsContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-event-send";

import { authRoute } from "../auth/auth-route";
import { organizationAuthContext$ } from "../auth/auth-context";
import {
  resourceUnavailable,
  badRequestMessage,
  notFound,
} from "../../lib/error";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { measureChatEnqueue } from "../services/chat-enqueue-timing.service";
import {
  handleSendChatEvent$,
  chatEnqueueTiming$,
  startNormalSendBootstrap$,
} from "../services/chat-events.command";
import { captureProjectReferences } from "../services/project-reference.service";
import {
  hasEmptySuggestionNote,
  suggestionFeedbacks,
} from "@okouai/api-contracts/contracts/suggestion-context";
import {
  validateSuggestionFollowup$,
  recordAcceptedSuggestionFollowup$,
  suggestionAccess$,
} from "../services/agent-suggestions.service";

const sendEventBody$ = bodyResultOf(chatEventsContract.send);

export const sendValidatedChatEvent$ = command(
  async (
    { get, set },
    {
      data,
      projectId,
      requireVisibleThread,
    }: {
      readonly data: ChatEventSendBody;
      readonly projectId?: string;
      readonly requireVisibleThread?: boolean;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    const scope =
      typeof data.prompt === "string" ? "okou:chat:send" : "okou:run:cancel";
    if (auth.tokenType === "oauth" && !auth.scopes.includes(scope)) {
      return resourceUnavailable("Insufficient scope");
    }
    const timing = get(chatEnqueueTiming$);
    const referenceRead = measureChatEnqueue(timing, "references", () => {
      return get(captureProjectReferences(auth, data.userMessage, projectId));
    });
    const bootstrap = set(startNormalSendBootstrap$, {
      body: data,
      auth,
      requireVisibleThread,
    });
    const projectReferences = await referenceRead;
    signal.throwIfAborted();
    if (projectReferences === null) {
      return notFound(
        projectId ? "Project not found" : "Project or conversation not found",
      );
    }
    const candidate =
      auth.tokenType === "session" &&
      data.userMessage &&
      suggestionFeedbacks(data.userMessage).length > 0;
    const access = candidate
      ? await measureChatEnqueue(timing, "suggestion_access", async () => {
          const flags = bootstrap
            ? await get(bootstrap.context.featureSwitches$)
            : undefined;
          return set(suggestionAccess$, signal, flags?.overrides);
        })
      : null;
    const custom = access !== null && !("status" in access);
    let acceptedDocument: UserMessageDocument | undefined;
    if (custom && data.userMessage) {
      if (
        !data.threadId ||
        !data.clientEventId ||
        hasEmptySuggestionNote(data.userMessage)
      ) {
        return badRequestMessage(
          "Add your question or direction before sending this suggestion.",
        );
      }
      const threadId = data.threadId;
      const eventId = data.clientEventId;
      const document = data.userMessage;
      const invalid = await measureChatEnqueue(
        timing,
        "suggestion_validation",
        () => {
          return set(
            validateSuggestionFollowup$,
            auth,
            { threadId, eventId, document },
            signal,
          );
        },
      );
      signal.throwIfAborted();
      if (invalid && "status" in invalid) {
        return invalid;
      }
      acceptedDocument = invalid?.acceptedDocument;
    }
    const result = await set(
      handleSendChatEvent$,
      {
        body: data,
        projectId,
        projectReferences,
        bootstrap,
        onAcceptedDocument: custom
          ? (document) => {
              acceptedDocument = document;
            }
          : undefined,
      },
      signal,
    );
    if (custom && result.status === 201 && data.clientEventId) {
      await set(
        recordAcceptedSuggestionFollowup$,
        auth,
        result.body.threadId,
        data.clientEventId,
        signal,
        acceptedDocument,
      );
    }
    return result;
  },
);

const sendChatEventInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const timing = get(chatEnqueueTiming$);
    timing?.recordAuth(true);
    const body = await measureChatEnqueue(timing, "body", () => {
      return get(sendEventBody$);
    });
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    timing?.setKind(
      typeof body.data.prompt === "string"
        ? "normal"
        : "interruptsRunId" in body.data
          ? "interrupt"
          : "recall",
    );
    timing?.setSendContext(
      get(organizationAuthContext$).tokenType,
      body.data.threadId !== undefined,
    );
    return await set(sendValidatedChatEvent$, { data: body.data }, signal);
  },
);

const authenticatedSendChatEvent$ = authRoute(
  {
    requireOrganization: true,
    missingOrganizationStatus: 401,
    requiredCapability: "chat-event:write",
    oauthScope: ["okou:chat:send", "okou:run:cancel"],
  },
  sendChatEventInner$,
);

const observedSendChatEvent$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const timing = get(chatEnqueueTiming$);
    if (!timing) {
      throw new Error(
        "Chat enqueue observer requires the canonical send route",
      );
    }
    return await timing.observeResponse(async () => {
      return await set(authenticatedSendChatEvent$, signal);
    }, signal);
  },
);

export const chatEventsRoutes: readonly RouteEntry[] = [
  {
    route: chatEventsContract.send,
    handler: observedSendChatEvent$,
  },
];
