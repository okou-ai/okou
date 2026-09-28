import { computed, type Computed } from "ccstate";
import { guaranteedConnectorProvidedBindingNames } from "@okouai/api-contracts/contracts/connector-schemas";
import type {
  TelegramBot,
  TelegramBotStatus,
  TelegramLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { telegramUserAgentPreferences } from "@okouai/db/schema/telegram-user-agent-preference";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { buildTelegramBotAvatarUrl } from "../external/telegram-avatar";
import { checkTelegramDomain } from "../external/telegram-domain";
import {
  getOfficialTelegramBotConfig,
  OFFICIAL_TELEGRAM_BOT_ID,
} from "../external/telegram-official";
import { safeUrlParse } from "../utils";
import { builtinConnectorList } from "./connector-data.service";
import { userSecrets, userVariables } from "./user-data.service";
import { userConfiguredAgentEnvironmentRequirements } from "./agent-execution-config";

type TelegramBotListItem = TelegramBot;
type TelegramConnectedUser = NonNullable<TelegramBot["connectedUser"]>;

function officialUserLink(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<TelegramConnectedUser | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [row] = await db
      .select({
        telegramUserId: telegramOfficialUserLinks.telegramUserId,
        telegramUsername: telegramOfficialUserLinks.telegramUsername,
        telegramDisplayName: telegramOfficialUserLinks.telegramDisplayName,
      })
      .from(telegramOfficialUserLinks)
      .where(
        and(
          eq(telegramOfficialUserLinks.userId, args.userId),
          eq(telegramOfficialUserLinks.orgId, args.orgId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

interface TelegramAgentRow {
  readonly id: string;
  readonly name: string;
}

function getOrgAgent(args: {
  readonly agentId: string | null;
  readonly orgId: string;
}): Computed<Promise<TelegramAgentRow | null>> {
  return computed(async (get) => {
    if (args.agentId === null) {
      return null;
    }
    const db = get(db$);
    const [row] = await db
      .select({
        id: agents.id,
        name: agents.name,
      })
      .from(agents)
      .where(and(eq(agents.id, args.agentId), eq(agents.orgId, args.orgId)))
      .limit(1);
    return row ?? null;
  });
}

function userAgentPreference(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<string | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [row] = await db
      .select({
        selectedAgentId: telegramUserAgentPreferences.selectedAgentId,
      })
      .from(telegramUserAgentPreferences)
      .where(
        and(
          eq(telegramUserAgentPreferences.userId, args.userId),
          eq(telegramUserAgentPreferences.orgId, args.orgId),
        ),
      )
      .limit(1);
    return row?.selectedAgentId ?? null;
  });
}

function defaultAgentId(args: {
  readonly orgId: string;
}): Computed<Promise<string | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [row] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    return row?.defaultAgentId ?? null;
  });
}

