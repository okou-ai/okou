import {
  atomSubscriptionGrantsContract,
  type atomSubscriptionGrantSchema,
} from "@okouai/api-contracts/contracts/atom-subscription-grants";
import { modelProviderAuthSessions } from "@okouai/db/schema/model-provider-auth-session";
import { command, computed } from "ccstate";
import { eq } from "drizzle-orm";
import type { infer as zInfer } from "zod";

import { optionalEnv } from "../../lib/env";
import {
  badRequestMessage,
  conflict,
  providerUnavailable,
} from "../../lib/error";
import { nowDate } from "../../lib/time";
import { request$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { authenticateClerkMachine, clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { handleCodexAuthJsonPaste } from "../services/codex-auth-json-paste-handler";
import { cancelAtomSubscriptionGrant$ } from "../services/atom-subscription-grant-cancellation";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { upsertPersonalModelProviderAccount$ } from "../services/model-provider-account.service";
import { resetDisconnectedMemberModelSelection } from "../services/member-subscription-models.service";
import { settle } from "../utils";

type Grant = zInfer<typeof atomSubscriptionGrantSchema>;
const SOURCE = "atom-subscription-grant";

function receipt(grantId: string) {
  return {
    status: 200 as const,
    body: { grantId, status: "delivered" as const },
  };
}

function existingGrantResult(
  session: typeof modelProviderAuthSessions.$inferSelect,
  args: Grant,
) {
  const type =
    args.tokens.provider === "codex"
      ? "codex-oauth-token"
      : "claude-code-oauth-token";
  if (
    session.source !== SOURCE ||
    session.orgId !== args.orgId ||
    session.userId !== args.userId ||
    session.connectorType !== type
  ) {
    return conflict(
      "Grant ID is already bound to another recipient or provider",
    );
  }
  if (session.status === "imported") {
    return receipt(args.grantId);
  }
  if (session.status === "cancelled") {
    return conflict("Grant was cancelled; start a new authorization in Atom");
  }
  if (session.status !== "completing" || session.expiresAt <= nowDate()) {
    return conflict("Grant expired; start a new authorization in Atom");
  }
  return undefined;
}

const publishCredentials$ = command(
  async ({ get, set }, args: Grant, signal: AbortSignal) => {
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const common = {
      orgId: args.orgId,
      userId: args.userId,
      featureSwitchContext,
      authSession: { id: args.grantId, userId: args.userId, source: SOURCE },
      mode: { kind: "add" as const },
    } as const;
    if (args.tokens.provider === "claude-code") {
      return await set(
        upsertPersonalModelProviderAccount$,
        {
          ...common,
          type: "claude-code-oauth-token",
          authMethod: null,
          secretValues: {
            CLAUDE_CODE_OAUTH_TOKEN: args.tokens.accessToken,
          },
        },
        signal,
      );
    }
    return await handleCodexAuthJsonPaste(
      {
        orgId: args.orgId,
        userId: args.userId,
        rawAuthJson: JSON.stringify({
          tokens: {
            access_token: args.tokens.accessToken,
            refresh_token: args.tokens.refreshToken,
            account_id: "atom-grant",
            id_token: args.tokens.idToken,
          },
        }),
        upsert: async (parsed) => {
          return await set(
            upsertPersonalModelProviderAccount$,
            { ...common, ...parsed, type: "codex-oauth-token" },
            signal,
          );
        },
      },
      signal,
    );
  },
);

const deliver$ = command(
  async ({ get, set }, args: Grant, signal: AbortSignal) => {
    const db = set(writeDb$);
    const type =
      args.tokens.provider === "codex"
        ? "codex-oauth-token"
        : "claude-code-oauth-token";
    // Retain imported receipts after delivery: retries must never resurrect an old refresh token.
    const [existing] = await db
      .select()
      .from(modelProviderAuthSessions)
      .where(eq(modelProviderAuthSessions.id, args.grantId));
    signal.throwIfAborted();
    if (existing) {
      const response = existingGrantResult(existing, args);
      if (response) {
        return response;
      }
    }

    const memberships = await get(
      clerk$,
    ).organizations.getOrganizationMembershipList(
      { organizationId: args.orgId, userId: [args.userId], limit: 1 },
      undefined,
      signal,
    );
    signal.throwIfAborted();
    if (
      !memberships.data.some((member) => {
        return (
          member.publicUserData?.userId === args.userId &&
          member.organization.id === args.orgId
        );
      })
    ) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Recipient is not a member of the target organization",
            code: "FORBIDDEN",
          },
        },
      };
    }

    // Existing device-auth publication binds credential persistence and the receipt
    // in the same transaction. Competing requests cannot both publish credentials.
    await db
      .insert(modelProviderAuthSessions)
      .values({
        id: args.grantId,
        orgId: args.orgId,
        userId: args.userId,
        connectorType: type,
        source: SOURCE,
        status: "completing",
        expiresAt: new Date(nowDate().getTime() + 24 * 60 * 60_000),
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
    const [claimed] = await db
      .select()
      .from(modelProviderAuthSessions)
      .where(eq(modelProviderAuthSessions.id, args.grantId));
    signal.throwIfAborted();
    if (!claimed) {
      return conflict(
        "Grant ID is already bound to another recipient or provider",
      );
    }
    const response = existingGrantResult(claimed, args);
    if (response) {
      return response;
    }
    const result = await settle(set(publishCredentials$, args, signal), signal);
    signal.throwIfAborted();

    // Also covers a response lost after commit or a concurrent successful writer.
    const [published] = await db
      .select({ status: modelProviderAuthSessions.status })
      .from(modelProviderAuthSessions)
      .where(eq(modelProviderAuthSessions.id, args.grantId));
    signal.throwIfAborted();
    if (published?.status === "imported") {
      return receipt(args.grantId);
    }
    if (published?.status === "cancelled") {
      return conflict("Grant was cancelled; start a new authorization in Atom");
    }
    if (result.ok && "status" in result.value && result.value.status >= 400) {
      return badRequestMessage(
        "Subscription could not be added; check the plan and account limit",
      );
    }
    return providerUnavailable(
      "Subscription delivery is not confirmed; retry the same grant",
    );
  },
);

