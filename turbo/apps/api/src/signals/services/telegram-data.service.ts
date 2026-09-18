import { computed, type Computed } from "ccstate";
import { guaranteedConnectorProvidedBindingNames } from "@okouai/api-contracts/contracts/connector-schemas";
import type {
  TelegramBot,
  TelegramBotStatus,
  TelegramLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { telegramInstallations } from "@okouai/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { telegramUserLinks } from "@okouai/db/schema/telegram-user-link";
import { telegramUserAgentPreferences } from "@okouai/db/schema/telegram-user-agent-preference";
import { and, desc, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { buildTelegramBotAvatarUrl } from "../external/telegram-avatar";
import { checkTelegramDomain } from "../external/telegram-domain";
import { getMe, isTelegramApiError } from "../external/telegram-client";
import {
  getOfficialTelegramBotConfig,
  OFFICIAL_TELEGRAM_BOT_ID,
} from "../external/telegram-official";
import { safeUrlParse, settle } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { builtinConnectorList } from "./connector-data.service";
import { userSecrets, userVariables } from "./user-data.service";
import { userConfiguredAgentEnvironmentRequirements } from "./agent-execution-config";

type TelegramBotListItem = TelegramBot;
type TelegramInstallationRow = typeof telegramInstallations.$inferSelect;
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
    const db = get(db$);

    const installations = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.orgId, args.orgId))
      .orderBy(
        desc(telegramInstallations.createdAt),
        desc(telegramInstallations.telegramBotId),
      );

    const customBots: TelegramBotListItem[] = await Promise.all(
      installations.map((installation) => {
        return get(customTelegramBot({ installation, userId: args.userId }));
      }),
    );

    const official = await get(buildOfficialTelegramBot(args));
    return [official, ...customBots];
  });
}

function telegramUserLink(args: {
  readonly botId: string;
  readonly userId: string;
}): Computed<Promise<TelegramConnectedUser | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [row] = await db
      .select({
        telegramUserId: telegramUserLinks.telegramUserId,
        telegramUsername: telegramUserLinks.telegramUsername,
        telegramDisplayName: telegramUserLinks.telegramDisplayName,
      })
      .from(telegramUserLinks)
      .where(
        and(
          eq(telegramUserLinks.installationId, args.botId),
          eq(telegramUserLinks.userId, args.userId),
        ),
      )
      .limit(1);
    return row ?? null;
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

function customTelegramBot(args: {
  readonly installation: TelegramInstallationRow;
  readonly userId: string;
}): Computed<Promise<TelegramBot>> {
  return computed(async (get) => {
    const [agent, userLink, tokenStatus] = await Promise.all([
      get(
        getOrgAgent({
          agentId: args.installation.defaultAgentId,
          orgId: args.installation.orgId,
        }),
      ),
      get(
        telegramUserLink({
          botId: args.installation.telegramBotId,
          userId: args.userId,
        }),
      ),
      resolveIntegrationTokenStatus(
        args.installation,
        await get(
          userFeatureSwitchContext(
            args.installation.orgId,
            args.installation.ownerUserId,
          ),
        ),
      ),
    ]);

    return {
      id: args.installation.telegramBotId,
      username: args.installation.botUsername,
      avatarUrl: buildTelegramBotAvatarUrl(args.installation.telegramBotId),
      agent: agent ? { id: agent.id, name: agent.name } : null,
      isOwner: args.installation.ownerUserId === args.userId,
      isConnected: userLink !== null,
      connectedUser: userLink,
      tokenStatus,
    };
  });
}

function telegramLoginOrigin(): string {
  return new URL(env("APP_URL")).origin;
}

function customTelegramBotStatus(args: {
  readonly installation: TelegramInstallationRow;
  readonly userId: string;
  readonly publicBrand: PublicBrand;
}): Computed<Promise<TelegramBotStatus>> {
  return computed(async (get) => {
    const agent = await get(
      getOrgAgent({
        agentId: args.installation.defaultAgentId,
        orgId: args.installation.orgId,
      }),
    );
    const [bot, environment, domainConfigured] = await Promise.all([
      get(customTelegramBot(args)),
      get(
        telegramEnvironment({
          agent,
          orgId: args.installation.orgId,
          userId: args.userId,
        }),
      ),
      checkTelegramDomain(
        args.installation.telegramBotId,
        telegramLoginOrigin(),
      ),
    ]);

    return { ...bot, domainConfigured, environment };
  });
}

function officialTelegramBotStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly publicBrand: PublicBrand;
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
    const db = get(db$);
    const installations = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.orgId, args.orgId))
      .orderBy(
        desc(telegramInstallations.createdAt),
        desc(telegramInstallations.telegramBotId),
      );

    const customBots = await Promise.all(
      installations.map((installation) => {
        return get(customTelegramBot({ installation, userId: args.userId }));
      }),
    );
    const official = await get(buildOfficialTelegramBot(args));
    return [official, ...customBots];
  });
}

