import { command } from "ccstate";
import {
  teamsBotContract,
  type TeamsInboundActivity,
} from "@okouai/api-contracts/contracts/teams-bot";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/brand-presentation";

import {
  normalizeTeamsActivity,
  readTeamsActivityChannelId,
  readTeamsActivityServiceUrl,
} from "../../lib/teams-bot-activity";
import { env } from "../../lib/env";
import { verifyTeamsBotAuthorization } from "../../lib/teams-bot-auth";
import { logger } from "../../lib/log";
import { teamsBotDisplayName } from "../../lib/teams-official-app";
import { authorization$, request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import {
  sendTeamsMessage,
  sendTeamsMessageReply,
  type TeamsAdaptiveCard,
  type TeamsMentionEntity,
} from "../external/teams-bot-client";
import { now } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import {
  buildTeamsConnectUrlForActivity,
  publishTeamsChanged$,
  recordTeamsInstallationActivity$,
} from "../services/teams-connect.service";
import {
  dispatchTeamsMessageToAgent$,
  teamsWelcomeText,
} from "../services/teams-dispatch.service";
import { ApiDispatchTimingCollector } from "../services/api-dispatch-timing.service";
import { safeJsonParse, tapError } from "../utils";

const L = logger("TeamsBot");
const TEAMS_SUPPORTED_COMMANDS_TEXT =
  "`help`, `connect`, `disconnect`, `switch`, `model`";

function errorResponse(
  status: 400 | 401 | 403 | 503,
  message: string,
  code: string,
) {
  return {
    status,
    body: {
      error: { message, code },
    },
  };
}

function authErrorCode(status: 401 | 403 | 503): string {
  if (status === 403) {
    return "FORBIDDEN";
  }
  if (status === 503) {
    return "PROVIDER_UNAVAILABLE";
  }
  return "UNAUTHORIZED";
}

function buildTeamsLoginPromptCard(args: {
  readonly connectUrl: string;
  readonly text: string;
}): TeamsAdaptiveCard {
  return {
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: args.text,
        wrap: true,
      },
    ],
    actions: [
      {
        type: "Action.OpenUrl",
        title: "Connect",
        url: args.connectUrl,
      },
    ],
  };
}

function queueUrl(): string {
  return `${env("APP_URL")}/?queue=1`;
}

function buildTeamsQueueText(url: string): string {
  return `\u26a0 Run queued -- concurrency limit reached. Will start automatically when a slot is available. [View queue](${url})`;
}

function buildTeamsQueueCard(args: {
  readonly url: string;
}): TeamsAdaptiveCard {
  return {
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "Run queued",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: "Concurrency limit reached. Will start automatically when a slot is available.",
        wrap: true,
      },
    ],
    actions: [
      {
        type: "Action.OpenUrl",
        title: "View queue",
        url: args.url,
      },
    ],
  };
}

type TeamsDispatchReplySource =
  | {
      readonly kind: "notice";
      readonly replyText: string;
      readonly connectUrl?: string;
      readonly card?: TeamsAdaptiveCard;
    }
  | { readonly kind: "queued" }
  | { readonly kind: "ignored" | "accepted" };

type TeamsMessageActivity = Extract<TeamsInboundActivity, { kind: "message" }>;
type TeamsInstallWelcomeActivity = Extract<
  TeamsInboundActivity,
  { kind: "installation_update" }
>;
type TeamsInstallation = typeof teamsOrgInstallations.$inferSelect;

function dispatchReplyContent(dispatch: TeamsDispatchReplySource): {
  readonly replyText: string | null;
  readonly card?: TeamsAdaptiveCard;
} {
  if (dispatch.kind === "notice") {
    return {
      replyText: dispatch.replyText,
      ...(dispatch.card
        ? { card: dispatch.card }
        : dispatch.connectUrl
          ? {
              card: buildTeamsLoginPromptCard({
                connectUrl: dispatch.connectUrl,
                text: dispatch.replyText,
              }),
            }
          : {}),
    };
  }
  if (dispatch.kind === "queued") {
    const url = queueUrl();
    return {
      replyText: buildTeamsQueueText(url),
      card: buildTeamsQueueCard({ url }),
    };
  }
  return { replyText: null };
}

function teamsInstallWelcomeActivity(
  activity: TeamsInboundActivity,
): TeamsInstallWelcomeActivity | null {
  return activity.kind === "installation_update" && activity.action === "add"
    ? activity
    : null;
}

function buildTeamsInstallWelcomeMention(
  activity: TeamsInstallWelcomeActivity,
  botName: string,
): TeamsMentionEntity | null {
  if (activity.conversationType === "personal" || activity.sender.id === "") {
    return null;
  }

  const name = activity.sender.name ?? `the person who added ${botName}`;
  return {
    type: "mention",
    text: `<at>${name}</at>`,
    mentioned: {
      id: activity.sender.id,
      name,
    },
  };
}

function buildTeamsInstallWelcomeContent(
  activity: TeamsInstallWelcomeActivity,
  installation: TeamsInstallation,
): {
  readonly text: string;
  readonly entities?: readonly TeamsMentionEntity[];
} {
  const { brandName } = PUBLIC_BRAND_PRESENTATION;
  const botName = teamsBotDisplayName(installation.botName);
  const mention = buildTeamsInstallWelcomeMention(activity, botName);
  if (!mention) {
    return { text: teamsWelcomeText(installation) };
  }

  return {
    text: [
      `${mention.text} added ${botName} to this Teams workspace.`,
      "",
      `${botName} connects Teams conversations to AI agents for research, triage, reports, engineering work, operations, and support.`,
      "",
      `To get started, use \`connect\` to link this Teams workspace to ${brandName}. An org admin may need to complete workspace setup first.`,
      "",
      `Commands: ${TEAMS_SUPPORTED_COMMANDS_TEXT}. Mention \`@${botName}\` with a task or send a DM to work privately.`,
    ].join("\n"),
    entities: [mention],
  };
}

