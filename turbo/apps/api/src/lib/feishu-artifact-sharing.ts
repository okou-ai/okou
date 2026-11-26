import { createHmac, timingSafeEqual } from "node:crypto";
import { literal, number, object, string, uuid, url, enum as zEnum } from "zod";
import { env } from "./env";
import { now } from "./time";
import { safeJsonParse } from "../signals/utils";

export const FEISHU_ARTIFACT_SHARE_ACTION = "artifact_channel_share";
const stateSchema = object({
  version: literal(1),
  environment: string(),
  issuedAt: number().int(),
  installationId: uuid(),
  tenantKey: string().min(1),
  openId: string().min(1),
  chatId: string().min(1),
  messageId: string().min(1),
  previewToken: string().min(1),
  url: url(),
  kind: zEnum(["file", "site"]),
  id: uuid(),
  userId: string().min(1),
  orgId: string().min(1),
});
export type FeishuArtifactShareState = Omit<
  ReturnType<typeof stateSchema.parse>,
  "version" | "environment" | "issuedAt"
>;

function signature(payload: string): Buffer {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`feishu-artifact-sharing-v1:${payload}`)
    .digest();
}

export function signFeishuArtifactShare(
  state: FeishuArtifactShareState,
): string {
  const data = stateSchema.parse({
    ...state,
    version: 1,
    environment: env("ENV"),
    issuedAt: now(),
  });
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function verifyFeishuArtifactShare(
  token: string,
): FeishuArtifactShareState | null {
  const [payload, signed, extra] = token.split(".");
  if (!payload || !signed || extra !== undefined) {
    return null;
  }
  const actual = Buffer.from(signed, "base64url");
  const expected = signature(payload);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }
  const state = stateSchema.safeParse(
    safeJsonParse(Buffer.from(payload, "base64url").toString()),
  );
  if (
    !state.success ||
    state.data.environment !== env("ENV") ||
    state.data.issuedAt > now() ||
    now() - state.data.issuedAt > 15 * 60_000
  ) {
    return null;
  }
  return state.data;
}

export function feishuArtifactCard(args: {
  readonly title: string;
  readonly text: string;
  readonly url?: string;
  readonly imageKey?: string;
  readonly share?: {
    readonly token: string;
    readonly audience: "private" | "organization";
  };
}): Readonly<Record<string, unknown>> {
  const actions = args.share
    ? [
        { label: "Share with current chat members", audience: "channel" },
        ...(args.share.audience === "private"
          ? [{ label: "Share with workspace", audience: "organization" }]
          : []),
        { label: "Make public", audience: "public" },
      ]
    : [];
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      summary: { content: args.title },
    },
    header: {
      title: { tag: "plain_text", content: args.title.slice(0, 150) },
      template: "blue",
    },
    body: {
      elements: [
        { tag: "div", text: { tag: "plain_text", content: args.text } },
        ...(args.imageKey
          ? [
              {
                tag: "img",
                img_key: args.imageKey,
                alt: { tag: "plain_text", content: "Artifact preview" },
                mode: "fit_horizontal",
              },
            ]
          : []),
        ...actions.map((action) => {
          return {
            tag: "button",
            text: { tag: "plain_text", content: action.label },
            type: action.audience === "channel" ? "primary_filled" : "default",
            behaviors: [
              {
                type: "callback",
                value: {
                  action: FEISHU_ARTIFACT_SHARE_ACTION,
                  token: args.share?.token,
                  audience: action.audience,
                },
              },
            ],
          };
        }),
        ...(args.url
          ? [
              {
                tag: "button",
                text: { tag: "plain_text", content: "Open artifact" },
                behaviors: [{ type: "open_url", default_url: args.url }],
              },
            ]
          : []),
      ],
    },
  };
}