export function telegramIntegrationBotStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly botId: string;
  readonly publicBrand: PublicBrand;
}): Computed<Promise<TelegramBotStatus | null>> {
  return computed(async (get) => {
    if (args.botId === OFFICIAL_TELEGRAM_BOT_ID) {
      return await get(officialTelegramBotStatus(args));
    }

    const db = get(db$);
    const [installation] = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, args.botId))
      .limit(1);

    if (!installation || installation.orgId !== args.orgId) {
      return null;
    }

    return await get(
      customTelegramBotStatus({
        installation,
        userId: args.userId,
        publicBrand: args.publicBrand,
      }),
    );
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

function orgMismatchResult(): TelegramLinkStatusResult {
  return {
    status: 403,
    body: {
      error: {
        message:
          "This Telegram bot belongs to a different organization. Switch to the bot's organization to connect.",
        code: "FORBIDDEN",
      },
    },
  };
}

export function telegramIntegrationLinkStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly botId?: string;
  readonly origin?: string;
  readonly publicBrand: PublicBrand;
}): Computed<Promise<TelegramLinkStatusResult>> {
  return computed(async (get): Promise<TelegramLinkStatusResult> => {
    const db = get(db$);
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

    const [userLink] = await db
      .select({
        telegramUserId: telegramUserLinks.telegramUserId,
        botUsername: telegramInstallations.botUsername,
      })
      .from(telegramUserLinks)
      .innerJoin(
        telegramInstallations,
        eq(
          telegramUserLinks.installationId,
          telegramInstallations.telegramBotId,
        ),
      )
      .where(
        and(
          eq(telegramUserLinks.userId, args.userId),
          eq(telegramInstallations.orgId, args.orgId),
          args.botId
            ? eq(telegramUserLinks.installationId, args.botId)
            : undefined,
        ),
      )
      .orderBy(desc(telegramUserLinks.createdAt))
      .limit(1);

    if (userLink) {
      return {
        status: 200,
        body: {
          linked: true,
          telegramUserId: userLink.telegramUserId,
          botUsername: userLink.botUsername ?? undefined,
        },
      };
    }

    if (args.botId) {
      const [installation] = await db
        .select({
          telegramBotId: telegramInstallations.telegramBotId,
          botUsername: telegramInstallations.botUsername,
          orgId: telegramInstallations.orgId,
        })
        .from(telegramInstallations)
        .where(eq(telegramInstallations.telegramBotId, args.botId))
        .limit(1);

      if (installation) {
        if (installation.orgId !== args.orgId) {
          return orgMismatchResult();
        }
        if (!installation.botUsername) {
          return { status: 200, body: { linked: false } };
        }

        const domainConfigured = await checkTelegramDomain(
          installation.telegramBotId,
          telegramLoginOrigin,
        );
        return {
          status: 200,
          body: {
            linked: false,
            installation: {
              id: installation.telegramBotId,
              botUsername: installation.botUsername,
              loginBotId: installation.telegramBotId,
              domainConfigured,
            },
          },
        };
      }
    }

    return { status: 200, body: { linked: false } };
  });
}

export function telegramInstallation(args: {
  readonly orgId: string;
  readonly botId: string;
}): Computed<
  Promise<{
    readonly botToken: string;
    readonly botUsername: string | null;
  } | null>
> {
  return computed(async (get) => {
    const db = get(db$);

    const [row] = await db
      .select({
        encryptedBotToken: telegramInstallations.encryptedBotToken,
        botUsername: telegramInstallations.botUsername,
        ownerUserId: telegramInstallations.ownerUserId,
      })
      .from(telegramInstallations)
      .where(
        and(
          eq(telegramInstallations.telegramBotId, args.botId),
          eq(telegramInstallations.orgId, args.orgId),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      botToken: await decryptPersistentSecretValue(
        row.encryptedBotToken,
        await get(userFeatureSwitchContext(args.orgId, row.ownerUserId)),
      ),
      botUsername: row.botUsername ?? null,
    };
  });
}

export function telegramBotToken(args: {
  readonly botId: string;
  readonly orgId?: string;
}): Computed<
  Promise<{
    readonly botToken: string;
    readonly botUsername: string | null;
  } | null>
> {
  return computed(async (get) => {
    const db = get(db$);
    const [row] = await db
      .select({
        encryptedBotToken: telegramInstallations.encryptedBotToken,
        botUsername: telegramInstallations.botUsername,
        ownerUserId: telegramInstallations.ownerUserId,
        orgId: telegramInstallations.orgId,
      })
      .from(telegramInstallations)
      .where(
        and(
          eq(telegramInstallations.telegramBotId, args.botId),
          args.orgId ? eq(telegramInstallations.orgId, args.orgId) : undefined,
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      botToken: await decryptPersistentSecretValue(
        row.encryptedBotToken,
        await get(userFeatureSwitchContext(row.orgId, row.ownerUserId)),
      ),
      botUsername: row.botUsername ?? null,
    };
  });
}

function isInvalidTelegramTokenError(error: unknown): boolean {
  if (!isTelegramApiError(error)) {
    return false;
  }

  return (
    error.status === 401 ||
    /unauthorized|not found/i.test(error.description ?? "")
  );
}

async function resolveIntegrationTokenStatus(
  installation: TelegramInstallationRow,
  featureSwitchContext: FeatureSwitchContext,
): Promise<TelegramBot["tokenStatus"]> {
  const token = await decryptPersistentSecretValue(
    installation.encryptedBotToken,
    featureSwitchContext,
  );
  const result = await settle(getMe(token));

  if (!result.ok) {
    if (isInvalidTelegramTokenError(result.error)) {
      return "invalid";
    }
    return "unknown";
  }

  if (String(result.value.id) !== installation.telegramBotId) {
    return "invalid";
  }
  return "valid";
}
