import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { command, computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { telegramInstallations } from "@okouai/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { telegramUserLinks } from "@okouai/db/schema/telegram-user-link";

import { now, nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";

const PENDING_TELEGRAM_USER_ID = "pending";
const MAX_AUTH_AGE_SECONDS = 300;
const MAX_CONNECT_AGE_SECONDS = 600;

type TelegramUserLink = typeof telegramUserLinks.$inferSelect;
type OfficialTelegramUserLink = typeof telegramOfficialUserLinks.$inferSelect;

interface TelegramAuthData {
  readonly id: number;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly photo_url?: string;
  readonly auth_date: number;
  readonly hash: string;
}

export type LinkTelegramUserResult =
  | { readonly ok: true; readonly userLink: TelegramUserLink }
  | {
      readonly ok: false;
      readonly reason: "telegram-user-linked" | "user-linked" | "conflict";
      readonly userLink?: TelegramUserLink;
    };

export type LinkOfficialTelegramUserResult =
  | { readonly ok: true; readonly userLink: OfficialTelegramUserLink }
  | {
      readonly ok: false;
      readonly reason: "telegram-user-linked" | "org-linked" | "conflict";
      readonly userLink?: OfficialTelegramUserLink;
    };

export interface TelegramInstallationForLink {
  readonly telegramBotId: string;
  readonly botUsername: string | null;
  readonly botToken: string;
  readonly orgId: string;
}

function telegramUserProfileUpdate(
  params: {
    readonly telegramUsername?: string | null;
    readonly telegramDisplayName?: string | null;
  },
  existing: {
    readonly telegramUsername: string | null;
    readonly telegramDisplayName: string | null;
  },
) {
  return {
    telegramUsername:
      params.telegramUsername === undefined
        ? existing.telegramUsername
        : normalizeTelegramUsername(params.telegramUsername),
    telegramDisplayName:
      params.telegramDisplayName === undefined
        ? existing.telegramDisplayName
        : normalizeTelegramDisplayName(params.telegramDisplayName),
    updatedAt: nowDate(),
  };
}

function normalizeTelegramUsername(
  telegramUsername: string | null | undefined,
): string | null {
  const value = telegramUsername?.trim().replace(/^@+/, "");
  return value || null;
}

function normalizeTelegramDisplayName(
  telegramDisplayName: string | null | undefined,
): string | null {
  const value = telegramDisplayName?.trim().replace(/\s+/g, " ");
  return value ? value.slice(0, 255) : null;
}

export function formatTelegramUserDisplayName(user: {
  readonly first_name?: string;
  readonly last_name?: string;
}): string | null {
  return normalizeTelegramDisplayName(
    [user.first_name, user.last_name]
      .map((part) => {
        return part?.trim();
      })
      .filter(Boolean)
      .join(" "),
  );
}

function timingSafeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyTelegramLogin(
  auth: TelegramAuthData,
  botToken: string,
): boolean {
  const nowSeconds = Math.floor(now() / 1000);
  if (nowSeconds - auth.auth_date > MAX_AUTH_AGE_SECONDS) {
    return false;
  }

  const checkString = Object.entries(auth)
    .filter(([key]) => {
      return key !== "hash";
    })
    .filter(([, value]) => {
      return value !== undefined;
    })
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    })
    .map(([key, value]) => {
      return `${key}=${value}`;
    })
    .join("\n");

  const secretKey = createHash("sha256").update(botToken).digest();
  const hmac = createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  return timingSafeHexEqual(hmac, auth.hash);
}

function signConnectParams(args: {
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly timestamp: number;
  readonly botToken: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}): string {
  const normalizedTelegramUsername = normalizeTelegramUsername(
    args.telegramUsername,
  );
  const normalizedTelegramDisplayName = normalizeTelegramDisplayName(
    args.telegramDisplayName,
  );
  let data = `${args.installationId}:${args.telegramUserId}:${args.timestamp}`;
  if (normalizedTelegramUsername || normalizedTelegramDisplayName) {
    data += `:${normalizedTelegramUsername ?? ""}`;
  }
  if (normalizedTelegramDisplayName) {
    data += `:${normalizedTelegramDisplayName}`;
  }
  return createHmac("sha256", args.botToken).update(data).digest("hex");
}