function officialCompose(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<
  Promise<{
    readonly agent: TelegramAgentRow | null;
    readonly usesDefaultAgent: boolean;
  }>
> {
  return computed(async (get) => {
    const selectedId = await get(userAgentPreference(args));
    if (selectedId) {
      const selected = await get(
        getOrgAgent({ agentId: selectedId, orgId: args.orgId }),
      );
      if (selected) {
        return { agent: selected, usesDefaultAgent: false };
      }
    }
    const defaultId = await get(defaultAgentId({ orgId: args.orgId }));
    if (!defaultId) {
      return { agent: null, usesDefaultAgent: true };
    }
    return {
      agent: await get(getOrgAgent({ agentId: defaultId, orgId: args.orgId })),
      usesDefaultAgent: true,
    };
  });
}

function buildOfficialTelegramBot(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<TelegramBotListItem>> {
  return computed(async (get): Promise<TelegramBotListItem> => {
    const config = getOfficialTelegramBotConfig();
    const [official, userLink] = await Promise.all([
      get(officialCompose(args)),
      get(officialUserLink(args)),
    ]);
    const hasAvatar = config.botToken !== null && config.botId !== null;
    return {
      id: OFFICIAL_TELEGRAM_BOT_ID,
      kind: "official",
      username: config.botUsername,
      avatarUrl: hasAvatar
        ? buildTelegramBotAvatarUrl(OFFICIAL_TELEGRAM_BOT_ID)
        : null,
      agent: official.agent
        ? { id: official.agent.id, name: official.agent.name }
        : null,
      isOwner: false,
      isConnected: userLink !== null,
      connectedUser: userLink,
      tokenStatus: config.botToken ? "valid" : "unknown",
      official: {
        configured: config.configured,
        usesDefaultAgent: official.usesDefaultAgent,
        linkedTelegramUserId: userLink?.telegramUserId ?? null,
      },
    };
  });
}

export function telegramBots(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly TelegramBotListItem[]>> {
  return computed(async (get): Promise<readonly TelegramBotListItem[]> => {
    return [await get(buildOfficialTelegramBot(args))];
  });
}

function telegramEnvironment(args: {
  readonly agent: TelegramAgentRow | null;
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<TelegramBotStatus["environment"]>> {
  return computed(async (get) => {
    const { secrets: requiredSecrets, vars: requiredVars } = args.agent
      ? userConfiguredAgentEnvironmentRequirements(args.agent.name)
      : { secrets: [], vars: [] };

    const [secretList, variableList, connectorState] = await Promise.all([
      get(userSecrets({ orgId: args.orgId, userId: args.userId })),
      get(userVariables({ orgId: args.orgId, userId: args.userId })),
      get(builtinConnectorList({ orgId: args.orgId, userId: args.userId })),
    ]);
    const existingSecretNames = new Set([
      ...secretList.secrets.map((secret) => {
        return secret.name;
      }),
      ...guaranteedConnectorProvidedBindingNames({
        bindings: connectorState.connectorProvidedBindings,
        namespace: "secrets",
      }),
    ]);
    const existingVarNames = new Set([
      ...variableList.variables.map((variable) => {
        return variable.name;
      }),
      ...guaranteedConnectorProvidedBindingNames({
        bindings: connectorState.connectorProvidedBindings,
        namespace: "vars",
      }),
    ]);

    return {
      requiredSecrets,
      requiredVars,
      missingSecrets: requiredSecrets.filter((name) => {
        return !existingSecretNames.has(name);
      }),
      missingVars: requiredVars.filter((name) => {
        return !existingVarNames.has(name);
      }),
    };
  });
}

function telegramLoginOrigin(): string {
  return new URL(env("APP_URL")).origin;
}

function officialTelegramBotStatus(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<TelegramBotStatus>> {
  return computed(async (get) => {
    const config = getOfficialTelegramBotConfig();
    const official = await get(officialCompose(args));
    const [bot, environment, domainConfigured] = await Promise.all([
      get(buildOfficialTelegramBot(args)),
      get(telegramEnvironment({ agent: official.agent, ...args })),
      config.botId
        ? checkTelegramDomain(config.botId, telegramLoginOrigin())
        : Promise.resolve(false),
    ]);

    return { ...bot, domainConfigured, environment };
  });
}

export function telegramIntegrationBots(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly TelegramBot[]>> {
  return computed(async (get): Promise<readonly TelegramBot[]> => {
    return [await get(buildOfficialTelegramBot(args))];
  });
}

export function telegramIntegrationBotStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly botId: string;
}): Computed<Promise<TelegramBotStatus | null>> {
  return computed(async (get) => {
    if (args.botId !== OFFICIAL_TELEGRAM_BOT_ID) {
      return null;
    }
    return await get(officialTelegramBotStatus(args));
  });
}

type TelegramLinkStatusResult =
  | { readonly status: 200; readonly body: TelegramLinkStatusResponse }
  | {
      readonly status: 403;
      readonly body: {
        readonly error: { readonly message: string; readonly code: string };
      };
    };

function resolveTelegramLoginOrigin(originParam: string | undefined): string {
  const brandedOrigin = telegramLoginOrigin();
  if (!originParam) {
    return brandedOrigin;
  }

  const originUrl = safeUrlParse(originParam);
  if (
    originUrl &&
    (originUrl.protocol === "http:" || originUrl.protocol === "https:") &&
    originUrl.origin === brandedOrigin
  ) {
    return originUrl.origin;
  }

  return brandedOrigin;
}

export function telegramIntegrationLinkStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly botId?: string;
  readonly origin?: string;
}): Computed<Promise<TelegramLinkStatusResult>> {
  return computed(async (get): Promise<TelegramLinkStatusResult> => {
    const telegramLoginOrigin = resolveTelegramLoginOrigin(args.origin);

    if (args.botId === OFFICIAL_TELEGRAM_BOT_ID) {
      const userLink = await get(officialUserLink(args));
      const config = getOfficialTelegramBotConfig();
      if (userLink) {
        return {
          status: 200,
          body: {
            linked: true,
            telegramUserId: userLink.telegramUserId,
            ...(config.botUsername ? { botUsername: config.botUsername } : {}),
          },
        };
      }

      if (!config.botUsername) {
        return { status: 200, body: { linked: false } };
      }

      const domainConfigured = config.botId
        ? await checkTelegramDomain(config.botId, telegramLoginOrigin)
        : false;
      return {
        status: 200,
        body: {
          linked: false,
          installation: {
            id: OFFICIAL_TELEGRAM_BOT_ID,
            botUsername: config.botUsername,
            ...(config.botId ? { loginBotId: config.botId } : {}),
            domainConfigured,
          },
        },
      };
    }

    return { status: 200, body: { linked: false } };
  });
}
