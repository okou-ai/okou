import { createHmac, randomInt } from "node:crypto";

import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { agentphoneConnectionCodes } from "@okouai/db/schema/agentphone-connection-code";
import { and, eq, gt, isNull } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  linkAgentPhoneUser,
  normalizeAgentPhoneHandle,
  type AgentPhoneChannel,
} from "./agentphone.service";

const AGENTPHONE_CONNECTION_CODE_DIGITS = 8;
const AGENTPHONE_CONNECTION_CODE_LIMIT =
  10 ** AGENTPHONE_CONNECTION_CODE_DIGITS;
const AGENTPHONE_CONNECTION_CODE_TTL_MS = 10 * 60 * 1000;
const AGENTPHONE_CONNECTION_CODE_PATTERN = /^\d{8}$/u;
const AGENTPHONE_CONNECTION_CODE_HASH_DOMAIN = "agentphone-connection-code:v1";
const AGENTPHONE_CONNECTION_CODE_GENERATION_ATTEMPTS = 5;

export interface AgentPhoneConnectionCode {
  readonly code: string;
  readonly expiresAt: Date;
}

export type AgentPhoneConnectionCodeConsumeResult =
  | { readonly kind: "not-code" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "conflict";
      readonly reason: "phone-handle-linked" | "org-linked" | "conflict";
    }
  | {
      readonly kind: "linked";
      readonly userId: string;
      readonly orgId: string;
      readonly phoneHandle: string;
    };

function generateAgentPhoneConnectionCode(): string {
  return randomInt(AGENTPHONE_CONNECTION_CODE_LIMIT)
    .toString()
    .padStart(AGENTPHONE_CONNECTION_CODE_DIGITS, "0");
}

function normalizeAgentPhoneConnectionCode(value: string): string | null {
  const normalized = value.trim();
  return AGENTPHONE_CONNECTION_CODE_PATTERN.test(normalized)
    ? normalized
    : null;
}

export function isAgentPhoneConnectionCodeMessage(value: string): boolean {
  return normalizeAgentPhoneConnectionCode(value) !== null;
}

function hashAgentPhoneConnectionCode(code: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${AGENTPHONE_CONNECTION_CODE_HASH_DOMAIN}:${code}`)
    .digest("hex");
}

function generateFreshAgentPhoneConnectionCode(
  secret: string,
  currentCodeHash?: string,
): { readonly code: string; readonly codeHash: string } {
  for (
    let attempt = 0;
    attempt < AGENTPHONE_CONNECTION_CODE_GENERATION_ATTEMPTS;
    attempt += 1
  ) {
    const code = generateAgentPhoneConnectionCode();
    const codeHash = hashAgentPhoneConnectionCode(code, secret);
    if (codeHash !== currentCodeHash) {
      return { code, codeHash };
    }
  }

  throw new Error("AgentPhone connection code generation failed");
}

export async function createAgentPhoneConnectionCode(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly publicBrand: PublicBrand;
    readonly secret: string;
  },
): Promise<AgentPhoneConnectionCode> {
  const [currentCode] = await db
    .select({ codeHash: agentphoneConnectionCodes.codeHash })
    .from(agentphoneConnectionCodes)
    .where(
      and(
        eq(agentphoneConnectionCodes.userId, args.userId),
        eq(agentphoneConnectionCodes.orgId, args.orgId),
      ),
    )
    .limit(1);

  const { code, codeHash } = generateFreshAgentPhoneConnectionCode(
    args.secret,
    currentCode?.codeHash,
  );

  const createdAt = nowDate();
  const expiresAt = new Date(
    createdAt.getTime() + AGENTPHONE_CONNECTION_CODE_TTL_MS,
  );
  await db
    .insert(agentphoneConnectionCodes)
    .values({
      codeHash,
      userId: args.userId,
      orgId: args.orgId,
      publicBrand: args.publicBrand,
      expiresAt,
      createdAt,
      updatedAt: createdAt,
    })
    .onConflictDoUpdate({
      target: [
        agentphoneConnectionCodes.userId,
        agentphoneConnectionCodes.orgId,
      ],
      set: {
        codeHash,
        publicBrand: args.publicBrand,
        expiresAt,
        consumedAt: null,
        consumedPhoneHandle: null,
        createdAt,
        updatedAt: createdAt,
      },
    });

  return { code, expiresAt };
}

export async function consumeAgentPhoneConnectionCode(
  db: Db,
  args: {
    readonly message: string;
    readonly phoneHandle: string;
    readonly channel: AgentPhoneChannel;
    readonly secret: string;
  },
): Promise<AgentPhoneConnectionCodeConsumeResult> {
  const normalizedCode = normalizeAgentPhoneConnectionCode(args.message);
  if (!normalizedCode) {
    return { kind: "not-code" };
  }

  const consumedAt = nowDate();
  const codeHash = hashAgentPhoneConnectionCode(normalizedCode, args.secret);
  const phoneHandle = normalizeAgentPhoneHandle(args.phoneHandle, args.channel);

  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: agentphoneConnectionCodes.id,
        userId: agentphoneConnectionCodes.userId,
        orgId: agentphoneConnectionCodes.orgId,
        publicBrand: agentphoneConnectionCodes.publicBrand,
      })
      .from(agentphoneConnectionCodes)
      .where(
        and(
          eq(agentphoneConnectionCodes.codeHash, codeHash),
          isNull(agentphoneConnectionCodes.consumedAt),
          gt(agentphoneConnectionCodes.expiresAt, consumedAt),
        ),
      )
      .for("update")
      .limit(2);

    if (rows.length !== 1 || !rows[0]) {
      return { kind: "invalid" };
    }

    const code = rows[0];
    const linkResult = await linkAgentPhoneUser(tx, {
      phoneHandle,
      channel: args.channel,
      userId: code.userId,
      orgId: code.orgId,
      publicBrand: code.publicBrand,
    });

    await tx
      .update(agentphoneConnectionCodes)
      .set({
        consumedAt,
        consumedPhoneHandle: phoneHandle,
        updatedAt: consumedAt,
      })
      .where(eq(agentphoneConnectionCodes.id, code.id));

    if (!linkResult.ok) {
      return { kind: "conflict", reason: linkResult.reason };
    }

    return {
      kind: "linked",
      userId: code.userId,
      orgId: code.orgId,
      phoneHandle,
    };
  });
}
