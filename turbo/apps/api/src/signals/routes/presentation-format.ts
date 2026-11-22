import { command } from "ccstate";
import { presentationFormatContract } from "@okouai/api-contracts/contracts/presentation-format";
import {
  PRESENTATION_OUTPUT_FORMATS,
  type PresentationOutputFormat,
} from "@okouai/core/presentation-output-format";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import { now } from "../../lib/time";
import { notFound, resourceUnavailable } from "../../lib/error";
import { settle } from "../utils";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import {
  presentationSourceDocuments,
  readPresentationFormatReceipt$,
  readPresentationFormatSource$,
  recordedPresentationFormat,
  type PresentationFormatSource,
} from "../services/presentation-format.service";
import { reconstructPresentationTask } from "../services/presentation-format-source";
import {
  presentationFormatContinuationEventId,
  PresentationFormatPublicationConflict,
} from "../services/presentation-format-policy";
import { CHAT_EVENT_RETENTION_DAYS } from "../services/chat-event-retention-policy";
import { sendNormalEvent$ } from "../services/chat-events.command";
import { projectUserMessage } from "../services/chat-user-message.service";
import { pickEnqueuedChatThread$ } from "../services/chat-thread-queue-drain.service";

function selectionConflict(
  message: string,
  presentationFormat: PresentationOutputFormat | null = null,
) {
  return {
    status: 409 as const,
    body: { error: { code: "CONFLICT", message }, presentationFormat },
  };
}
const sourceMissing = () => {
  return notFound("Presentation source Run not found");
};

const resolveBody$ = bodyResultOf(presentationFormatContract.resolve);
const resolve$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const auth = get(organizationAuthContext$);
  const body = await get(resolveBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (auth.tokenType !== "agent") {
    return sourceMissing();
  }
  const context = await set(
    loadUserFeatureSwitchContext$,
    auth.orgId,
    auth.userId,
    signal,
  );
  if (!isFeatureEnabled(FeatureSwitchKey.PresentationOutputFormat, context)) {
    return resourceUnavailable("Presentation format selection is disabled");
  }
  const source = await set(
    readPresentationFormatSource$,
    { ...auth, sourceRunId: auth.runId },
    signal,
  );
  if (!source) {
    return sourceMissing();
  }
  if (!source.inputsComplete) {
    return selectionConflict(
      "The original consumed inputs are unavailable or have unsupported source contexts",
    );
  }
  const recorded = recordedPresentationFormat(source);
  if (recorded.kind === "conflict") {
    return selectionConflict(
      "The consumed inputs contain conflicting presentation choices",
    );
  }
  const available = recorded.presentationFormat ?? source.presentationFormat;
  if (available !== null) {
    return {
      status: 200 as const,
      body: {
        status: "ready" as const,
        presentationFormat: body.data.requestedFormat ?? available,
      },
    };
  }
  const identity = {
    sourceRunId: source.runId,
    threadId: source.threadId,
    continuationEventId: presentationFormatContinuationEventId(source.runId),
    requestedFormat: body.data.requestedFormat ?? null,
  };
  return {
    status: 200 as const,
    body: {
      status: "selection_required" as const,
      ...identity,
      card: {
        type: "presentation_format_selection" as const,
        ...identity,
        formats: [...PRESENTATION_OUTPUT_FORMATS],
        action: {
          method: "POST" as const,
          path: "/api/presentation-format/confirm" as const,
        },
      },
    },
  };
});

interface ConfirmationSelection {
  readonly orgId: string;
  readonly userId: string;
  readonly sourceRunId: string;
  readonly presentationFormat: PresentationOutputFormat;
}

const readConfirmationResponse$ = command(
  async (
    { set },
    selection: ConfirmationSelection,
    recoverPending: boolean,
    signal: AbortSignal,
  ) => {
    const existing = await set(
      readPresentationFormatReceipt$,
      selection,
      signal,
    );
    if (existing.kind === "conflict") {
      return selectionConflict("The continuation identity is already in use");
    }
    if (existing.kind !== "accepted") {
      return null;
    }
    if (existing.receipt.presentationFormat !== selection.presentationFormat) {
      return selectionConflict(
        "A different presentation format was already accepted",
        existing.receipt.presentationFormat,
      );
    }
    if (existing.pending && recoverPending) {
      waitUntil(
        set(
          pickEnqueuedChatThread$,
          { orgId: selection.orgId, chatThreadId: existing.receipt.threadId },
          signal,
        ),
      );
    }
    return { status: 200 as const, body: existing.receipt };
  },
);

