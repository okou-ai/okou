import { command } from "ccstate";
import {
  integrationsEmailUploadContract,
  MAX_EMAIL_ATTACHMENT_SIZE_BYTES,
} from "@okouai/api-contracts/contracts/integrations-email";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  badRequestMessage,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import { now } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { drainEmailOutboxBatch$ } from "../services/email-common.service";
import {
  emailFileDestination$,
  enqueueEmailFile$,
} from "../services/email-file-delivery.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import {
  uploadedArtifactObject$,
  uploadedArtifactFetchUrl$,
} from "../services/uploaded-artifact.service";
import type { RouteEntry } from "../route-entry";

const complete$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    return resourceUnavailable(
      "Email attachments require an Email-originated run token.",
    );
  }
  const features = await set(
    loadUserFeatureSwitchContext$,
    auth.orgId,
    auth.userId,
    signal,
  );
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.EmailIntegration, features)) {
    return resourceUnavailable("Email integration is not available");
  }
  const body = await get(
    bodyResultOf(integrationsEmailUploadContract.complete),
  );
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const destination = await set(emailFileDestination$, auth, signal);
  signal.throwIfAborted();
  if (!destination) {
    return resourceUnavailable(
      "This run has no active, verified Email conversation.",
    );
  }
  const file = await set(
    uploadedArtifactObject$,
    { userId: auth.userId, orgId: auth.orgId, id: body.data.uploadId },
    signal,
  );
  signal.throwIfAborted();
  if (!file || !file.isPrivate) {
    return notFound("Private uploaded file not found");
  }
  if (file.size <= 0 || file.size > MAX_EMAIL_ATTACHMENT_SIZE_BYTES) {
    return badRequestMessage(
      "Email attachments must be non-empty and at most 25 MiB.",
    );
  }
  // The private signed address has at least one hour remaining, beyond the
  // outbox's 15-minute deadline.
  // The outbox commits it once and replays the exact provider request/key.
  const path = await set(uploadedArtifactFetchUrl$, file, signal);
  signal.throwIfAborted();
  const result = await set(
    enqueueEmailFile$,
    {
      uploadId: body.data.uploadId,
      destination,
      file: { filename: file.filename, contentType: file.contentType, path },
      text: body.data.text,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return result;
  }
  if (result.delivery.status === "pending") {
    waitUntil(set(drainEmailOutboxBatch$, { currentTimeMs: now() }, signal));
  }
  return {
    status: 200 as const,
    body: {
      uploadId: body.data.uploadId,
      ...result,
      chatThreadId: destination.chatThreadId,
      emailAddress: destination.emailAddress,
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
      url: file.url,
    },
  };
});

export const integrationsEmailUploadCompleteRoutes: readonly RouteEntry[] = [
  {
    route: integrationsEmailUploadContract.complete,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "email:write",
      },
      complete$,
    ),
  },
];
