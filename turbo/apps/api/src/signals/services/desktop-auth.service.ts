import { createHash, randomBytes } from "node:crypto";
import {
  defaultDesktopAuthCallbackScheme,
  type DesktopAuthCallbackScheme,
  type DesktopAuthHandoffStatus,
} from "@okouai/api-contracts/contracts/desktop-auth";
import { desktopAuthHandoffCodes } from "@okouai/db/schema/desktop-auth-handoff-code";
import { and, eq, gt, isNotNull, isNull, or } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";

const DESKTOP_AUTH_CALLBACK_HOST = "auth";
const DESKTOP_AUTH_CALLBACK_PATH = "/callback";
const DESKTOP_AUTH_HANDOFF_CODE_BYTES = 32;
const DESKTOP_AUTH_HANDOFF_CODE_TTL_MS = 60 * 1000;
const DESKTOP_AUTH_CODE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const DESKTOP_AUTH_HANDOFF_CODE_ERROR_NAME = "DesktopAuthHandoffCodeError";

export const DESKTOP_AUTH_SIGN_IN_TICKET_TTL_SECONDS = 60;

interface DesktopAuthHandoff {
  readonly code: string;
  readonly handoffId: string;
}

interface DesktopAuthHandoffStatusRow {
  readonly consumedAt: Date | null;
  readonly completedAt: Date | null;
}

export function isDesktopAuthHandoffCodeError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === DESKTOP_AUTH_HANDOFF_CODE_ERROR_NAME
  );
}

function desktopAuthHandoffCodeError(message: string): Error {
  const error = new Error(message);
  error.name = DESKTOP_AUTH_HANDOFF_CODE_ERROR_NAME;
  return error;
}

function hashDesktopAuthCode(code: string): string {
  return createHash("sha256").update(code).digest("base64url");
}

function assertValidDesktopAuthCode(code: string): void {
  if (!DESKTOP_AUTH_CODE_PATTERN.test(code)) {
    throw desktopAuthHandoffCodeError(
      "Desktop sign-in link is invalid or expired.",
    );
  }
}

export function buildDesktopAuthCallbackUrl(
  code: string,
  handoffId: string,
  callbackScheme: DesktopAuthCallbackScheme = defaultDesktopAuthCallbackScheme,
): string {
  const callbackUrl = new URL(
    `${callbackScheme}://${DESKTOP_AUTH_CALLBACK_HOST}${DESKTOP_AUTH_CALLBACK_PATH}`,
  );
  callbackUrl.searchParams.set("code", code);
  callbackUrl.searchParams.set("handoffId", handoffId);
  return callbackUrl.toString();
}

export async function createDesktopAuthHandoffCode(
  db: Db,
  args: { readonly userId: string },
): Promise<DesktopAuthHandoff> {
  const code = randomBytes(DESKTOP_AUTH_HANDOFF_CODE_BYTES).toString(
    "base64url",
  );
  const now = nowDate();
  const expiresAt = new Date(now.getTime() + DESKTOP_AUTH_HANDOFF_CODE_TTL_MS);

  const [row] = await db
    .insert(desktopAuthHandoffCodes)
    .values({
      codeHash: hashDesktopAuthCode(code),
      userId: args.userId,
      createdAt: now,
      expiresAt,
    })
    .returning({ id: desktopAuthHandoffCodes.id });

  if (!row) {
    throw new Error("Desktop sign-in failed.");
  }

  return { code, handoffId: row.id };
}

export async function consumeDesktopAuthHandoffCode(
  db: Db,
  args: { readonly code: string },
): Promise<string> {
  assertValidDesktopAuthCode(args.code);

  const now = nowDate();
  const [row] = await db
    .update(desktopAuthHandoffCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(desktopAuthHandoffCodes.codeHash, hashDesktopAuthCode(args.code)),
        isNull(desktopAuthHandoffCodes.consumedAt),
        gt(desktopAuthHandoffCodes.expiresAt, now),
      ),
    )
    .returning({ userId: desktopAuthHandoffCodes.userId });

  if (!row) {
    throw desktopAuthHandoffCodeError(
      "Desktop sign-in link is invalid or expired.",
    );
  }

  return row.userId;
}

function desktopAuthHandoffStatus(
  row: DesktopAuthHandoffStatusRow,
): DesktopAuthHandoffStatus {
  if (row.completedAt) {
    return "completed";
  }
  if (row.consumedAt) {
    return "consumed";
  }
  return "pending";
}

export async function getDesktopAuthHandoffStatus(
  db: Db,
  args: { readonly handoffId: string; readonly userId: string },
): Promise<DesktopAuthHandoffStatus | null> {
  const [row] = await db
    .select({
      consumedAt: desktopAuthHandoffCodes.consumedAt,
      completedAt: desktopAuthHandoffCodes.completedAt,
    })
    .from(desktopAuthHandoffCodes)
    .where(
      and(
        eq(desktopAuthHandoffCodes.id, args.handoffId),
        eq(desktopAuthHandoffCodes.userId, args.userId),
        or(
          isNotNull(desktopAuthHandoffCodes.consumedAt),
          gt(desktopAuthHandoffCodes.expiresAt, nowDate()),
        ),
      ),
    );

  return row ? desktopAuthHandoffStatus(row) : null;
}

export async function completeDesktopAuthHandoff(
  db: Db,
  args: { readonly handoffId: string; readonly userId: string },
): Promise<boolean> {
  const [row] = await db
    .update(desktopAuthHandoffCodes)
    .set({ completedAt: nowDate() })
    .where(
      and(
        eq(desktopAuthHandoffCodes.id, args.handoffId),
        eq(desktopAuthHandoffCodes.userId, args.userId),
        isNotNull(desktopAuthHandoffCodes.consumedAt),
      ),
    )
    .returning({ id: desktopAuthHandoffCodes.id });

  return Boolean(row);
}