export function verifyConnectSignature(args: {
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly timestamp: number;
  readonly signature: string;
  readonly botToken: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}): boolean {
  const nowSeconds = Math.floor(now() / 1000);
  if (nowSeconds - args.timestamp > MAX_CONNECT_AGE_SECONDS) {
    return false;
  }

  const expected = signConnectParams(args);
  return timingSafeHexEqual(expected, args.signature);
}

async function publishTelegramUserChanged(userId: string): Promise<void> {
  await publishUserSignal([userId], "telegram:changed");
}

export function telegramInstallationForLink(args: {
  readonly botId: string;
}): Computed<Promise<TelegramInstallationForLink | null>> {
  return computed(async (get): Promise<TelegramInstallationForLink | null> => {
    const db = get(db$);
    const [row] = await db
      .select({
        telegramBotId: telegramInstallations.telegramBotId,
        botUsername: telegramInstallations.botUsername,
        encryptedBotToken: telegramInstallations.encryptedBotToken,
        orgId: telegramInstallations.orgId,
        ownerUserId: telegramInstallations.ownerUserId,
      })
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, args.botId))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      telegramBotId: row.telegramBotId,
      botUsername: row.botUsername ?? null,
      botToken: await decryptPersistentSecretValue(
        row.encryptedBotToken,
        await get(userFeatureSwitchContext(row.orgId, row.ownerUserId)),
      ),
      orgId: row.orgId,
    };
  });
}

