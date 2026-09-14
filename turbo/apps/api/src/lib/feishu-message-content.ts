import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { safeJsonParse } from "../signals/utils";

export interface FeishuPromptFile {
  readonly fileId: string;
  readonly messageId: string;
  readonly fileKey: string;
  readonly type: "file" | "image";
  readonly filename: string;
}

interface FeishuMessageContent {
  readonly text: string;
  readonly files: readonly FeishuPromptFile[];
}

const textSchema = z.object({ text: z.string() });
const resourceSchema = z.object({
  file_key: z.string().optional(),
  image_key: z.string().optional(),
  file_name: z.string().optional(),
});
const postSchema = z.object({
  title: z.string().optional(),
  content: z.array(z.array(z.unknown())),
});
const cardSchema = z.object({
  title: z.string().optional(),
  header: z.object({ title: z.unknown().optional() }).optional(),
  body: z.object({ elements: z.array(z.unknown()) }).optional(),
  elements: z.array(z.unknown()).optional(),
  card_link: z.unknown().optional(),
});
const urlsSchema = z.object({
  url: z.string().optional(),
  default_url: z.string().optional(),
  pc_url: z.string().optional(),
  ios_url: z.string().optional(),
  android_url: z.string().optional(),
});
const nodeSchema = resourceSchema.extend({
  tag: z.string().optional(),
  text: z.unknown().optional(),
  content: z.string().optional(),
  alt: z.unknown().optional(),
  img_key: z.string().optional(),
  user_id: z.string().optional(),
  user_name: z.string().optional(),
  language: z.string().optional(),
  href: z.string().optional(),
  url: z.string().optional(),
  multi_url: z.unknown().optional(),
  behaviors: z.array(z.unknown()).optional(),
  elements: z.array(z.unknown()).optional(),
  columns: z.array(z.unknown()).optional(),
  fields: z.array(z.unknown()).optional(),
  actions: z.array(z.unknown()).optional(),
});

function urls(value: unknown): string[] {
  const parsed = urlsSchema.safeParse(value);
  return parsed.success
    ? Object.values(parsed.data).filter((url): url is string => {
        return Boolean(url);
      })
    : [];
}

class FeishuContentReader {
  readonly files: FeishuPromptFile[] = [];

  constructor(private readonly messageId: string) {}

  addFile(fileKey: string | undefined, type: "file" | "image", name: string) {
    if (
      !fileKey ||
      this.files.some((file) => {
        return file.fileKey === fileKey && file.type === type;
      })
    ) {
      return;
    }
    this.files.push({
      fileId: `feishu_file_${randomBytes(16).toString("base64url")}`,
      messageId: this.messageId,
      fileKey,
      type,
      filename: name.replace(/\s+/gu, " ").trim() || type,
    });
  }

  blocks(values: readonly unknown[], depth = 0): string {
    return values
      .map((value) => {
        return this.node(value, depth);
      })
      .filter(Boolean)
      .join("\n");
  }

  node(value: unknown, depth = 0): string {
    if (depth > 32) {
      return "[Nested content omitted]";
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value
        .map((item: unknown) => {
          return this.node(item, depth + 1);
        })
        .join("");
    }
    const parsed = nodeSchema.safeParse(value);
    if (!parsed.success) {
      return "";
    }
    const node = parsed.data;
    if (node.tag === "img") {
      this.addFile(node.image_key ?? node.img_key, "image", "image");
      return this.node(node.alt, depth + 1);
    }
    if (node.tag === "media" || node.tag === "file") {
      this.addFile(node.file_key, "file", node.file_name ?? node.tag);
    }
    if (node.tag === "at") {
      return node.user_id ?? node.user_name ?? "";
    }
    if (node.tag === "hr") {
      return "\n---\n";
    }
    const text = node.content ?? this.node(node.text, depth + 1);
    if (node.tag === "code_block") {
      return `\`\`\`${node.language ?? ""}\n${text}\n\`\`\``;
    }
    const links = [
      ...new Set(
        [
          node.href,
          node.url,
          ...urls(node.multi_url),
          ...(node.behaviors ?? []).flatMap(urls),
        ].filter((url): url is string => {
          return Boolean(url);
        }),
      ),
    ];
    const linkedText = links.length
      ? links
          .map((url) => {
            return `[${text || url}](${url})`;
          })
          .join(" ")
      : text;
    return [
      linkedText,
      ...[node.elements, node.columns, node.fields, node.actions].map(
        (children) => {
          return this.blocks(children ?? [], depth + 1);
        },
      ),
    ]
      .filter(Boolean)
      .join("\n");
  }
}

function resourceContent(
  reader: FeishuContentReader,
  messageType: string,
  content: unknown,
): string | null {
  const parsed = resourceSchema.safeParse(content);
  if (!parsed.success) {
    return null;
  }
  const type = messageType === "image" ? "image" : "file";
  reader.addFile(
    type === "image" ? parsed.data.image_key : parsed.data.file_key,
    type,
    parsed.data.file_name?.trim() ||
      (messageType === "media" ? "video" : messageType),
  );
  return "";
}

function richContent(
  reader: FeishuContentReader,
  messageType: string,
  content: unknown,
): string | null {
  if (messageType === "post") {
    const parsed = postSchema.safeParse(content);
    return parsed.success
      ? [parsed.data.title, reader.blocks(parsed.data.content)]
          .filter(Boolean)
          .join("\n")
      : null;
  }
  const parsed = cardSchema.safeParse(content);
  return parsed.success
    ? [
        parsed.data.title ?? reader.node(parsed.data.header?.title),
        reader.blocks(parsed.data.body?.elements ?? parsed.data.elements ?? []),
        ...urls(parsed.data.card_link),
      ]
        .filter(Boolean)
        .join("\n")
    : null;
}

/** Decode the provider's message body for both new input and conversation history. */
export function parseFeishuMessageContent(args: {
  readonly messageId: string;
  readonly messageType: string;
  readonly content: string;
}): FeishuMessageContent | null {
  const content = safeJsonParse(args.content);
  const reader = new FeishuContentReader(args.messageId);
  let text: string | null;
  switch (args.messageType) {
    case "text": {
      const parsed = textSchema.safeParse(content);
      text = parsed.success ? parsed.data.text : null;
      break;
    }
    case "image":
    case "file":
    case "audio":
    case "media": {
      text = resourceContent(reader, args.messageType, content);
      break;
    }
    case "post":
    case "interactive": {
      text = richContent(reader, args.messageType, content);
      break;
    }
    default: {
      return null;
    }
  }
  return text === null || (!text.trim() && reader.files.length === 0)
    ? null
    : { text, files: reader.files };
}

export function formatFeishuMessageContent(
  content: FeishuMessageContent,
  platform: FeishuPlatform = "feishu",
): string {
  return [
    content.text,
    ...content.files.map((file) => {
      return [
        `[${FEISHU_PLATFORMS[platform].name} file] ${file.filename}`,
        `   [MESSAGE_ID] ${file.messageId}`,
        `   [FILE_KEY] ${file.fileId}`,
        `   [TYPE] ${file.type}`,
      ].join("\n");
    }),
  ]
    .filter(Boolean)
    .join("\n");
}
