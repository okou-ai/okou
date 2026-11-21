import { CONNECTOR_PERMISSION_PATHS } from "@okouai/core/integration-routes";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { getCurrentMember } from "../../lib/api/domains/auth";
import { getPlatformOrigin } from "../../lib/platform-url";

export async function memberPermissionUrl(
  kind: keyof typeof CONNECTOR_PERMISSION_PATHS,
) {
  const member = decodeSandboxTokenPayload() ?? (await getCurrentMember());
  if (!member?.orgId || !member.userId) {
    throw new Error(
      "Sign in to the requesting workspace to create a permission link.",
    );
  }
  const url = new URL(
    CONNECTOR_PERMISSION_PATHS[kind],
    await getPlatformOrigin(),
  );
  // These are intended-recipient claims. Only the confirming session can grant permissions.
  url.searchParams.set("orgId", member.orgId);
  url.searchParams.set("userId", member.userId);
  return url;
}