export const linkTelegramUser$ = command(
  async (
    { set },
    params: {
      readonly installationId: string;
      readonly telegramUserId: string;
      readonly telegramUsername?: string | null;
      readonly telegramDisplayName?: string | null;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<LinkTelegramUserResult> => {
    const writeDb = set(writeDb$);
    const [existingTelegramLink] = await writeDb
      .select()
      .from(telegramUserLinks)
      .where(
        and(
          eq(telegramUserLinks.installationId, params.installationId),
          eq(telegramUserLinks.telegramUserId, params.telegramUserId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (existingTelegramLink) {
      if (existingTelegramLink.userId !== params.userId) {
        return {
          ok: false,
          reason: "telegram-user-linked",
          userLink: existingTelegramLink,
        };
      }

      const [updated] = await writeDb
        .update(telegramUserLinks)
        .set(telegramUserProfileUpdate(params, existingTelegramLink))
        .where(eq(telegramUserLinks.id, existingTelegramLink.id))
        .returning();
      signal.throwIfAborted();

      await publishTelegramUserChanged(params.userId);
      signal.throwIfAborted();
      return { ok: true, userLink: updated ?? existingTelegramLink };
    }

    const [existingUserLink] = await writeDb
      .select()
      .from(telegramUserLinks)
      .where(
        and(
          eq(telegramUserLinks.installationId, params.installationId),
          eq(telegramUserLinks.userId, params.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (existingUserLink) {
      if (existingUserLink.telegramUserId === params.telegramUserId) {
        const [updated] = await writeDb
          .update(telegramUserLinks)
          .set(telegramUserProfileUpdate(params, existingUserLink))
          .where(eq(telegramUserLinks.id, existingUserLink.id))
          .returning();
        signal.throwIfAborted();

        await publishTelegramUserChanged(params.userId);
        signal.throwIfAborted();
        return { ok: true, userLink: updated ?? existingUserLink };
      }

      if (
        existingUserLink.telegramUserId === PENDING_TELEGRAM_USER_ID &&
        params.telegramUserId !== PENDING_TELEGRAM_USER_ID
      ) {
        const [updated] = await writeDb
          .update(telegramUserLinks)
          .set({
            telegramUserId: params.telegramUserId,
            telegramUsername: normalizeTelegramUsername(
              params.telegramUsername,
            ),
            telegramDisplayName: normalizeTelegramDisplayName(
              params.telegramDisplayName,
            ),
            updatedAt: nowDate(),
          })
          .where(eq(telegramUserLinks.id, existingUserLink.id))
          .returning();
        signal.throwIfAborted();

        await publishTelegramUserChanged(params.userId);
        signal.throwIfAborted();
        return { ok: true, userLink: updated ?? existingUserLink };
      }

      return {
        ok: false,
        reason: "user-linked",
        userLink: existingUserLink,
      };
    }

    const [inserted] = await writeDb
      .insert(telegramUserLinks)
      .values({
        telegramUserId: params.telegramUserId,
        telegramUsername: normalizeTelegramUsername(params.telegramUsername),
        telegramDisplayName: normalizeTelegramDisplayName(
          params.telegramDisplayName,
        ),
        installationId: params.installationId,
        userId: params.userId,
      })
      .onConflictDoNothing()
      .returning();
    signal.throwIfAborted();

    if (inserted) {
      await publishTelegramUserChanged(params.userId);
      signal.throwIfAborted();
      return { ok: true, userLink: inserted };
    }

    return { ok: false, reason: "conflict" };
  },
);

export const linkOfficialTelegramUser$ = command(
  async (
    { set },
    params: {
      readonly telegramUserId: string;
      readonly telegramUsername?: string | null;
      readonly telegramDisplayName?: string | null;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<LinkOfficialTelegramUserResult> => {
    const writeDb = set(writeDb$);
    const [existingTelegramLink] = await writeDb
      .select()
      .from(telegramOfficialUserLinks)
      .where(
        eq(telegramOfficialUserLinks.telegramUserId, params.telegramUserId),
      )
      .limit(1);
    signal.throwIfAborted();

    if (existingTelegramLink) {
      if (
        existingTelegramLink.userId !== params.userId ||
        existingTelegramLink.orgId !== params.orgId
      ) {
        return {
          ok: false,
          reason: "telegram-user-linked",
          userLink: existingTelegramLink,
        };
      }

      const [updated] = await writeDb
        .update(telegramOfficialUserLinks)
        .set({
          telegramUsername:
            params.telegramUsername === undefined
              ? existingTelegramLink.telegramUsername
              : normalizeTelegramUsername(params.telegramUsername),
          telegramDisplayName:
            params.telegramDisplayName === undefined
              ? existingTelegramLink.telegramDisplayName
              : normalizeTelegramDisplayName(params.telegramDisplayName),
          updatedAt: nowDate(),
        })
        .where(eq(telegramOfficialUserLinks.id, existingTelegramLink.id))
        .returning();
      signal.throwIfAborted();

      await publishTelegramUserChanged(params.userId);
      signal.throwIfAborted();
      return { ok: true, userLink: updated ?? existingTelegramLink };
    }

    const [existingUserOrgLink] = await writeDb
      .select()
      .from(telegramOfficialUserLinks)
      .where(
        and(
          eq(telegramOfficialUserLinks.userId, params.userId),
          eq(telegramOfficialUserLinks.orgId, params.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (existingUserOrgLink) {
      if (existingUserOrgLink.telegramUserId === params.telegramUserId) {
        const [updated] = await writeDb
          .update(telegramOfficialUserLinks)
          .set({
            telegramUsername:
              params.telegramUsername === undefined
                ? existingUserOrgLink.telegramUsername
                : normalizeTelegramUsername(params.telegramUsername),
            telegramDisplayName:
              params.telegramDisplayName === undefined
                ? existingUserOrgLink.telegramDisplayName
                : normalizeTelegramDisplayName(params.telegramDisplayName),
            updatedAt: nowDate(),
          })
          .where(eq(telegramOfficialUserLinks.id, existingUserOrgLink.id))
          .returning();
        signal.throwIfAborted();

        await publishTelegramUserChanged(params.userId);
        signal.throwIfAborted();
        return { ok: true, userLink: updated ?? existingUserOrgLink };
      }

      return {
        ok: false,
        reason: "org-linked",
        userLink: existingUserOrgLink,
      };
    }

    const [inserted] = await writeDb
      .insert(telegramOfficialUserLinks)
      .values({
        telegramUserId: params.telegramUserId,
        telegramUsername: normalizeTelegramUsername(params.telegramUsername),
        telegramDisplayName: normalizeTelegramDisplayName(
          params.telegramDisplayName,
        ),
        userId: params.userId,
        orgId: params.orgId,
      })
      .onConflictDoNothing()
      .returning();
    signal.throwIfAborted();

    if (inserted) {
      await publishTelegramUserChanged(params.userId);
      signal.throwIfAborted();
      return { ok: true, userLink: inserted };
    }

    return { ok: false, reason: "conflict" };
  },
);
