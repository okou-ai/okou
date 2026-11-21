import { CONNECTOR_PERMISSION_PATHS } from "@okouai/core/integration-routes";
import {
  permissionActionOwner,
  type PermissionActionOwner,
} from "./permission-action-owner.ts";
import type { UserPermissionGrantExpiresIn } from "@okouai/api-contracts/validators/user-permission-grants";
import { parseUserPermissionGrantExpiresIn } from "../permission-allow/permission-grant-expiration.ts";
import {
  chatActionCallbackFromUrl,
  type ChatActionCallback,
} from "./action-callback.ts";
import type {
  ChatActionContext,
  ChatActionParseResult,
} from "./chat-action-context.ts";
import { parseTrustedPlatformUrl } from "./trusted-platform-url.ts";

type PermissionAction = "allow" | "deny";

export interface PermissionActionDescriptor {
  owner: PermissionActionOwner;
  connectorSlug: string;
  permission: string;
  action: PermissionAction;
  method: string | null;
  path: string | null;
  reason: string | null;
  expiresIn: UserPermissionGrantExpiresIn | null;
  search: string;
  originalUrl: string;
  callbackPrompt: ChatActionCallback["callbackPrompt"];
  threadId: ChatActionCallback["threadId"];
}

export function permissionActionResourceKey(
  descriptor: PermissionActionDescriptor,
): string {
  const path =
    descriptor.owner.kind === "agent"
      ? `/agents/${encodeURIComponent(descriptor.owner.agentId)}/permissions`
      : CONNECTOR_PERMISSION_PATHS.single;
  return descriptor.search ? `${path}?${descriptor.search}` : path;
}

function isPermissionAction(value: string): value is PermissionAction {
  return value === "allow" || value === "deny";
}

export function parsePermissionActionUrl(
  value: string,
  context: ChatActionContext | undefined,
): ChatActionParseResult<PermissionActionDescriptor> {
  const url = parseTrustedPlatformUrl(value);
  if (!url) {
    return { status: "unrelated" };
  }

  const legacy = url.pathname.match(/^\/agents\/([^/]+)\/permissions$/u);
  if (!legacy && url.pathname !== CONNECTOR_PERMISSION_PATHS.single) {
    return { status: "unrelated" };
  }
  // Historical permission links may use ref from before CLI 9.270.1.
  const connectorSlug =
    url.searchParams.get("connectorSlug") ?? url.searchParams.get("ref");
  const permission = url.searchParams.get("permission");
  const action = url.searchParams.get("action") ?? "allow";
  const method = url.searchParams.get("method");
  const requestPath = url.searchParams.get("path");
  const reason = url.searchParams.get("reason");
  const expiresIn =
    action === "allow"
      ? parseUserPermissionGrantExpiresIn(url.searchParams.get("expiresIn"))
      : null;
  const actionCallback = context
    ? chatActionCallbackFromUrl(url, context)
    : null;

  const owner = context && permissionActionOwner(url, legacy?.[1], context);
  if (
    !owner ||
    !connectorSlug ||
    !permission ||
    !isPermissionAction(action) ||
    !actionCallback
  ) {
    return { status: "invalid", originalUrl: value };
  }

  return {
    status: "valid",
    descriptor: {
      owner,
      connectorSlug,
      permission,
      action,
      method,
      path: requestPath,
      reason,
      expiresIn,
      search: url.searchParams.toString(),
      originalUrl: value,
      ...actionCallback,
    },
  };
}
