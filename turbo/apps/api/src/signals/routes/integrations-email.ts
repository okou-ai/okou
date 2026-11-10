import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { integrationsEmailContract as contract } from "@okouai/api-contracts/contracts/integrations-email";
import {
  emailChannelMessages,
  emailUserLinks,
} from "@okouai/db/schema/email-integration";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { publishUserSignal } from "../external/realtime";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import {
  EMAIL_CHANNEL_ADDRESS,
  processEmailChannelMessage$,
  validEmailConnectionSignature,
  ownsVerifiedEmail,
} from "../services/email-channel.service";
import {
  badRequestMessage,
  conflict,
  resourceUnavailable,
} from "../../lib/error";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import {
  linkEmailIdentity$,
  createEmailConnectionCode$,
  connectedMailAccounts$,
  syncConnectedMailAccounts$,
  connectSignInEmail$,
  signInEmailAddress,
} from "../services/email-connection.service";
import type { RouteEntry } from "../route-entry";

const enabled$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  return isFeatureEnabled(
    FeatureSwitchKey.EmailIntegration,
    await set(loadUserFeatureSwitchContext$, auth.orgId, auth.userId, signal),
  );
});

const getLinkStatus$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(enabled$, signal))) {
    return resourceUnavailable("Email integration is not available");
  }
  const auth = get(organizationAuthContext$);
  const user = await get(clerk$).users.getUser(auth.userId, undefined, signal);
  signal.throwIfAborted();
  const accounts = await set(connectedMailAccounts$, auth, signal);
  if (!user.banned) {
    await set(connectSignInEmail$, { user, orgId: auth.orgId }, signal);
    signal.throwIfAborted();
    await set(
      syncConnectedMailAccounts$,
      { userId: auth.userId, orgId: auth.orgId, accounts },
      signal,
    );
    signal.throwIfAborted();
  }
  const links = await set(writeDb$)
    .select({ email: emailUserLinks.emailAddress })
    .from(emailUserLinks)
    .where(
      and(
        eq(emailUserLinks.userId, auth.userId),
        eq(emailUserLinks.orgId, auth.orgId),
        isNull(emailUserLinks.disconnectedAt),
      ),
    )
    .orderBy(emailUserLinks.createdAt, emailUserLinks.id);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      address: EMAIL_CHANNEL_ADDRESS,
      configured: Boolean(
        optionalEnv("RESEND_API_KEY") && optionalEnv("RESEND_WEBHOOK_SECRET"),
      ),
      emails: links.map((link) => {
        return link.email;
      }),
      availableEmails: user.banned
        ? []
        : [
            ...new Set([
              ...accounts.flatMap((account) => {
                return account.email ? [account.email.toLowerCase()] : [];
              }),
              ...user.emailAddresses
                .filter((entry) => {
                  return entry.verification?.status === "verified";
                })
                .map((entry) => {
                  return entry.emailAddress.toLowerCase();
                }),
            ]),
          ],
    },
  };
});

const addressBody$ = bodyResultOf(contract.connectAddress);
const connectAddress$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(enabled$, signal))) {
    return resourceUnavailable("Email integration is not available");
  }
  const auth = get(organizationAuthContext$);
  const body = await get(addressBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const email = body.data.emailAddress.toLowerCase();
  const user = await get(clerk$).users.getUser(auth.userId, undefined, signal);
  signal.throwIfAborted();
  const accounts = await set(connectedMailAccounts$, auth, signal);
  const account = accounts.find((entry) => {
    return entry.email?.toLowerCase() === email;
  });
  if (user.banned || (!ownsVerifiedEmail(user, email) && !account)) {
    return resourceUnavailable(
      "Connect a verified email address belonging to your account.",
    );
  }
  const link = await set(
    linkEmailIdentity$,
    {
      email,
      userId: auth.userId,
      orgId: auth.orgId,
      reconnect: true,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!link) {
    return conflict(
      "This email is already connected to another account or workspace.",
    );
  }
  return { status: 200 as const, body: { emailAddress: email } };
});

const connectBody$ = bodyResultOf(contract.connect);
const connect$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(enabled$, signal))) {
    return resourceUnavailable("Email integration is not available");
  }
  const auth = get(organizationAuthContext$);
  const body = await get(connectBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const db = set(writeDb$);
  const [message] = await db
    .select()
    .from(emailChannelMessages)
    .where(eq(emailChannelMessages.id, body.data.messageId))
    .limit(1);
  signal.throwIfAborted();
  if (
    !message ||
    !message.authenticated ||
    !validEmailConnectionSignature(
      message,
      body.data.expires,
      body.data.signature,
    )
  ) {
    return badRequestMessage(
      "Invalid or expired email connection link. Send a new email to Okou.",
    );
  }
  const user = await get(clerk$).users.getUser(auth.userId, undefined, signal);
  signal.throwIfAborted();
  if (!ownsVerifiedEmail(user, message.sender)) {
    return resourceUnavailable(
      "Sign in with the verified email address that sent the original message.",
    );
  }
  const link = await set(
    linkEmailIdentity$,
    { email: message.sender, userId: auth.userId, orgId: auth.orgId },
    signal,
  );
  signal.throwIfAborted();
  if (!link) {
    return conflict(
      "This email is connected to another account or workspace, or was disconnected. Reconnect it from its original workspace.",
    );
  }
  await set(processEmailChannelMessage$, { message, link }, signal);
  signal.throwIfAborted();
  return { status: 200 as const, body: { emailAddress: message.sender } };
});

const unlinkBody$ = bodyResultOf(contract.unlink);
const unlink$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(enabled$, signal))) {
    return resourceUnavailable("Email integration is not available");
  }
  const auth = get(organizationAuthContext$);
  const body = await get(unlinkBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const user = await get(clerk$).users.getUser(auth.userId, undefined, signal);
  signal.throwIfAborted();
  if (signInEmailAddress(user) === body.data.emailAddress.toLowerCase()) {
    return resourceUnavailable(
      "Your login email is always connected and cannot be deleted.",
    );
  }
  await set(writeDb$)
    .update(emailUserLinks)
    .set({ disconnectedAt: nowDate() })
    .where(
      and(
        eq(emailUserLinks.emailAddress, body.data.emailAddress.toLowerCase()),
        eq(emailUserLinks.userId, auth.userId),
        eq(emailUserLinks.orgId, auth.orgId),
      ),
    );
  signal.throwIfAborted();
  await publishUserSignal([auth.userId], "email:changed");
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

const createLinkCode$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (
    !(await set(enabled$, signal)) ||
    !optionalEnv("RESEND_API_KEY") ||
    !optionalEnv("RESEND_WEBHOOK_SECRET")
  ) {
    return resourceUnavailable("Email integration is not available");
  }
  const owner = get(organizationAuthContext$);
  const user = await get(clerk$).users.getUser(owner.userId, undefined, signal);
  signal.throwIfAborted();
  if (user.banned) {
    return resourceUnavailable("Email integration is not available");
  }
  return {
    status: 200 as const,
    body: await set(createEmailConnectionCode$, owner, signal),
  };
});

const auth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;
export const integrationsEmailRoutes: readonly RouteEntry[] = [
  { route: contract.createLinkCode, handler: authRoute(auth, createLinkCode$) },
  { route: contract.connectAddress, handler: authRoute(auth, connectAddress$) },
  { route: contract.getLinkStatus, handler: authRoute(auth, getLinkStatus$) },
  { route: contract.connect, handler: authRoute(auth, connect$) },
  { route: contract.unlink, handler: authRoute(auth, unlink$) },
];
