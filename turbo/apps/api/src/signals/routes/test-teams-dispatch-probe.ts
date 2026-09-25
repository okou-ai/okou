import { command } from "ccstate";
import {
  testTeamsDispatchProbeContract,
  type TestTeamsDispatchProbeBody,
} from "@okouai/api-contracts/contracts/test-teams-dispatch-probe";
import type { TeamsInboundActivity } from "@okouai/api-contracts/contracts/teams-bot";

import { now } from "../../lib/time";
import { request$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import { safeJsonParse, settle } from "../utils";
import { ApiDispatchTimingCollector } from "../services/api-dispatch-timing.service";
import { dispatchTeamsMessageToAgent$ } from "../services/teams-dispatch.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const DEFAULT_SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const DEFAULT_BOT_ID = "28:e2e-okou-bot";
const DEFAULT_BOT_NAME = "Okou";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return optionalString(value);
}

function optionalConversationType(
  value: unknown,
): "personal" | "channel" | undefined {
  return value === "personal" || value === "channel" ? value : undefined;
}

function parseProbeBody(value: unknown): TestTeamsDispatchProbeBody | null {
  if (!isRecord(value)) {
    return null;
  }
  const tenantId = optionalString(value.tenant_id);
  const conversationId = optionalString(value.conversation_id);
  const teamsUserId = optionalString(value.teams_user_id);
  const messageText = optionalString(value.message_text);
  if (!tenantId || !conversationId || !teamsUserId || !messageText) {
    return null;
  }
  return {
    tenant_id: tenantId,
    conversation_id: conversationId,
    teams_user_id: teamsUserId,
    message_text: messageText,
    service_url: optionalString(value.service_url),
    tenant_name: optionalNullableString(value.tenant_name),
    team_id: optionalNullableString(value.team_id),
    team_name: optionalNullableString(value.team_name),
    channel_id: optionalNullableString(value.channel_id),
    conversation_type: optionalConversationType(value.conversation_type),
    activity_id: optionalNullableString(value.activity_id),
    thread_id: optionalString(value.thread_id),
    teams_aad_object_id: optionalNullableString(value.teams_aad_object_id),
    teams_user_display_name: optionalNullableString(
      value.teams_user_display_name,
    ),
    teams_user_principal_name: optionalNullableString(
      value.teams_user_principal_name,
    ),
    bot_id: optionalNullableString(value.bot_id),
    bot_name: optionalNullableString(value.bot_name),
  };
}

function buildActivity(body: TestTeamsDispatchProbeBody): TeamsInboundActivity {
  const conversationType = body.conversation_type ?? "personal";
  const activityId =
    body.activity_id === undefined
      ? `activity-${Math.floor(now())}`
      : body.activity_id;
  const threadId = body.thread_id ?? activityId ?? "root";
  return {
    kind: "message",
    activityId,
    tenantId: body.tenant_id,
    tenantName: body.tenant_name ?? null,
    teamsAppId: null,
    serviceUrl: body.service_url ?? DEFAULT_SERVICE_URL,
    conversationId: body.conversation_id,
    conversationType,
    teamId: body.team_id ?? null,
    teamAadGroupId: body.team_id ?? null,
    teamName: body.team_name ?? null,
    channelId: body.channel_id ?? null,
    timestamp: new Date(now()).toISOString(),
    idempotencyKey: `${body.conversation_id}:message:${activityId ?? "probe"}`,
    threadId,
    sender: {
      id: body.teams_user_id,
      name: body.teams_user_display_name ?? "E2E Teams User",
      aadObjectId: body.teams_aad_object_id ?? null,
      userPrincipalName: body.teams_user_principal_name ?? null,
    },
    recipient: {
      id: body.bot_id ?? DEFAULT_BOT_ID,
      name: body.bot_name ?? DEFAULT_BOT_NAME,
      aadObjectId: null,
      userPrincipalName: null,
    },
    rawText: body.message_text,
    text: body.message_text,
    value: null,
    mentionsRecipient: conversationType !== "personal",
    attachments: [],
  };
}

function handlerErrorBody(error: unknown): {
  readonly ok: false;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly stack?: string;
  };
} {
  const known = error instanceof Error ? error : new Error(String(error));
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  return {
    ok: false,
    error: {
      name: known.name,
      message: known.message,
      code,
      stack: known.stack?.split("\n").slice(0, 10).join("\n"),
    },
  };
}

const postTestTeamsDispatchProbe$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$);
    if (!isTestEndpointAllowed(request)) {
      return testEndpointNotFoundResponse();
    }

    const rawBody = await request.raw.clone().text();
    signal.throwIfAborted();
    const parsed = rawBody.length === 0 ? null : safeJsonParse(rawBody);
    const body = parseProbeBody(parsed);
    if (!body) {
      return {
        status: 400 as const,
        body: {
          error:
            "tenant_id, conversation_id, teams_user_id, and message_text are required",
        },
      };
    }

    const activity = buildActivity(body);
    const apiStartTime = now();
    const dispatch = await settle(
      set(
        dispatchTeamsMessageToAgent$,
        {
          activity,
          apiStartTime,
          timing: new ApiDispatchTimingCollector(),
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!dispatch.ok) {
      return { status: 200 as const, body: handlerErrorBody(dispatch.error) };
    }

    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const testTeamsDispatchProbeRoutes: readonly RouteEntry[] = [
  {
    route: testTeamsDispatchProbeContract.post,
    handler: postTestTeamsDispatchProbe$,
  },
];