const preflightConfirmation$ = command(
  async ({ set }, selection: ConfirmationSelection, signal: AbortSignal) => {
    const source = await set(readPresentationFormatSource$, selection, signal);
    if (!source) {
      return { ok: false as const, response: sourceMissing() };
    }
    const context = await set(
      loadUserFeatureSwitchContext$,
      selection.orgId,
      selection.userId,
      signal,
    );
    if (!isFeatureEnabled(FeatureSwitchKey.PresentationOutputFormat, context)) {
      return {
        ok: false as const,
        response: resourceUnavailable(
          "Presentation format selection is disabled",
        ),
      };
    }
    if (
      now() - source.createdAt.getTime() >=
      CHAT_EVENT_RETENTION_DAYS * 86_400_000
    ) {
      return {
        ok: false as const,
        response: {
          status: 410 as const,
          body: {
            error: {
              code: "GONE",
              message:
                "The source Run is outside the chat input retention window",
            },
          },
        },
      };
    }
    const sourceBusy =
      !["completed", "failed", "timeout"].includes(source.status) ||
      source.runnerCancellationMode !== null ||
      source.activeRunId !== null;
    const preferenceChanged =
      source.presentationFormat !== null &&
      source.presentationFormat !== selection.presentationFormat;
    if (sourceBusy || preferenceChanged) {
      // A competing click may have committed after the initial receipt read.
      const raced = await set(
        readConfirmationResponse$,
        selection,
        false,
        signal,
      );
      return {
        ok: false as const,
        response:
          raced ??
          selectionConflict(
            sourceBusy
              ? "Wait until the source Run and the thread's active Run have ended"
              : "The current presentation default changed. Review it before continuing",
            source.presentationFormat,
          ),
      };
    }
    const documents = presentationSourceDocuments(source);
    if (!documents) {
      return {
        ok: false as const,
        response: selectionConflict(
          "The original presentation inputs are no longer available",
          source.presentationFormat,
        ),
      };
    }
    const assembled = reconstructPresentationTask(
      documents,
      selection.presentationFormat,
    );
    if (!assembled.ok) {
      return {
        ok: false as const,
        response: selectionConflict(
          assembled.message,
          source.presentationFormat,
        ),
      };
    }
    return { ok: true as const, source, userMessage: assembled.userMessage };
  },
);

const submitConfirmation$ = command(
  async (
    { get, set },
    selection: ConfirmationSelection,
    source: PresentationFormatSource,
    userMessage: UserMessageDocument,
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    const continuationEventId = presentationFormatContinuationEventId(
      source.runId,
    );
    const sent = await settle(
      set(
        sendNormalEvent$,
        {
          auth,
          orgId: auth.orgId,
          userId: auth.userId,
          presentationFormatSelection: {
            type: "presentation_format_selection",
            sourceRunId: source.runId,
            sourceInputEventIds: source.inputs.map((input) => {
              return input.id;
            }),
            presentationFormat: selection.presentationFormat,
          },
          body: {
            threadId: source.threadId,
            clientEventId: continuationEventId,
            chatThreadSortEventId: continuationEventId,
            prompt: projectUserMessage(userMessage).agentPrompt,
            userMessage,
            hasTextContent: true,
          },
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    // Publication may have committed even when its response or later scheduling failed.
    // Recover from the authoritative event, never issue a second identity or rewrite preferences.
    const receipt = await set(
      readConfirmationResponse$,
      selection,
      !sent.ok || (sent.value.status === 201 && Boolean(sent.value.replayed)),
      signal,
    );
    if (receipt) {
      return receipt;
    }
    if (!sent.ok) {
      if (!(sent.error instanceof PresentationFormatPublicationConflict)) {
        throw sent.error;
      }
      const current = await set(
        readPresentationFormatSource$,
        selection,
        signal,
      );
      return selectionConflict(
        "The source or presentation default changed before acceptance",
        current?.presentationFormat ?? null,
      );
    }
    if (sent.value.status === 409) {
      const current = await set(
        readPresentationFormatSource$,
        selection,
        signal,
      );
      return selectionConflict(
        sent.value.body.error.message,
        current?.presentationFormat ?? null,
      );
    }
    if (sent.value.status !== 201) {
      return sent.value;
    }
    throw new Error(
      "Accepted presentation continuation has no authoritative receipt",
    );
  },
);

const confirmBody$ = bodyResultOf(presentationFormatContract.confirm);
const confirm$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const auth = get(organizationAuthContext$);
  const body = await get(confirmBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (auth.tokenType !== "session") {
    return sourceMissing();
  }
  const selection = {
    orgId: auth.orgId,
    userId: auth.userId,
    sourceRunId: body.data.sourceRunId,
    presentationFormat: body.data.presentationFormat,
  };
  const existing = await set(
    readConfirmationResponse$,
    selection,
    true,
    signal,
  );
  if (existing) {
    return existing;
  }
  const preflight = await set(preflightConfirmation$, selection, signal);
  if (!preflight.ok) {
    return preflight.response;
  }
  return await set(
    submitConfirmation$,
    selection,
    preflight.source,
    preflight.userMessage,
    signal,
  );
});

export const presentationFormatRoutes: readonly RouteEntry[] = [
  {
    route: presentationFormatContract.resolve,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        accept: ["agent"],
        requiredCapability: "presentation-format:read",
      },
      resolve$,
    ),
  },
  {
    route: presentationFormatContract.confirm,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        accept: ["session"],
      },
      confirm$,
    ),
  },
];
