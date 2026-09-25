import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  integrationsTelegramContract,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { telegramInstallations } from "@okouai/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { telegramUserAgentPreferences } from "@okouai/db/schema/telegram-user-agent-preference";
import { telegramUserLinks } from "@okouai/db/schema/telegram-user-link";
import type { z } from "zod";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { waitUntil } from "../context/wait-until";
import { bodyResultOf, queryOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../external/telegram-official";
import { sendMessage } from "../external/telegram-client";
import { publishUserSignal } from "../external/realtime";
import { logger } from "../../lib/log";
import { tapError } from "../utils";
import {
  formatTelegramUserDisplayName,
  linkOfficialTelegramUser$,
  linkTelegramUser$,
  telegramInstallationForLink,
  type TelegramInstallationForLink,
  verifyConnectSignature,
  verifyTelegramLogin,
  type LinkOfficialTelegramUserResult,
  type LinkTelegramUserResult,
} from "../services/telegram-link.service";
import type { AuthContext } from "../../types/auth";
import type { RouteEntry } from "../route-entry";

const log = logger("api:telegram:link");

type TelegramLinkBody = z.infer<typeof integrationsTelegramContract.link.body>;
type OrganizationAuth = AuthContext & { readonly orgId: string };
type AddressableTelegramInstallation = Omit<
  TelegramInstallationForLink,
  "botUsername"
> & { readonly botUsername: string };
type ErrorStatus = 400 | 403 | 404 | 409;
type LinkTelegramUserConflictReason = Extract<
  LinkTelegramUserResult,
  { readonly ok: false }
>["reason"];
type LinkOfficialTelegramUserConflictReason = Extract<
  LinkOfficialTelegramUserResult,
  { readonly ok: false }
>["reason"];

function errorResult(status: ErrorStatus, message: string, code: string) {
  return {
    status,
    body: {
      error: { message, code },
    },
  };
}

function orgMismatchResponse() {
  return errorResult(
    403,
    "This Telegram bot belongs to a different organization. Switch to the bot's organization to connect.",
    "FORBIDDEN",
  );
}

function missingAuthMethodResponse() {
  return errorResult(
    400,
    "Either telegramAuth or connectSignature is required",
    "BAD_REQUEST",
  );
}

function invalidTelegramAuthResponse() {
  return errorResult(400, "Invalid Telegram authorization", "BAD_REQUEST");
}

function invalidConnectSignatureResponse() {
  return errorResult(
    400,
    "Invalid or expired connect link. Please use /connect again in Telegram.",
    "BAD_REQUEST",
  );
}

function missingOfficialAgentResponse() {
  return errorResult(
    409,
    "Finish onboarding before connecting Telegram. Telegram needs a default agent for this workspace.",
    "CONFLICT",
  );
}

function missingBotUsernameResponse(official: boolean) {
  return errorResult(
    official ? 404 : 409,
    official
      ? "Official Telegram bot username is not configured"
      : "Telegram bot username is unavailable. Reinstall the bot to refresh its Telegram metadata.",
    official ? "NOT_FOUND" : "CONFLICT",
  );
}

function linkConflictResponse(reason: LinkTelegramUserConflictReason) {
  const brandName = PUBLIC_BRAND_PRESENTATION.brandName;
  const message =
    reason === "telegram-user-linked"
      ? `This Telegram account is already connected to another ${brandName} account for this bot. Disconnect it before connecting a different account.`
      : reason === "user-linked"
        ? `Your ${brandName} account is already connected to another Telegram account for this bot. Disconnect it before connecting a different Telegram account.`
        : "This Telegram account link already exists. Disconnect it first and try again.";

  return errorResult(409, message, "CONFLICT");
}

function officialLinkConflictResponse(
  reason: LinkOfficialTelegramUserConflictReason,
  botUsername: string,
) {
  const brandName = PUBLIC_BRAND_PRESENTATION.brandName;
  const botLabel = `official Telegram bot @${botUsername}`;
  const message =
    reason === "telegram-user-linked"
      ? `This Telegram account is already connected to another ${brandName} organization through the ${botLabel}. Disconnect it before connecting a different account.`
      : reason === "org-linked"
        ? `Your ${brandName} account is already connected to another Telegram account for the ${botLabel} in this organization. Disconnect it before connecting a different Telegram account.`
        : "This official Telegram account link already exists. Disconnect it first and try again.";

  return errorResult(409, message, "CONFLICT");
}

function linkSuccessResponse(botUsername: string, telegramUserId: string) {
  return {
    status: 200 as const,
    body: {
      botUsername,
      telegramUserId,
    },
  };
}

async function deliverConnectSuccessMessage(args: {
  readonly botToken: string;
  readonly telegramUserId: string;
  readonly text: string;
}): Promise<void> {
  const result = await sendMessage(
    args.botToken,
    args.telegramUserId,
    args.text,
  );
  if (result.kind === "telegram-error") {
    log.warn("Failed to send Telegram connect success message", {
      telegramUserId: args.telegramUserId,
      status: result.status,
      description: result.description,
    });
  }
}

function sendConnectSuccessMessage(args: {
  readonly botToken: string;
  readonly telegramUserId: string;
  readonly official: boolean;
}): void {
  const text = args.official
    ? `✅ Account linked.\nSend me a message to start chatting with ${PUBLIC_BRAND_PRESENTATION.assistantName}.`
    : "✅ Account linked.\nSend me a message to start chatting with your agent.";

  waitUntil(
    tapError(
      deliverConnectSuccessMessage({
        botToken: args.botToken,
        telegramUserId: args.telegramUserId,
        text,
      }),
      (error) => {
        log.warn("Failed to send Telegram connect success message", {
          telegramUserId: args.telegramUserId,
          error,
        });
      },
    ),
  );
}

function noLinkedTelegramAccountResponse() {
  return {
    status: 404 as const,
    body: {
      error: {
        message: "No linked Telegram account",
        code: "NOT_FOUND" as const,
      },
    },
  };
}

async function publishTelegramUserChanged(userId: string): Promise<void> {
  await publishUserSignal([userId], "telegram:changed");
}

async function resolveOfficialConnectComposeId(
  db: Db,
  auth: OrganizationAuth,
): Promise<string | null> {
  const [preference] = await db
    .select({
      selectedAgentId: telegramUserAgentPreferences.selectedAgentId,
    })
    .from(telegramUserAgentPreferences)
    .where(
      and(
        eq(telegramUserAgentPreferences.userId, auth.userId),
        eq(telegramUserAgentPreferences.orgId, auth.orgId),
      ),
    )
    .limit(1);

  const preferredComposeId = preference?.selectedAgentId ?? null;
  if (preferredComposeId) {
    const [compose] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(eq(agents.id, preferredComposeId), eq(agents.orgId, auth.orgId)),
      )
      .limit(1);
    if (compose) {
      return compose.id;
    }
  }

  const [metadata] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, auth.orgId))
    .limit(1);
  const defaultAgentId = metadata?.defaultAgentId ?? null;
  if (!defaultAgentId) {
    return null;
  }

  const [compose] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, defaultAgentId), eq(agents.orgId, auth.orgId)))
    .limit(1);
  return compose?.id ?? null;
}

const unlinkInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { botId } = get(queryOf(integrationsTelegramContract.unlink));
  const writeDb = set(writeDb$);

  if (botId === OFFICIAL_TELEGRAM_BOT_ID) {
    const deleted = await writeDb
      .delete(telegramOfficialUserLinks)
      .where(
        and(
          eq(telegramOfficialUserLinks.userId, auth.userId),
          eq(telegramOfficialUserLinks.orgId, auth.orgId),
        ),
      )
      .returning({ id: telegramOfficialUserLinks.id });
    signal.throwIfAborted();

    if (deleted.length === 0) {
      return noLinkedTelegramAccountResponse();
    }

    await publishTelegramUserChanged(auth.userId);
    signal.throwIfAborted();
    return { status: 204 as const, body: undefined };
  }

  const orgInstallations = writeDb
    .select({ telegramBotId: telegramInstallations.telegramBotId })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, auth.orgId));

  const deleted = await writeDb
    .delete(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.userId, auth.userId),
        inArray(telegramUserLinks.installationId, orgInstallations),
        botId ? eq(telegramUserLinks.installationId, botId) : undefined,
      ),
    )
    .returning({ id: telegramUserLinks.id });
  signal.throwIfAborted();

  if (deleted.length === 0) {
    return noLinkedTelegramAccountResponse();
  }

  await publishTelegramUserChanged(auth.userId);
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

