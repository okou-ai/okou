import { chatThreadPdfFilenameContract } from "@okouai/api-contracts/contracts/chat-thread-pdf-filename";
import { command } from "ccstate";

import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { generateChatThreadPdfFilename$ } from "../services/chat-thread-pdf-filename.service";

const generate$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const body = await get(bodyResultOf(chatThreadPdfFilenameContract.generate));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    generateChatThreadPdfFilename$,
    {
      ...get(organizationAuthContext$),
      ...get(pathParamsOf(chatThreadPdfFilenameContract.generate)),
      ...body.data,
    },
    signal,
  );
  if (result.kind === "not-found") {
    return notFound("Chat thread not found");
  }
  if (result.kind === "invalid-selection") {
    return badRequestMessage("Select visible messages from this chat thread");
  }
  return { status: 200 as const, body: result.filename };
});

export const chatThreadPdfFilenameRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadPdfFilenameContract.generate,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      generate$,
    ),
  },
];
