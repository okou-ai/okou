import type { CustomConnectorPermissionBundleRef } from "@okouai/api-contracts/contracts/custom-connectors";
import type {
  ExpandedFirewallConfig,
  FirewallPolicyValue,
} from "@okouai/connectors/firewall-types";

const FEISHU_API_PREFIX = "https://open.feishu.cn/open-apis/";
const FEISHU_MANAGED_CONNECTOR_SLUG_PATTERN =
  /^_(?:feishu|lark)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF =
  "builtin:feishu@1" satisfies CustomConnectorPermissionBundleRef;

type FirewallPermissions = NonNullable<
  ExpandedFirewallConfig["apis"][number]["permissions"]
>;

const approvalMethods = ["GET", "POST", "PUT", "PATCH"] as const;
const approvalAreas = [
  "contact",
  "im",
  "drive",
  "docx",
  "docs",
  "sheets",
  "bitable",
  "wiki",
  "search",
  "slides",
  "board",
  "calendar",
  "task",
] as const;

function buildStandardApprovalRules(): string[] {
  return [
    "GET /authen/v1/user_info",
    ...approvalAreas.flatMap((area) => {
      return approvalMethods.map((method) => {
        return `${method} /${area}/{path*}`;
      });
    }),
    "DELETE /im/v1/messages/{message_id}/reactions/{reaction_id}",
    "POST /calendar/v4/calendars/search",
    "POST /calendar/v4/calendars/{calendar_id}/events/search",
    "POST /calendar/v4/freebusy/list",
    "POST /calendar/v4/freebusy/batch",
    "POST /task/v2/tasks/search",
    "POST /task/v2/tasklists/search",
    "POST /task/v2/task_v2/list_related_task",
  ];
}

