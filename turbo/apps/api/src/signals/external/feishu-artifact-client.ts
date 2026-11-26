import { array, boolean, literal, number, object, string } from "zod";
import { accept } from "@okouai/connectors/accept";
import { FeishuApiError } from "./feishu-client";

export interface FeishuArtifactCredentials {
  readonly token: string;
  readonly apiOrigin: string;
  readonly providerName: string;
}

const resultSchema = object({
  code: number(),
  msg: string().optional(),
}).passthrough();

async function request(
  credentials: FeishuArtifactCredentials,
  path: string,
  body: unknown | undefined,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await accept(
    fetch(`${credentials.apiOrigin}/open-apis/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    }),
    [200],
  );
  const parsed = resultSchema.parse(await response.json());
  signal.throwIfAborted();
  if (parsed.code !== 0) {
    throw new FeishuApiError(
      parsed.msg ?? `${credentials.providerName} artifact operation failed`,
      502,
      parsed.code,
    );
  }
  return parsed.data;
}

const membersSchema = object({
  items: array(
    object({ member_id: string().min(1), member_id_type: literal("open_id") }),
  ),
  has_more: boolean(),
  page_token: string().optional(),
});

/** Only a complete member list of a normal group joined by this bot can authorize a preview. */
export async function fetchFeishuArtifactMembers(
  credentials: FeishuArtifactCredentials,
  chatId: string,
  signal: AbortSignal,
): Promise<readonly string[] | null> {
  const base = `im/v1/chats/${encodeURIComponent(chatId)}`;
  const [chat, bot] = await Promise.all([
    request(credentials, base, undefined, signal),
    request(credentials, `${base}/members/is_in_chat`, undefined, signal),
  ]);
  if (
    object({ chat_mode: string() }).parse(chat).chat_mode !== "group" ||
    !object({ is_in_chat: boolean() }).parse(bot).is_in_chat
  ) {
    return null;
  }
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      member_id_type: "open_id",
      page_size: "100",
      ...(cursor ? { page_token: cursor } : {}),
    });
    const page = membersSchema.parse(
      await request(
        credentials,
        `${base}/members?${params}`,
        undefined,
        signal,
      ),
    );
    for (const member of page.items) {
      ids.add(member.member_id);
    }
    if (!page.has_more) {
      return [...ids];
    }
    if (!page.page_token || cursors.has(page.page_token)) {
      throw new FeishuApiError(
        "The full chat member list could not be verified",
        502,
      );
    }
    cursor = page.page_token;
    cursors.add(cursor);
  } while (cursor);
  return null;
}

export async function sendFeishuArtifactPrompt(
  credentials: FeishuArtifactCredentials,
  args: {
    readonly chatId: string;
    readonly openId: string;
    readonly card: Readonly<Record<string, unknown>>;
  },
  signal: AbortSignal,
): Promise<void> {
  await request(
    credentials,
    "ephemeral/v1/send",
    {
      chat_id: args.chatId,
      open_id: args.openId,
      msg_type: "interactive",
      card: args.card,
    },
    signal,
  );
}

export async function refreshFeishuArtifactPreview(
  credentials: FeishuArtifactCredentials,
  previewToken: string,
  signal: AbortSignal,
): Promise<void> {
  await request(
    credentials,
    "im/v2/url_previews/batch_update",
    { preview_tokens: [previewToken] },
    signal,
  );
}

export async function updateFeishuArtifactPrompt(
  credentials: FeishuArtifactCredentials,
  args: {
    readonly token: string;
    readonly card: Readonly<Record<string, unknown>>;
  },
  signal: AbortSignal,
): Promise<void> {
  await request(credentials, "interactive/v1/card/update", args, signal);
}

export async function uploadFeishuArtifactPreviewImage(
  credentials: FeishuArtifactCredentials,
  bytes: Buffer,
  contentType: string,
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.set("image_type", "message");
  form.set(
    "image",
    new Blob([new Uint8Array(bytes)], { type: contentType }),
    "artifact-preview.png",
  );
  const response = await accept(
    fetch(`${credentials.apiOrigin}/open-apis/im/v1/images`, {
      method: "POST",
      headers: { authorization: `Bearer ${credentials.token}` },
      body: form,
      signal,
    }),
    [200],
  );
  const parsed = object({
    code: literal(0),
    data: object({ image_key: string().min(1) }),
  }).parse(await response.json());
  signal.throwIfAborted();
  return parsed.data.image_key;
}
