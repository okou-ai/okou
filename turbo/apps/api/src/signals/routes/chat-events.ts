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

const prepareSuggestionSend$ = command(
  async (
    { get, set },
    {
      data,
      bootstrap,
    }: {
      readonly data: ChatEventSendBody;
      readonly bootstrap: ReturnType<
        (typeof startNormalSendBootstrap$)["write"]
      >;
    },
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    const document = data.userMessage;
    if (
      auth.tokenType !== "session" ||
      !document ||
      !suggestionFeedbacks(document).length
    ) {
      return null;
    }
    const timing = get(chatEnqueueTiming$);
    const access = await measureChatEnqueue(
      timing,
      "suggestion_access",
      async () => {
        const flags = bootstrap
          ? await get(bootstrap.context.featureSwitches$)
          : undefined;
        signal.throwIfAborted();
        return set(suggestionAccess$, signal, flags?.overrides);
      },
    );
    signal.throwIfAborted();
    if ("status" in access) {
      return null;
    }
    const { threadId, clientEventId: eventId } = data;
    if (!threadId || !eventId || hasEmptySuggestionNote(document)) {
      return badRequestMessage(
        "Add your question or direction before sending this suggestion.",
      );
    }
    const result = await measureChatEnqueue(
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
    return result && "status" in result
      ? result
      : { eventId, acceptedDocument: result?.acceptedDocument };
  },
);

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
    const suggestion = await set(
      prepareSuggestionSend$,
      { data, bootstrap },
      signal,
    );
    signal.throwIfAborted();
    if (suggestion && "status" in suggestion) {
      return suggestion;
    }
    let acceptedDocument = suggestion?.acceptedDocument;
    const result = await set(
      handleSendChatEvent$,
      {
        body: data,
        projectId,
        projectReferences,
        bootstrap,
        onAcceptedDocument: suggestion
          ? (document) => {
              acceptedDocument = document;
            }
          : undefined,
      },
      signal,
    );
    if (suggestion && result.status === 201) {
      await set(
        recordAcceptedSuggestionFollowup$,
        auth,
        {
          threadId: result.body.threadId,
          eventId: suggestion.eventId,
          acceptedDocument,
        },
        signal,
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
