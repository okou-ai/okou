import { command } from "ccstate";
import { chatThreadModelSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { updateChatThreadMetadata } from "../services/chat-thread-metadata-update.service";
import type { RouteEntry } from "../route-entry";

const modelSelectionBody$ = bodyResultOf(
  chatThreadModelSelectionContract.update,
);

const updateModelSelectionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(chatThreadModelSelectionContract.update));
    const body = await get(modelSelectionBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const preserveTier =
      body.data.codexServiceTier === undefined &&
      body.data.reasoningEffort !== undefined;
    const result = await updateChatThreadMetadata(
      set(writeDb$),
      {
        principal: auth,
        threadId: params.id,
        patch: {
          model: body.data.model,
          ...(body.data.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: body.data.reasoningEffort }),
        },
        codexServiceTier: preserveTier
          ? { kind: "preserve" }
          : { kind: "set", value: body.data.codexServiceTier ?? null },
        emitServiceTierEvent: true,
        eventIds: {
          ...(body.data.eventId === undefined
            ? {}
            : { model: body.data.eventId }),
          ...(body.data.serviceTierEventId === undefined
            ? {}
            : { serviceTier: body.data.serviceTierEventId }),
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.kind === "response") {
      return result.response;
    }
    if (result.kind !== "ok") {
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
