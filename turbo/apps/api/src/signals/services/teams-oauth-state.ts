import { randomBytes } from "node:crypto";
import { command } from "ccstate";
import * as z from "zod";

import { connectorOAuthStateExpiresAt } from "../../lib/connector-oauth-state";
import { safeJsonParse } from "../utils";
import {
  claimBuiltinConnectorOAuthState$,
  insertConnectorOAuthState$,
} from "./connector-oauth-state.service";

type TeamsOAuthPurpose = "teams-start" | "teams-callback";

export const createTeamsOAuthState$ = command(
  async (
    { set },
    args: {
      readonly purpose: TeamsOAuthPurpose;
      readonly userId: string;
      readonly orgId: string;
      readonly redirectUri: string;
      readonly prompt: string | null;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const state = `${args.purpose}.${randomBytes(32).toString("hex")}`;
    await set(
      insertConnectorOAuthState$,
      {
        state,
        connectorSlug: "microsoft-365",
        authMethod: args.purpose,
        userId: args.userId,
        orgId: args.orgId,
        redirectUri: args.redirectUri,
        oauthContext: JSON.stringify({ prompt: args.prompt }),
        accountMutation: { intent: "add" },
        expiresAt: connectorOAuthStateExpiresAt(),
      },
      signal,
    );
    return state;
  },
);

export const claimTeamsOAuthState$ = command(
  async (
    { set },
    args: { readonly state: string; readonly purpose: TeamsOAuthPurpose },
    signal: AbortSignal,
  ) => {
    if (!args.state.startsWith(`${args.purpose}.`)) {
      return null;
    }
    const claimed = await set(
      claimBuiltinConnectorOAuthState$,
      { state: args.state, connectorSlug: "microsoft-365" },
      signal,
    );
    if (
      claimed.kind !== "usable" ||
      claimed.state.authMethod !== args.purpose
    ) {
      return null;
    }
    const context = z
      .object({ prompt: z.string().nullable() })
      .parse(safeJsonParse(claimed.state.oauthContext ?? ""));
    return {
      userId: claimed.state.userId,
      orgId: claimed.state.orgId,
      redirectUri: claimed.state.redirectUri,
      prompt: context.prompt,
    };
  },
);