const linkOfficialInner$ = command(
  async (
    { set },
    args: { readonly auth: OrganizationAuth; readonly body: TelegramLinkBody },
    signal: AbortSignal,
  ) => {
    const config = getOfficialTelegramBotConfig();
    if (!config.botToken) {
      return errorResult(
        404,
        "Official Telegram bot is not configured",
        "NOT_FOUND",
      );
    }
    if (!config.botUsername) {
      return missingBotUsernameResponse(true);
    }

    const telegramAuth = args.body.telegramAuth;
    if (telegramAuth) {
      if (!verifyTelegramLogin(telegramAuth, config.botToken)) {
        return invalidTelegramAuthResponse();
      }

      const db = set(writeDb$);
      const composeId = await resolveOfficialConnectComposeId(db, args.auth);
      signal.throwIfAborted();
      if (!composeId) {
        return missingOfficialAgentResponse();
      }

      const telegramUserId = String(telegramAuth.id);
      const result = await set(
        linkOfficialTelegramUser$,
        {
          telegramUserId,
          telegramUsername: telegramAuth.username,
          telegramDisplayName: formatTelegramUserDisplayName(telegramAuth),
          userId: args.auth.userId,
          orgId: args.auth.orgId,
        },
        signal,
      );
      signal.throwIfAborted();

      if (!result.ok) {
        return officialLinkConflictResponse(result.reason, config.botUsername);
      }

      return linkSuccessResponse(config.botUsername, telegramUserId);
    }

    const connectSignature = args.body.connectSignature;
    if (connectSignature) {
      if (
        !verifyConnectSignature({
          installationId: OFFICIAL_TELEGRAM_BOT_ID,
          telegramUserId: connectSignature.telegramUserId,
          timestamp: connectSignature.timestamp,
          signature: connectSignature.signature,
          botToken: config.botToken,
          telegramUsername: connectSignature.telegramUsername,
          telegramDisplayName: connectSignature.telegramDisplayName,
        })
      ) {
        return invalidConnectSignatureResponse();
      }
      const db = set(writeDb$);
      const composeId = await resolveOfficialConnectComposeId(db, args.auth);
      signal.throwIfAborted();
      if (!composeId) {
        return missingOfficialAgentResponse();
      }

      const result = await set(
        linkOfficialTelegramUser$,
        {
          telegramUserId: connectSignature.telegramUserId,
          telegramUsername: connectSignature.telegramUsername,
          telegramDisplayName: connectSignature.telegramDisplayName,
          userId: args.auth.userId,
          orgId: args.auth.orgId,
        },
        signal,
      );
      signal.throwIfAborted();

      if (!result.ok) {
        return officialLinkConflictResponse(result.reason, config.botUsername);
      }

      sendConnectSuccessMessage({
        botToken: config.botToken,
        telegramUserId: connectSignature.telegramUserId,
        official: true,
      });

      return linkSuccessResponse(
        config.botUsername,
        connectSignature.telegramUserId,
      );
    }

    return missingAuthMethodResponse();
  },
);

