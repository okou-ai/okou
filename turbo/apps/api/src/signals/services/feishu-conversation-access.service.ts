import { accept, HttpStatusError } from "@okouai/connectors/accept";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import {
  array,
  boolean,
  literal,
  number,
  object,
  string,
  enum as zEnum,
  unknown as zUnknown,
  type infer as zInfer,
  type ZodType,
} from "zod";

import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { db$, writeDb$ } from "../external/db";
import {
  FeishuApiError,
  resolveFeishuRequestCredentials,
  feishuTokenUpdateValues,
} from "../external/feishu-client";
import { settle } from "../utils";

function parseAccessData<T>(schema: ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new FeishuApiError(
      "The provider returned invalid conversation access information.",
      502,
    );
  }
  return parsed.data;
}

function denied(): never {
  throw new FeishuApiError(
    "This conversation is unavailable to your connected account and Okou.",
    403,
  );
}

const chatSchema = object({
  chat_mode: zEnum(["group", "topic", "p2p"]),
  owner_id: string().optional(),
  user_manager_id_list: array(string()).optional(),
  moderation_permission: zEnum([
    "all_members",
    "only_owner",
    "moderator_list",
  ]).optional(),
});
const membersSchema = object({
  items: array(
    object({ member_id: string(), member_id_type: literal("open_id") }),
  ),
  has_more: boolean(),
  page_token: string().optional(),
});
const moderationSchema = object({
  moderation_setting: zEnum(["all_members", "only_owner", "moderator_list"]),
  items: array(
    object({ user_id: string(), user_id_type: literal("open_id") }),
  ).optional(),
  has_more: boolean().optional(),
  page_token: string().optional(),
});

async function readAccessData(
  args: {
    token: string;
    url: URL;
  },
  signal: AbortSignal,
): Promise<unknown> {
  const requested = await settle(
    (async () => {
      const acceptedResponse = await settle(
        accept(
          fetch(args.url, {
            headers: { authorization: `Bearer ${args.token}` },
          }),
          [200],
        ),
      );
      if (!acceptedResponse.ok) {
        const error = acceptedResponse.error;
        if (error instanceof HttpStatusError && error.status >= 300) {
          return error.response;
        }
        throw error;
      }
      return acceptedResponse.value;
    })(),
    signal,
  );
  if (!requested.ok) {
    throw new FeishuApiError(
      "The provider could not verify conversation access.",
      502,
    );
  }
  const response = requested.value;
  if (response.status >= 500 || response.status === 429) {
    throw new FeishuApiError(
      "The provider is temporarily unable to verify conversation access.",
      502,
    );
  }
  if (!response.ok) {
    throw new FeishuApiError(
      "The provider denied conversation access. Check the bot's chat read permissions.",
      403,
    );
  }
  const decoded = await settle(response.json(), signal);
  if (!decoded.ok) {
    throw new FeishuApiError(
      "The provider returned invalid conversation access information.",
      502,
    );
  }
  const body = parseAccessData(
    object({ code: number(), data: zUnknown().optional() }),
    decoded.value,
  );
  if (body.code !== 0) {
    throw new FeishuApiError(
      "The provider could not verify conversation access. Check the bot's chat read permissions.",
      403,
    );
  }
  return body.data;
}

async function requireFeishuChatMember(
  args: { token: string; base: string; openId: string },
  signal: AbortSignal,
): Promise<void> {
  const { token, base, openId } = args;
  let pageToken: string | undefined;
  const visited = new Set<string>();
  let found = false;
  do {
    const url = new URL(`${base}/members`);
    url.searchParams.set("member_id_type", "open_id");
    url.searchParams.set("page_size", "100");
    if (pageToken) {
      url.searchParams.set("page_token", pageToken);
    }
    const page = parseAccessData(
      membersSchema,
      await readAccessData({ token, url }, signal),
    );
    if (
      page.items.some((member) => {
        return member.member_id === openId;
      })
    ) {
      found = true;
      break;
    }
    if (!page.has_more) {
      break;
    }
    if (!page.page_token || visited.has(page.page_token)) {
      return denied();
    }
    visited.add(page.page_token);
    pageToken = page.page_token;
  } while (pageToken);
  if (!found) {
    return denied();
  }
}

