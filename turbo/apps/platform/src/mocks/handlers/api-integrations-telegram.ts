import {
  integrationsTelegramContract,
  type TelegramBot,
  type TelegramLinkStatusResponse,
  type TelegramListResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import type { z } from "zod";
import { mockApi } from "../msw-contract.ts";

export type MockTelegramBotStatus = z.infer<
  (typeof integrationsTelegramContract.updateBot.responses)[200]
>;
type TelegramBotStatus = MockTelegramBotStatus;

type TelegramConnectedUser = NonNullable<TelegramBot["connectedUser"]>;

const defaultTelegramConnectedUser: TelegramConnectedUser = {
  telegramUserId: "99002",
  telegramUsername: "test_user",
  telegramDisplayName: "Test User",
};

const defaultTelegramBots: TelegramBot[] = [
  {
    id: "bot_123",
    username: "test_bot",
    avatarUrl: null,
    agent: { id: "compose_1", name: "default-agent" },
    isOwner: true,
    isConnected: true,
    connectedUser: defaultTelegramConnectedUser,
    tokenStatus: "valid",
  },
];

const defaultTelegramStatus: TelegramBotStatus = {
  ...defaultTelegramBots[0]!,
  domainConfigured: false,
  environment: {
    requiredSecrets: ["ANTHROPIC_API_KEY"],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  },
};

let mockTelegramList: TelegramListResponse = {
  bots: structuredClone(defaultTelegramBots),
};
let mockTelegramStatuses: Record<string, TelegramBotStatus> = {
  [defaultTelegramStatus.id]: structuredClone(defaultTelegramStatus),
};

// Default link-status: unlinked with no installation. Tests that need the
// linked (telegramUserId) or unlinked-with-installation variants should
// override this handler via server.use(mockApi(integrationsTelegramContract.getLinkStatus, ...)).
let mockLinkStatus: TelegramLinkStatusResponse = { linked: false };

function formatTelegramAuthDisplayName(
  auth: { first_name?: string; last_name?: string } | undefined,
): string | null {
  if (!auth) {
    return null;
  }
  const displayName = [auth.first_name, auth.last_name]
    .filter((value): value is string => {
      return Boolean(value?.trim());
    })
    .join(" ");
  return displayName || null;
}

function statusToBot(status: TelegramBotStatus): TelegramBot {
  return {
    id: status.id,
    kind: status.kind,
    username: status.username,
    avatarUrl: status.avatarUrl,
    agent: status.agent,
    isOwner: status.isOwner,
    isConnected: status.isConnected,
    connectedUser: status.connectedUser,
    tokenStatus: status.tokenStatus,
    official: status.official,
  };
}

function setMockTelegramStatuses(statuses: TelegramBotStatus[]): void {
  mockTelegramStatuses = Object.fromEntries(
    statuses.map((status) => {
      return [status.id, structuredClone(status)];
    }),
  );
  mockTelegramList = {
    bots: statuses.map((status) => {
      return structuredClone(statusToBot(status));
    }),
  };
}

function updateMockBotConnection(
  botId: string,
  connected: boolean,
  connectedUser?: TelegramConnectedUser,
): void {
  const status = mockTelegramStatuses[botId];
  if (!status) {
    return;
  }
  const nextConnectedUser = connected
    ? (connectedUser ?? status.connectedUser ?? defaultTelegramConnectedUser)
    : null;
  mockTelegramStatuses[botId] = {
    ...status,
    isConnected: connected,
    connectedUser: nextConnectedUser,
  };
  mockTelegramList.bots = mockTelegramList.bots.map((bot) => {
    return bot.id === botId
      ? { ...bot, isConnected: connected, connectedUser: nextConnectedUser }
      : bot;
  });
}

export function resetMockTelegramIntegration(): void {
  setMockTelegramStatuses([defaultTelegramStatus]);
  mockLinkStatus = { linked: false };
}

export function setMockTelegramIntegration(input: {
  statuses?: TelegramBotStatus[];
  linkStatus?: TelegramLinkStatusResponse;
}): void {
  if (input.statuses) {
    setMockTelegramStatuses(input.statuses);
  }
  if (input.linkStatus) {
    mockLinkStatus = structuredClone(input.linkStatus);
  }
}

export const apiIntegrationsTelegramHandlers = [
  mockApi(integrationsTelegramContract.list, ({ respond }) => {
    return respond(200, mockTelegramList);
  }),

  mockApi(
    integrationsTelegramContract.updateBot,
    ({ params, body, respond }) => {
      const status = mockTelegramStatuses[params.botId];
      if (!status) {
        return respond(404, {
          error: { message: "Telegram bot not found", code: "NOT_FOUND" },
        });
      }
      const nextAgentId =
        body.defaultAgentId ?? body.selectedAgentId ?? status.agent?.id;
      const agent = nextAgentId
        ? { id: nextAgentId, name: "default-agent" }
        : status.agent;
      mockTelegramStatuses[status.id] = {
        ...status,
        agent,
        official: status.official
          ? {
              ...status.official,
              usesDefaultAgent: body.selectedAgentId === null,
            }
          : status.official,
      };
      mockTelegramList.bots = mockTelegramList.bots.map((bot) => {
        return bot.id === status.id
          ? statusToBot(mockTelegramStatuses[status.id]!)
          : bot;
      });
      return respond(200, mockTelegramStatuses[status.id]!);
    },
  ),

  mockApi(integrationsTelegramContract.getLinkStatus, ({ query, respond }) => {
    if (query.botId) {
      const status = mockTelegramStatuses[query.botId];
      if (status?.isConnected) {
        return respond(200, {
          linked: true,
          telegramUserId: mockLinkStatus.linked
            ? mockLinkStatus.telegramUserId
            : "99002",
          botUsername: status.username ?? undefined,
        });
      }
      if (status) {
        return respond(200, {
          linked: false,
          installation: {
            id: status.id,
            botUsername: status.username ?? "telegram_bot",
            domainConfigured: status.domainConfigured,
          },
        });
      }
    }

    if (mockLinkStatus.linked) {
      return respond(200, {
        ...mockLinkStatus,
        botUsername:
          Object.values(mockTelegramStatuses).find((status) => {
            return status.isConnected;
          })?.username ?? undefined,
      });
    }

    return respond(200, mockLinkStatus);
  }),

  mockApi(integrationsTelegramContract.link, ({ body, respond }) => {
    const status = mockTelegramStatuses[body.telegramBotId];
    if (!status) {
      return respond(404, {
        error: { message: "Installation not found", code: "NOT_FOUND" },
      });
    }
    const telegramUserId =
      body.connectSignature?.telegramUserId ?? String(body.telegramAuth?.id);
    const connectedUser: TelegramConnectedUser = {
      telegramUserId,
      telegramUsername:
        body.connectSignature?.telegramUsername ??
        body.telegramAuth?.username ??
        null,
      telegramDisplayName:
        body.connectSignature?.telegramDisplayName ??
        formatTelegramAuthDisplayName(body.telegramAuth),
    };
    updateMockBotConnection(body.telegramBotId, true, connectedUser);
    mockLinkStatus = { linked: true, telegramUserId };
    return respond(200, {
      botUsername: status.username ?? "telegram_bot",
      telegramUserId,
    });
  }),

  mockApi(integrationsTelegramContract.unlink, ({ query, respond }) => {
    if (query.botId) {
      updateMockBotConnection(query.botId, false);
    } else {
      for (const botId of Object.keys(mockTelegramStatuses)) {
        updateMockBotConnection(botId, false);
      }
    }
    mockLinkStatus = { linked: false };
    return respond(204);
  }),
];
