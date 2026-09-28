import { command } from "ccstate";
import { eq } from "drizzle-orm";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  integrationsTelegramContract,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { agents } from "@okouai/db/schema/agent";
import { telegramUserAgentPreferences } from "@okouai/db/schema/telegram-user-agent-preference";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { telegramIntegrationBotStatus } from "../services/telegram-data.service";
import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";

interface TelegramRouteAuth {
  readonly userId: string;
  readonly orgId: string;
}

function badRequestResponse(message: string) {
  return {
    status: 400 as const,
    body: { error: { message, code: "BAD_REQUEST" as const } },
  };
}

function notFoundResponse(message = "Telegram bot not found") {
  return {
    status: 404 as const,
    body: {
      error: { message, code: "NOT_FOUND" as const },
    },
  };
}

function forbiddenResponse(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

const updateOfficialBot$ = command(
  async (
    { get, set },
    args: {
      readonly auth: TelegramRouteAuth;
      readonly botId: string;
      readonly selectedAgentId: string | null;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);

    if (args.selectedAgentId) {
      const [compose] = await writeDb
        .select({ id: agents.id, orgId: agents.orgId })
        .from(agents)
        .where(eq(agents.id, args.selectedAgentId))
        .limit(1);
      signal.throwIfAborted();

      if (!compose) {
        return notFoundResponse("Agent not found");
      }
      if (compose.orgId !== args.auth.orgId) {
        return forbiddenResponse(
          "Telegram official bot preferences can only use agents in the active organization",
        );
      }
    }

    await writeDb
      .insert(telegramUserAgentPreferences)
      .values({
        userId: args.auth.userId,
        orgId: args.auth.orgId,
        selectedAgentId: args.selectedAgentId,
      })
      .onConflictDoUpdate({
        target: [
          telegramUserAgentPreferences.userId,
          telegramUserAgentPreferences.orgId,
        ],
        set: {
          selectedAgentId: args.selectedAgentId,
          updatedAt: nowDate(),
        },
      });
    signal.throwIfAborted();

    await publishUserSignal([args.auth.userId], "telegram:changed");
    signal.throwIfAborted();

    const status = await get(
      telegramIntegrationBotStatus({
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        botId: args.botId,
      }),
    );
    signal.throwIfAborted();
    if (!status) {
      return notFoundResponse();
    }
    return { status: 200 as const, body: status };
  },
);

const updateBotInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { botId } = get(pathParamsOf(integrationsTelegramContract.updateBot));
  const bodyResult = await get(
    bodyResultOf(integrationsTelegramContract.updateBot),
  );
  signal.throwIfAborted();

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  if (botId === OFFICIAL_TELEGRAM_BOT_ID) {
    if (!("selectedAgentId" in bodyResult.data)) {
      return badRequestResponse("selectedAgentId is required");
    }

    return await set(
      updateOfficialBot$,
      {
        auth,
        botId,
        selectedAgentId: bodyResult.data.selectedAgentId ?? null,
      },
      signal,
    );
  }

  return notFoundResponse();
});

export const integrationsTelegramBotIdRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTelegramContract.updateBot,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateBotInner$,
    ),
  },
];
