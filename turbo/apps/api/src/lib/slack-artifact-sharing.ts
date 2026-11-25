import { createHmac, timingSafeEqual } from "node:crypto";
import { escapeText } from "entities/escape";
import {
  literal,
  number,
  object,
  string,
  uuid,
  url as zUrl,
  enum as zEnum,
} from "zod";
import type { SlackKnownBlock } from "../signals/external/slack-block-kit";
import { safeJsonParse } from "../signals/utils";
import { env } from "./env";
import { now } from "./time";

export const SLACK_ARTIFACT_SHARE_ACTIONS = {
  channel: "artifact_share_channel",
  organization: "artifact_share_organization",
  public: "artifact_share_public",
} as const;

const stateSchema = object({
  version: literal(1),
  environment: string(),
  issuedAt: number().int(),
  workspaceId: string().min(1),
  slackUserId: string().min(1),
  channelId: string().min(1),
  messageTs: string().min(1),
  url: zUrl(),
  kind: zEnum(["file", "site"]),
  id: uuid(),
  userId: string().min(1),
  orgId: string().min(1),
});

export type SlackArtifactShareState = Omit<
  ReturnType<typeof stateSchema.parse>,
  "version" | "environment" | "issuedAt"
>;

function signature(payload: string): Buffer {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`slack-artifact-sharing-v1:${payload}`)
    .digest();
}

export function signSlackArtifactShare(state: SlackArtifactShareState): string {
  const payload = Buffer.from(
    JSON.stringify(
      stateSchema.parse({
        ...state,
        version: 1,
        environment: env("ENV"),
        issuedAt: now(),
      }),
    ),
  ).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function verifySlackArtifactShare(
  token: string,
): SlackArtifactShareState | null {
  const [payload, signed, extra] = token.split(".");
  if (!payload || !signed || extra !== undefined) {
    return null;
  }
  const expected = signature(payload);
  const actual = Buffer.from(signed, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }
  const parsed = stateSchema.safeParse(
    safeJsonParse(Buffer.from(payload, "base64url").toString()),
  );
  if (
    !parsed.success ||
    parsed.data.environment !== env("ENV") ||
    parsed.data.issuedAt > now() ||
    now() - parsed.data.issuedAt > 15 * 60_000
  ) {
    return null;
  }
  return parsed.data;
}

export function slackArtifactSharingBlocks(args: {
  readonly token: string;
  readonly url: string;
  readonly title: string;
  readonly audience: "private" | "organization";
  readonly missing: number;
  readonly unknown: number;
}): SlackKnownBlock[] {
  const text = [
    ...(args.missing > 0
      ? [
          `${args.missing} channel ${args.missing === 1 ? "member needs" : "members need"} access to this artifact.`,
        ]
      : []),
    ...(args.unknown > 0
      ? [
          `Access could not be confirmed for ${args.unknown} ${args.unknown === 1 ? "member" : "members"}.`,
        ]
      : []),
    ...(args.missing === 0 && args.unknown === 0
      ? ["Channel access could not be checked."]
      : []),
  ].join("\n");
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${escapeText(args.url.replaceAll("|", "%7C"))}|${escapeText(args.title).replaceAll("&nbsp;", "\u00a0").replaceAll("|", "¦")}>*\n${text}`,
        verbatim: true,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Share with current channel members",
          },
          style: "primary",
          action_id: SLACK_ARTIFACT_SHARE_ACTIONS.channel,
          value: args.token,
        },
        ...(args.audience === "private"
          ? [
              {
                type: "button" as const,
                text: {
                  type: "plain_text" as const,
                  text: "Share with workspace",
                },
                action_id: SLACK_ARTIFACT_SHARE_ACTIONS.organization,
                value: args.token,
              },
            ]
          : []),
        {
          type: "button",
          text: { type: "plain_text", text: "Make public" },
          action_id: SLACK_ARTIFACT_SHARE_ACTIONS.public,
          value: args.token,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: "Applies to current channel members. Later joins and departures do not change access.",
        },
      ],
    },
  ];
}
