import { command } from "ccstate";
import { mailContract } from "@okouai/api-contracts/contracts/mail";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  deleteMailDraft$,
  getMailDraftAttachment$,
  getMailDraft$,
  linkMailDraft$,
  sendMailDraft$,
  type MailDraftLinkMutationResult,
  type MailDraftMutationResult,
} from "../services/mail-draft.service";

function mailDraftUrl(mailDraftId: string): string {
  return `${env("APP_URL")}/mail/drafts/${mailDraftId}`;
}

function mutationResponse(result: MailDraftMutationResult) {
  switch (result.kind) {
    case "ok": {
      return {
        status: 200 as const,
        body: {
          mailDraftId: result.mailDraftId,
          mailDraftUrl: mailDraftUrl(result.mailDraftId),
          mailDraft: result.mailDraft,
        },
      };
    }
    case "not_found": {
      return notFound(result.message);
    }
    case "conflict": {
      return conflict(result.message);
    }
  }
}

function linkMutationResponse(result: MailDraftLinkMutationResult) {
  switch (result.kind) {
    case "ok": {
      return {
        status: 200 as const,
        body: {
          mailDraftId: result.mailDraftId,
          mailDraftUrl: mailDraftUrl(result.mailDraftId),
        },
      };
    }
    case "not_found": {
      return notFound(result.message);
    }
    case "conflict": {
      return conflict(result.message);
    }
  }
}

const linkDraftBody$ = bodyResultOf(mailContract.linkDraft);
const linkDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(linkDraftBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const result = await set(
    linkMailDraft$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      ...bodyResult.data,
    },
    signal,
  );
  return linkMutationResponse(result);
});

const getDraftParams$ = pathParamsOf(mailContract.getDraft);
const getDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  return mutationResponse(
    await set(
      getMailDraft$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        ...get(getDraftParams$),
      },
      signal,
    ),
  );
});

const getAttachmentParams$ = pathParamsOf(mailContract.getAttachment);

function attachmentResponseContentType(contentType: string): string {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (
    mediaType?.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType?.endsWith("+json")
  ) {
    return "application/octet-stream";
  }
  return contentType;
}

const getAttachmentInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const result = await set(
      getMailDraftAttachment$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        ...get(getAttachmentParams$),
      },
      signal,
    );
    switch (result.kind) {
      case "not_found": {
        return notFound(result.message);
      }
      case "conflict": {
        return conflict(result.message);
      }
      case "ok": {
        const headers = new Headers();
        headers.set(
          "Content-Type",
          attachmentResponseContentType(result.contentType),
        );
        headers.set("Content-Length", String(result.content.byteLength));
        headers.set("Cache-Control", "private, max-age=300");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        );
        const body = new Uint8Array(result.content.byteLength);
        body.set(result.content);
        return new Response(body, { status: 200, headers });
      }
    }
  },
);

const deleteDraftParams$ = pathParamsOf(mailContract.deleteDraft);
const deleteDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const result = await set(
    deleteMailDraft$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      ...get(deleteDraftParams$),
    },
    signal,
  );
  if (result.kind !== "ok") {
    return mutationResponse(result);
  }
  return { status: 204 as const, body: undefined };
});

const sendDraftParams$ = pathParamsOf(mailContract.sendDraft);
const sendDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const result = await set(
    sendMailDraft$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      ...get(sendDraftParams$),
    },
    signal,
  );
  return result.kind === "rejected"
    ? badRequestMessage(result.message)
    : mutationResponse(result);
});

const mailDraftLinkAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401 as const,
  requiredCapability: "connector:read" as const,
  accept: Object.freeze(["session", "agent"] as const),
});

const mailDraftHumanAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401 as const,
  requiredCapability: "connector:read" as const,
  accept: Object.freeze(["session"] as const),
});

export const mailRoutes: readonly RouteEntry[] = [
  {
    route: mailContract.linkDraft,
    handler: authRoute(mailDraftLinkAuth, linkDraftInner$),
  },
  {
    route: mailContract.getDraft,
    handler: authRoute(mailDraftHumanAuth, getDraftInner$),
  },
  {
    route: mailContract.getAttachment,
    handler: authRoute(mailDraftHumanAuth, getAttachmentInner$),
  },
  {
    route: mailContract.deleteDraft,
    handler: authRoute(mailDraftHumanAuth, deleteDraftInner$),
  },
  {
    route: mailContract.sendDraft,
    handler: authRoute(mailDraftHumanAuth, sendDraftInner$),
  },
];
