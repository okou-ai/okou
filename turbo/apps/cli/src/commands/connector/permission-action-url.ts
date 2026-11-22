import { uuid } from "zod";
import { CONNECTOR_PERMISSION_PATHS } from "@okouai/core/integration-routes";
import { getCurrentMember } from "../../lib/api/domains/auth";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { getOkouChatThreadId } from "../../lib/okou-env";
import { getPlatformOrigin } from "../../lib/platform-url";

import { finalizeActionUrl } from "./action-url";

const chatThreadIdSchema = uuid();

export function currentPermissionCallbackThread(): string | undefined {
  const thread = chatThreadIdSchema.safeParse(getOkouChatThreadId()?.trim());
  return thread.success && decodeSandboxTokenPayload()?.runId
    ? thread.data
    : undefined;
}

export function finalizePermissionActionUrl(
  actionUrl: URL,
  callbackPrompt: string | undefined,
): string {
  return finalizeActionUrl(
    actionUrl,
    callbackPrompt,
    currentPermissionCallbackThread,
  );
}

export async function permissionActionUrl(
  kind: keyof typeof CONNECTOR_PERMISSION_PATHS,
): Promise<URL> {
  const member = decodeSandboxTokenPayload() ?? (await getCurrentMember());
  if (!member.orgId || !member.userId) {
    throw new Error(
      "A workspace member is required to request connector permissions.",
    );
  }

  const url = new URL(
    CONNECTOR_PERMISSION_PATHS[kind],
    await getPlatformOrigin(),
  );
  url.searchParams.set("orgId", member.orgId);
  url.searchParams.set("userId", member.userId);
  return url;
}