const authenticateAtom$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const machineSecretKey = optionalEnv("OKOU_MACHINE_SECRET_KEY");
  if (!machineSecretKey) {
    return providerUnavailable("Atom subscription grants are not configured");
  }
  const authentication = await settle(
    authenticateClerkMachine(get(request$).raw, machineSecretKey),
    signal,
  );
  signal.throwIfAborted();
  if (!authentication.ok) {
    return providerUnavailable("Atom M2M authentication is unavailable");
  }
  if (!authentication.value) {
    return {
      status: 401 as const,
      body: {
        error: {
          message: "Invalid Atom M2M token",
          code: "UNAUTHORIZED",
        },
      },
    };
  }
  return undefined;
});

const deliverAtomSubscription$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const authentication = await set(authenticateAtom$, signal);
    if (authentication) {
      return authentication;
    }
    const body = await get(
      bodyResultOf(atomSubscriptionGrantsContract.deliver),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    return await set(deliver$, body.data, signal);
  },
);

const cancellationSelectionRepair$ = computed(async (get) => {
  const body = await get(bodyResultOf(atomSubscriptionGrantsContract.cancel));
  if (!body.ok) {
    throw new Error("Cancellation selection repair requires a valid request");
  }
  const { orgId, userId } = body.data;
  return resetDisconnectedMemberModelSelection(
    computed(() => {
      return { orgId, userId };
    }),
  );
});

const cancelAtomSubscription$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const authentication = await set(authenticateAtom$, signal);
    if (authentication) {
      return authentication;
    }
    const body = await get(bodyResultOf(atomSubscriptionGrantsContract.cancel));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const params = get(pathParamsOf(atomSubscriptionGrantsContract.cancel));
    const result = await set(
      cancelAtomSubscriptionGrant$,
      { ...body.data, ...params },
      signal,
    );
    if (result.status === 200) {
      const repair$ = await get(cancellationSelectionRepair$);
      signal.throwIfAborted();
      await set(repair$);
      signal.throwIfAborted();
    }
    return result;
  },
);

export const atomSubscriptionGrantRoutes: readonly RouteEntry[] = [
  {
    route: atomSubscriptionGrantsContract.cancel,
    handler: cancelAtomSubscription$,
  },
  {
    route: atomSubscriptionGrantsContract.deliver,
    handler: deliverAtomSubscription$,
  },
];