async function requireFeishuChatPosting(
  args: {
    token: string;
    base: string;
    openId: string;
    chat: zInfer<typeof chatSchema>;
  },
  signal: AbortSignal,
): Promise<void> {
  const { token, base, openId, chat } = args;
  if (
    chat.moderation_permission === "all_members" ||
    chat.owner_id === openId ||
    chat.user_manager_id_list?.includes(openId)
  ) {
    return;
  }
  if (chat.moderation_permission === "only_owner") {
    return denied();
  }
  let pageToken: string | undefined;
  const visited = new Set<string>();
  do {
    const url = new URL(`${base}/moderation`);
    url.searchParams.set("user_id_type", "open_id");
    url.searchParams.set("page_size", "100");
    if (pageToken) {
      url.searchParams.set("page_token", pageToken);
    }
    const page = parseAccessData(
      moderationSchema,
      await readAccessData({ token, url }, signal),
    );
    if (page.moderation_setting === "all_members") {
      return;
    }
    if (page.moderation_setting === "only_owner") {
      return denied();
    }
    if (
      page.items?.some((member) => {
        return member.user_id === openId;
      })
    ) {
      return;
    }
    if (!page.has_more) {
      break;
    }
    if (!page.page_token || visited.has(page.page_token)) {
      return denied();
    }
    visited.add(page.page_token);
    pageToken = page.page_token;
  } while (pageToken);
  return denied();
}

/** Group access and private reads require the caller; outbound DMs may target others. */
export const requireFeishuConversationAccess$ = command(
  async (
    { get, set },
    args: {
      orgId: string;
      userId: string;
      installationId: string;
      user?: string;
      chat?: string;
      messageId?: string;
      write: boolean;
    },
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    const [binding] = await get(db$)
      .select({ openId: feishuOrgConnections.feishuOpenId })
      .from(feishuOrgConnections)
      .innerJoin(
        feishuOrgInstallations,
        eq(feishuOrgInstallations.id, feishuOrgConnections.installationId),
      )
      .where(
        and(
          eq(feishuOrgConnections.installationId, args.installationId),
          eq(feishuOrgConnections.userId, args.userId),
          eq(feishuOrgInstallations.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!binding) {
      return denied();
    }
    if (args.user) {
      if (!args.write && args.user !== "me" && args.user !== binding.openId) {
        return denied();
      }
      return args.user === "me" ? binding.openId : args.user;
    }
    const [installation] = await get(db$)
      .select()
      .from(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.id, args.installationId),
          eq(feishuOrgInstallations.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return denied();
    }
    const credentials = await resolveFeishuRequestCredentials(
      installation,
      signal,
    );
    if (credentials.refreshedToken) {
      await set(writeDb$)
        .update(feishuOrgInstallations)
        .set(feishuTokenUpdateValues(credentials.refreshedToken))
        .where(eq(feishuOrgInstallations.id, installation.id));
      signal.throwIfAborted();
    }
    const { token, apiOrigin } = credentials.context;
    let chatId = args.chat;
    if (args.messageId) {
      const data = await readAccessData(
        {
          token,
          url: new URL(
            `${apiOrigin}/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}`,
          ),
        },
        signal,
      );
      const messages = parseAccessData(
        object({
          items: array(object({ message_id: string(), chat_id: string() })),
        }),
        data,
      );
      const message = messages.items.find((item) => {
        return item.message_id === args.messageId;
      });
      if (!message || (chatId && chatId !== message.chat_id)) {
        return denied();
      }
      chatId = message.chat_id;
    }
    if (!chatId) {
      return denied();
    }
    const base = `${apiOrigin}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`;
    const infoUrl = new URL(base);
    infoUrl.searchParams.set("user_id_type", "open_id");
    const chat = parseAccessData(
      chatSchema,
      await readAccessData({ token, url: infoUrl }, signal),
    );
    if (args.write && chat.chat_mode === "p2p") {
      return;
    }
    // Reading chat metadata with a tenant token does not prove the bot joined.
    if (chat.chat_mode !== "p2p") {
      const present = parseAccessData(
        object({ is_in_chat: boolean() }),
        await readAccessData(
          { token, url: new URL(`${base}/members/is_in_chat`) },
          signal,
        ),
      );
      if (!present.is_in_chat) {
        return denied();
      }
    }
    await requireFeishuChatMember(
      { token, base, openId: binding.openId },
      signal,
    );
    if (args.write && chat.chat_mode !== "p2p") {
      await requireFeishuChatPosting(
        { token, base, openId: binding.openId, chat },
        signal,
      );
    }
  },
);