export const FEISHU_CUSTOM_CONNECTOR_PERMISSIONS = [
  {
    name: "standard:use",
    description:
      "Use connected workspace APIs that do not match a higher-risk action.",
    rules: buildStandardApprovalRules(),
  },
  {
    name: "messages:send-as-user",
    description:
      "Send, forward, reply to, edit, recall, or urgently notify from messages as the connected user.",
    rules: [
      "POST /im/v1/messages",
      "POST /im/v1/messages/merge_forward",
      "POST /im/v1/messages/{message_id}/reply",
      "POST /im/v1/messages/{message_id}/forward",
      "PUT /im/v1/messages/{message_id}",
      "PATCH /im/v1/messages/{message_id}",
      "DELETE /im/v1/messages/{message_id}",
      "POST /im/v1/messages/{message_id}/push_follow_up",
      "PATCH /im/v1/messages/{message_id}/urgent_app",
      "PATCH /im/v1/messages/{message_id}/urgent_phone",
      "PATCH /im/v1/messages/{message_id}/urgent_sms",
      "POST /im/v1/batch_messages",
      "DELETE /im/v1/batch_messages/{batch_message_id}",
      "POST /message/v4/batch_send",
    ],
  },
  {
    name: "resources:delete",
    description:
      "Delete files, documents, sheets, Base tables or records, Wiki nodes, or slides.",
    rules: [
      "DELETE /drive/{path*}",
      "DELETE /docx/{path*}",
      "DELETE /docs/{path*}",
      "DELETE /sheets/{path*}",
      "DELETE /bitable/{path*}",
      "DELETE /wiki/{path*}",
      "DELETE /slides/{path*}",
      "POST /bitable/v1/apps/{app_token}/tables/batch_delete",
      "POST /bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_delete",
    ],
  },
  {
    name: "sharing:manage",
    description:
      "Add, update, or remove collaborators; change public sharing; or transfer ownership.",
    rules: [
      "POST /drive/v1/permissions/{path*}",
      "PUT /drive/v1/permissions/{path*}",
      "PATCH /drive/v1/permissions/{path*}",
      "DELETE /drive/v1/permissions/{path*}",
      "POST /drive/v2/permissions/{path*}",
      "PUT /drive/v2/permissions/{path*}",
      "PATCH /drive/v2/permissions/{path*}",
      "DELETE /drive/v2/permissions/{path*}",
      "POST /drive/permission/{path*}",
      "PUT /drive/permission/{path*}",
      "PATCH /drive/permission/{path*}",
      "DELETE /drive/permission/{path*}",
      "POST /wiki/v2/spaces/{space_id}/members",
      "PUT /wiki/v2/spaces/{space_id}/members/{member_id}",
      "PATCH /wiki/v2/spaces/{space_id}/members/{member_id}",
      "DELETE /wiki/v2/spaces/{space_id}/members/{member_id}",
      "PATCH /wiki/v2/spaces/{space_id}/setting",
    ],
  },
  {
    name: "chats:manage",
    description:
      "Create or dissolve chats, change chat settings, manage members or administrators, or create invite links.",
    rules: [
      "POST /im/v1/chats",
      "PUT /im/v1/chats/{chat_id}",
      "PATCH /im/v1/chats/{chat_id}",
      "DELETE /im/v1/chats/{chat_id}",
      "POST /im/v1/chats/{chat_id}/members",
      "DELETE /im/v1/chats/{chat_id}/members",
      "PATCH /im/v1/chats/{chat_id}/members/me_join",
      "POST /im/v1/chats/{chat_id}/managers",
      "DELETE /im/v1/chats/{chat_id}/managers",
      "POST /im/v1/chats/{chat_id}/managers/{path*}",
      "DELETE /im/v1/chats/{chat_id}/managers/{path*}",
      "POST /im/v1/chats/{chat_id}/link",
      "POST /im/v1/chats/{chat_id}/{path*}",
      "PUT /im/v1/chats/{chat_id}/{path*}",
      "PATCH /im/v1/chats/{chat_id}/{path*}",
      "DELETE /im/v1/chats/{chat_id}/{path*}",
    ],
  },
  {
    name: "comments:write",
    description:
      "Create, edit, resolve, or delete document or task comments as the connected user.",
    rules: [
      "POST /drive/v1/files/{file_token}/comments",
      "PATCH /drive/v1/files/{file_token}/comments/{comment_id}",
      "DELETE /drive/v1/files/{file_token}/comments/{comment_id}",
      "POST /drive/v1/files/{file_token}/comments/{comment_id}/replies",
      "PATCH /drive/v1/files/{file_token}/comments/{comment_id}/replies/{reply_id}",
      "DELETE /drive/v1/files/{file_token}/comments/{comment_id}/replies/{reply_id}",
      "POST /task/v2/comments",
      "PUT /task/v2/comments/{comment_id}",
      "PATCH /task/v2/comments/{comment_id}",
      "DELETE /task/v2/comments/{comment_id}",
    ],
  },
  {
    name: "calendar:write",
    description:
      "Create or change calendars, meetings, attendees, invitations, replies, or calendar access controls.",
    rules: [
      "POST /calendar/v4/calendars",
      "PATCH /calendar/v4/calendars/{calendar_id}",
      "DELETE /calendar/v4/calendars/{calendar_id}",
      "POST /calendar/v4/calendars/{calendar_id}/events",
      "PUT /calendar/v4/calendars/{calendar_id}/events/{event_id}",
      "PATCH /calendar/v4/calendars/{calendar_id}/events/{event_id}",
      "DELETE /calendar/v4/calendars/{calendar_id}/events/{event_id}",
      "POST /calendar/v4/calendars/{calendar_id}/events/{event_id}/{path*}",
      "PUT /calendar/v4/calendars/{calendar_id}/events/{event_id}/{path*}",
      "PATCH /calendar/v4/calendars/{calendar_id}/events/{event_id}/{path*}",
      "DELETE /calendar/v4/calendars/{calendar_id}/events/{event_id}/{path*}",
      "POST /calendar/v4/calendars/{calendar_id}/access_controls",
      "PUT /calendar/v4/calendars/{calendar_id}/access_controls/{access_control_id}",
      "PATCH /calendar/v4/calendars/{calendar_id}/access_controls/{access_control_id}",
      "DELETE /calendar/v4/calendars/{calendar_id}/access_controls/{access_control_id}",
    ],
  },
  {
    name: "tasks:write",
    description:
      "Create or change tasks, task lists, assignments, followers, collaborators, dependencies, reminders, or sections.",
    rules: [
      "POST /task/v2/{path*}",
      "PUT /task/v2/{path*}",
      "PATCH /task/v2/{path*}",
      "DELETE /task/v2/{path*}",
    ],
  },
] as const satisfies FirewallPermissions;

export const FEISHU_CUSTOM_CONNECTOR_DEFAULT_POLICIES = Object.fromEntries(
  FEISHU_CUSTOM_CONNECTOR_PERMISSIONS.map((permission) => {
    const policy: FirewallPolicyValue =
      permission.name === "messages:send-as-user" ||
      permission.name === "resources:delete" ||
      permission.name === "chats:manage"
        ? "deny"
        : "allow";
    return [permission.name, policy];
  }),
) satisfies Readonly<Record<string, FirewallPolicyValue>>;

function isManagedFeishuCustomConnector(args: {
  readonly slug: string;
  readonly authMode: string;
  readonly oauthProviderAdapter: string | null;
  readonly prefixTemplates: readonly string[];
}): boolean {
  return (
    FEISHU_MANAGED_CONNECTOR_SLUG_PATTERN.test(args.slug) &&
    args.authMode === "oauth" &&
    args.oauthProviderAdapter === "feishu" &&
    args.prefixTemplates.length === 1 &&
    args.prefixTemplates[0] ===
      (args.slug.startsWith("_lark-")
        ? "https://open.larksuite.com/open-apis/"
        : FEISHU_API_PREFIX)
  );
}

export function effectiveCustomConnectorPermissionBundleRef(args: {
  readonly slug: string;
  readonly authMode: string;
  readonly oauthProviderAdapter: string | null;
  readonly prefixTemplates: readonly string[];
  readonly permissionBundleRef: CustomConnectorPermissionBundleRef | null;
}): CustomConnectorPermissionBundleRef | null {
  return isManagedFeishuCustomConnector(args)
    ? FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF
    : args.permissionBundleRef;
}