const sendTeamsInstallWelcome$ = command(
  async (
    _,
    args: {
      readonly activity: TeamsInboundActivity;
      readonly installation: TeamsInstallation;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const welcomeActivity = teamsInstallWelcomeActivity(args.activity);
    if (!welcomeActivity) {
      return;
    }

    const welcome = buildTeamsInstallWelcomeContent(
      welcomeActivity,
      args.installation,
    );
    const reply = await sendTeamsMessage(
      {
        serviceUrl: welcomeActivity.serviceUrl,
        conversationId: welcomeActivity.conversationId,
        tenantId: welcomeActivity.tenantId,
        text: welcome.text,
        ...(welcome.entities ? { entities: welcome.entities } : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    if (reply.kind === "teams-error") {
      L.warn("Teams install welcome failed", {
        tenantId: welcomeActivity.tenantId,
        conversationId: welcomeActivity.conversationId,
        status: reply.status,
        error: reply.error,
      });
    }
  },
);

const dispatchTeamsMessageAndReply$ = command(
  async (
    { set },
    args: {
      readonly activity: TeamsMessageActivity;
      readonly installation: TeamsInstallation | null;
      readonly apiStartTime: number;
      readonly timing: ApiDispatchTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const dispatch = await set(
      dispatchTeamsMessageToAgent$,
      {
        activity: args.activity,
        installation: args.installation,
        apiStartTime: args.apiStartTime,
        timing: args.timing,
      },
      signal,
    );
    signal.throwIfAborted();

    const { replyText, card } = dispatchReplyContent(dispatch);
    if (!replyText) {
      return;
    }

    const reply = await sendTeamsMessageReply(
      {
        serviceUrl: args.activity.serviceUrl,
        conversationId: args.activity.conversationId,
        activityId: args.activity.activityId ?? undefined,
        tenantId: args.activity.tenantId,
        text: replyText,
        ...(card ? { card } : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    if (reply.kind === "teams-error") {
      L.warn("Teams dispatch reply failed", {
        tenantId: args.activity.tenantId,
        conversationId: args.activity.conversationId,
        activityId: args.activity.activityId,
        status: reply.status,
        error: reply.error,
      });
    }
  },
);

const handleTeamsBot$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  const apiStartTime = now();
  const bodyText = await request.text();
  signal.throwIfAborted();

  const body = safeJsonParse(bodyText);
  const normalized = normalizeTeamsActivity(body);
  if (!normalized.ok) {
    return errorResponse(400, normalized.error, "BAD_REQUEST");
  }

  const serviceUrl =
    normalized.activity.kind === "unsupported"
      ? readTeamsActivityServiceUrl(body)
      : normalized.activity.serviceUrl;
  if (!serviceUrl) {
    return errorResponse(
      400,
      "Missing Teams activity serviceUrl",
      "BAD_REQUEST",
    );
  }

  const auth = await verifyTeamsBotAuthorization(
    {
      authorization: get(authorization$),
      serviceUrl,
      channelId: readTeamsActivityChannelId(body),
    },
    signal,
  );
  signal.throwIfAborted();

  if (!auth.ok) {
    return errorResponse(auth.status, auth.message, authErrorCode(auth.status));
  }

  const activityResult = await set(
    recordTeamsInstallationActivity$,
    { activity: normalized.activity },
    signal,
  );
  signal.throwIfAborted();

  if (activityResult.kind === "removed" && activityResult.orgId) {
    await set(
      publishTeamsChanged$,
      { orgId: activityResult.orgId, userIds: activityResult.userIds },
      signal,
    );
    signal.throwIfAborted();
  }
  if (activityResult.kind === "upserted" && activityResult.installation.orgId) {
    await set(
      publishTeamsChanged$,
      { orgId: activityResult.installation.orgId },
      signal,
    );
    signal.throwIfAborted();
  }

  const installation =
    activityResult.kind === "upserted" ? activityResult.installation : null;
  const timing = new ApiDispatchTimingCollector();
  timing.recordElapsed(
    "api_dispatch_pre_create_agent_teams_entrypoint_gap",
    "nested",
    apiStartTime,
  );
  if (normalized.activity.kind === "message") {
    waitUntil(
      tapError(
        set(
          dispatchTeamsMessageAndReply$,
          {
            activity: normalized.activity,
            installation,
            apiStartTime,
            timing,
          },
          signal,
        ),
        (error) => {
          L.error("Error handling Teams message activity", { error });
        },
      ),
    );
  }

  if (
    teamsInstallWelcomeActivity(normalized.activity) &&
    activityResult.kind === "upserted"
  ) {
    waitUntil(
      tapError(
        set(
          sendTeamsInstallWelcome$,
          {
            activity: normalized.activity,
            installation: activityResult.installation,
          },
          signal,
        ),
        (error) => {
          L.error("Error sending Teams install welcome", { error });
        },
      ),
    );
  }

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      activity: normalized.activity,
      connectUrl: buildTeamsConnectUrlForActivity({
        activity: normalized.activity,
        installation,
      }),
    },
  };
});

export const teamsBotRoutes: readonly RouteEntry[] = [
  {
    route: teamsBotContract.post,
    handler: handleTeamsBot$,
  },
];
