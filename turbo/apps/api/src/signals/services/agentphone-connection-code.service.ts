import { createHmac, randomInt } from "node:crypto";

import { agentphoneConnectionCodes } from "@okouai/db/schema/agentphone-connection-code";
import { and, eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { AgentPhoneChannel } from "./agentphone-shared.service";
import { linkAgentPhoneIdentity$ } from "./agentphone-link.service";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";

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

export const createAgentPhoneConnectionCode$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly secret: string;
    },
    signal: AbortSignal,
  ): Promise<AgentPhoneConnectionCode> => {
    const db = set(writeDb$);
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
    signal.throwIfAborted();

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
          expiresAt,
          consumedAt: null,
          consumedPhoneHandle: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

    signal.throwIfAborted();
    return { code, expiresAt };
  },
);

export const consumeAgentPhoneConnectionCode$ = command(
  async (
    { set },
    args: {
      readonly message: string;
      readonly phoneHandle: string;
      readonly channel: AgentPhoneChannel;
      readonly secret: string;
    },
    signal: AbortSignal,
  ): Promise<AgentPhoneConnectionCodeConsumeResult> => {
    const normalizedCode = normalizeAgentPhoneConnectionCode(args.message);
    if (!normalizedCode) {
      return { kind: "not-code" };
    }
    const result = await set(
      linkAgentPhoneIdentity$,
      {
        source: {
          kind: "code",
          codeHash: hashAgentPhoneConnectionCode(normalizedCode, args.secret),
        },
        phoneHandle: args.phoneHandle,
        channel: args.channel,
      },
      signal,
    );
    if (result.kind !== "linked") {
      return result;
    }
    return {
      kind: "linked",
      userId: result.userLink.userId,
      orgId: result.userLink.orgId,
      phoneHandle: result.userLink.phoneHandle,
    };
  },
);
