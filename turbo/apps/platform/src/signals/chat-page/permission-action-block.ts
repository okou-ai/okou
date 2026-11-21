import type { UserPermissionGrantExpiresIn } from "@okouai/api-contracts/validators/user-permission-grants";
import { parseUserPermissionGrantExpiresIn } from "../permission-allow/permission-grant-expiration.ts";
import {
  chatActionCallbackFromUrl,
  type ChatActionCallback,
} from "./action-callback.ts";
import {
  chatActionIdMatches,
  type ChatActionContext,
  type ChatActionParseResult,
} from "./chat-action-context.ts";
import { parseTrustedPlatformUrl } from "./trusted-platform-url.ts";

type PermissionAction = "allow" | "deny";

export interface PermissionActionDescriptor {
  scope: "agent";
  agentId: string;
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
  const path = `/agents/${encodeURIComponent(descriptor.agentId)}/permissions`;
  return descriptor.search ? `${path}?${descriptor.search}` : path;
}

function isPermissionAction(value: string): value is PermissionAction {
  return value === "allow" || value === "deny";
}

type ParsedPermissionActionPath = {
  scope: "agent";
  agentId: string;
};

function parsePermissionActionPath(
  pathname: string,
): ParsedPermissionActionPath | null {
  const agentMatch = pathname.match(/^\/agents\/([^/]+)\/permissions$/);
  if (!agentMatch) {
    return null;
  }

  return {
    scope: "agent",
    agentId: agentMatch[1] ?? "",
  };
}

export function parsePermissionActionUrl(
  value: string,
  context: ChatActionContext | undefined,
): ChatActionParseResult<PermissionActionDescriptor> {
  const url = parseTrustedPlatformUrl(value);
  if (!url) {
    return { status: "unrelated" };
  }

  const path = parsePermissionActionPath(url.pathname);
  if (!path) {
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

  if (
    !context ||
    !path.agentId ||
    !context.agentId ||
    !chatActionIdMatches(path.agentId, context.agentId) ||
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
      scope: path.scope,
      agentId: context.agentId,
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
