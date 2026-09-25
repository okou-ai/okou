import { command } from "ccstate";
import { eq } from "drizzle-orm";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  integrationsTelegramContract,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { agents } from "@okouai/db/schema/agent";
import { telegramInstallations } from "@okouai/db/schema/telegram-installation";
import { telegramUserAgentPreferences } from "@okouai/db/schema/telegram-user-agent-preference";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishOrgSignal, publishUserSignal } from "../external/realtime";
import { deleteWebhook } from "../external/telegram-client";
import { decryptPersistentSecretValue } from "../services/crypto.utils";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { telegramIntegrationBotStatus } from "../services/telegram-data.service";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { bestEffort, tapError } from "../utils";
import type { RouteEntry } from "../route-entry";

const log = logger("api:telegram:integration-bot");

interface TelegramRouteAuth {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole?: "admin" | "member";
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

const updateCustomBot$ = command(
  async (
    { get, set },
    args: {
      readonly auth: TelegramRouteAuth;
      readonly botId: string;
      readonly defaultAgentId: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);

    const [installation] = await writeDb
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, args.botId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation || installation.orgId !== args.auth.orgId) {
      return notFoundResponse();
    }

    if (
      installation.ownerUserId !== args.auth.userId &&
      args.auth.orgRole !== "admin"
    ) {
      return forbiddenResponse(
        "Only the bot owner or an org admin can change the default agent",
      );
    }

    const [compose] = await writeDb
      .select({ id: agents.id, orgId: agents.orgId })
      .from(agents)
      .where(eq(agents.id, args.defaultAgentId))
      .limit(1);
    signal.throwIfAborted();

    if (!compose) {
      return notFoundResponse("Agent not found");
    }
    if (compose.orgId !== installation.orgId) {
      return forbiddenResponse(
        "Telegram bots can only be connected to agents in the bot's organization",
      );
    }

    await writeDb
      .update(telegramInstallations)
      .set({ defaultAgentId: compose.id, updatedAt: nowDate() })
      .where(
        eq(telegramInstallations.telegramBotId, installation.telegramBotId),
      );
    signal.throwIfAborted();

    await bestEffort(
      publishOrgSignal(installation.orgId, "telegram:changed"),
      signal,
    );
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

  if (!bodyResult.data.defaultAgentId) {
    return badRequestResponse("defaultAgentId is required");
  }

  return await set(
    updateCustomBot$,
    {
      auth,
      botId,
      defaultAgentId: bodyResult.data.defaultAgentId,
    },
    signal,
  );
});

const disconnectInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { botId } = get(pathParamsOf(integrationsTelegramContract.disconnect));

  if (botId === OFFICIAL_TELEGRAM_BOT_ID) {
    return forbiddenResponse("The official Telegram bot cannot be uninstalled");
  }

  const writeDb = set(writeDb$);
  const [installation] = await writeDb
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, botId))
    .limit(1);
  signal.throwIfAborted();

  if (!installation || installation.orgId !== auth.orgId) {
    return notFoundResponse();
  }

  if (installation.ownerUserId !== auth.userId && auth.orgRole !== "admin") {
    return forbiddenResponse(
      "Only the bot owner or an org admin can uninstall this bot",
    );
  }

  const botToken = await decryptPersistentSecretValue(
    installation.encryptedBotToken,
    await get(
      userFeatureSwitchContext(installation.orgId, installation.ownerUserId),
    ),
  );
  signal.throwIfAborted();
  await tapError(deleteWebhook(botToken), (error) => {
    log.warn("Failed to remove Telegram webhook", { error });
  });
  signal.throwIfAborted();

  await writeDb
    .delete(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, installation.telegramBotId));
  signal.throwIfAborted();

  await bestEffort(
    publishOrgSignal(installation.orgId, "telegram:changed"),
    signal,
  );
  signal.throwIfAborted();

  return { status: 204 as const, body: undefined };
});

export const integrationsTelegramBotIdRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTelegramContract.updateBot,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateBotInner$,
    ),
  },
  {
    route: integrationsTelegramContract.disconnect,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      disconnectInner$,
    ),
  },
];
