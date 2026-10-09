import { randomUUID } from "node:crypto";

import { cliTokens } from "@okouai/db/schema/cli-tokens";
import { command } from "ccstate";

import { generateCliToken } from "../auth/tokens";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";

const CLI_TOKEN_EXPIRES_IN_SECONDS = 90 * 24 * 60 * 60;

interface IssuedCliToken {
  readonly token: string;
  readonly expiresIn: number;
}

export const issueCliToken$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly name: string;
    },
    _signal: AbortSignal,
  ): Promise<IssuedCliToken> => {
    const writeDb = set(writeDb$);
    const tokenId = randomUUID();
    const now = nowDate();
    const expiresAt = new Date(
      now.getTime() + CLI_TOKEN_EXPIRES_IN_SECONDS * 1000,
    );
    const token = generateCliToken(args.userId, args.orgId, tokenId);

    await writeDb.insert(cliTokens).values({
      id: tokenId,
      token,
      userId: args.userId,
      name: args.name,
      expiresAt,
      createdAt: now,
    });

    return { token, expiresIn: CLI_TOKEN_EXPIRES_IN_SECONDS };
  },
);