const linkCustomWithTelegramAuth$ = command(
  async (
    { set },
    args: {
      readonly auth: OrganizationAuth;
      readonly body: TelegramLinkBody;
      readonly installation: AddressableTelegramInstallation;
    },
    signal: AbortSignal,
  ) => {
    const telegramAuth = args.body.telegramAuth;
    if (!telegramAuth) {
      return missingAuthMethodResponse();
    }

    if (!verifyTelegramLogin(telegramAuth, args.installation.botToken)) {
      return invalidTelegramAuthResponse();
    }

    const telegramUserId = String(telegramAuth.id);
    const result = await set(
      linkTelegramUser$,
      {
        installationId: args.installation.telegramBotId,
        telegramUserId,
        telegramUsername: telegramAuth.username,
        telegramDisplayName: formatTelegramUserDisplayName(telegramAuth),
        userId: args.auth.userId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      return linkConflictResponse(result.reason);
    }

    return linkSuccessResponse(args.installation.botUsername, telegramUserId);
  },
);

const linkCustomWithConnectSignature$ = command(
  async (
    { set },
    args: {
      readonly auth: OrganizationAuth;
      readonly body: TelegramLinkBody;
      readonly installation: AddressableTelegramInstallation;
    },
    signal: AbortSignal,
  ) => {
    const connectSignature = args.body.connectSignature;
    if (!connectSignature) {
      return missingAuthMethodResponse();
    }

    if (
      !verifyConnectSignature({
        installationId: args.installation.telegramBotId,
        telegramUserId: connectSignature.telegramUserId,
        timestamp: connectSignature.timestamp,
        signature: connectSignature.signature,
        botToken: args.installation.botToken,
        telegramUsername: connectSignature.telegramUsername,
        telegramDisplayName: connectSignature.telegramDisplayName,
      })
    ) {
      return invalidConnectSignatureResponse();
    }
    const result = await set(
      linkTelegramUser$,
      {
        installationId: args.installation.telegramBotId,
        telegramUserId: connectSignature.telegramUserId,
        telegramUsername: connectSignature.telegramUsername,
        telegramDisplayName: connectSignature.telegramDisplayName,
        userId: args.auth.userId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      return linkConflictResponse(result.reason);
    }

    sendConnectSuccessMessage({
      botToken: args.installation.botToken,
      telegramUserId: connectSignature.telegramUserId,
      official: false,
    });

    return linkSuccessResponse(
      args.installation.botUsername,
      connectSignature.telegramUserId,
    );
  },
);

const linkCustomInner$ = command(
  async (
    { get, set },
    args: { readonly auth: OrganizationAuth; readonly body: TelegramLinkBody },
    signal: AbortSignal,
  ) => {
    const installation = await get(
      telegramInstallationForLink({ botId: args.body.telegramBotId }),
    );
    signal.throwIfAborted();

    if (!installation) {
      return errorResult(404, "Installation not found", "NOT_FOUND");
    }
    if (installation.orgId !== args.auth.orgId) {
      return orgMismatchResponse();
    }
    if (!installation.botUsername) {
      return missingBotUsernameResponse(false);
    }
    const addressableInstallation: AddressableTelegramInstallation = {
      ...installation,
      botUsername: installation.botUsername,
    };

    if (args.body.telegramAuth) {
      return set(
        linkCustomWithTelegramAuth$,
        {
          auth: args.auth,
          body: args.body,
          installation: addressableInstallation,
        },
        signal,
      );
    }

    if (args.body.connectSignature) {
      return set(
        linkCustomWithConnectSignature$,
        {
          auth: args.auth,
          body: args.body,
          installation: addressableInstallation,
        },
        signal,
      );
    }

    return missingAuthMethodResponse();
  },
);

const linkInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(bodyResultOf(integrationsTelegramContract.link));
  signal.throwIfAborted();

  if (!body.ok) {
    return body.response;
  }

  const linkCommand = isOfficialTelegramBotId(body.data.telegramBotId)
    ? linkOfficialInner$
    : linkCustomInner$;
  return set(linkCommand, { auth, body: body.data }, signal);
});

export const integrationsTelegramLinkRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTelegramContract.link,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      linkInner$,
    ),
  },
  {
    route: integrationsTelegramContract.unlink,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      unlinkInner$,
    ),
  },
];
