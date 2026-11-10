import { command } from "ccstate";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  and,
  count,
  gte,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  emailConnectionCodes,
  emailUserLinks,
} from "@okouai/db/schema/email-integration";
import { connectors } from "@okouai/db/schema/connector";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { nowDate } from "../../lib/time";
import { env } from "../../lib/env";
import { email } from "zod";

export const linkEmailIdentity$ = command(
  async (
    { set },
    args: {
      readonly email: string;
      readonly userId: string;
      readonly orgId: string;
      readonly reconnect?: boolean;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    if (args.reconnect) {
      const previous = db.$with("disconnected_email").as(
        db
          .delete(emailUserLinks)
          .where(
            and(
              eq(emailUserLinks.emailAddress, args.email),
              isNotNull(emailUserLinks.disconnectedAt),
            ),
          )
          .returning(),
      );
      await db
        .with(previous)
        .insert(emailUserLinks)
        .select(
          db
            .select({
              id: sql`${randomUUID()}::uuid`
                .mapWith(emailUserLinks.id)
                .as("id"),
              emailAddress: previous.emailAddress,
              userId: sql`${args.userId}::text`
                .mapWith(emailUserLinks.userId)
                .as("user_id"),
              orgId: sql`${args.orgId}::text`
                .mapWith(emailUserLinks.orgId)
                .as("org_id"),
              disconnectedAt: sql`NULL::timestamp`
                .mapWith(emailUserLinks.disconnectedAt)
                .as("disconnected_at"),
              createdAt: sql`now()`
                .mapWith(emailUserLinks.createdAt)
                .as("created_at"),
            })
            .from(previous)
            .where(sql`true`),
        )
        .onConflictDoNothing({ target: emailUserLinks.emailAddress });
      signal.throwIfAborted();
    }
    await db
      .insert(emailUserLinks)
      .values({
        emailAddress: args.email,
        userId: args.userId,
        orgId: args.orgId,
      })
      .onConflictDoNothing({ target: emailUserLinks.emailAddress });
    signal.throwIfAborted();
    const [link] = await db
      .select()
      .from(emailUserLinks)
      .where(eq(emailUserLinks.emailAddress, args.email))
      .limit(1);
    signal.throwIfAborted();
    if (
      link?.userId === args.userId &&
      link.orgId === args.orgId &&
      !link.disconnectedAt
    ) {
      await publishUserSignal([args.userId], "email:changed");
      signal.throwIfAborted();
    }
    return link?.userId === args.userId &&
      link.orgId === args.orgId &&
      !link.disconnectedAt
      ? link
      : null;
  },
);

const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CODE_PATTERN = /^OKOU-[A-F0-9]{16}$/iu;

export function emailConnectionCodeFromText(text: string): string | null {
  const firstLine = text.trim().split(/\r?\n/u)[0] ?? "";
  return EMAIL_CODE_PATTERN.test(firstLine) ? firstLine.toUpperCase() : null;
}

function hashEmailCode(code: string): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`email-connection-code:v1:${code}`)
    .digest("hex");
}

export const createEmailConnectionCode$ = command(
  async (
    { set },
    owner: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const code = `OKOU-${randomBytes(8).toString("hex").toUpperCase()}`;
    const createdAt = nowDate();
    const expiresAt = new Date(createdAt.getTime() + EMAIL_CODE_TTL_MS);
    await set(writeDb$)
      .insert(emailConnectionCodes)
      .values({
        userId: owner.userId,
        orgId: owner.orgId,
        codeHash: hashEmailCode(code),
        createdAt,
        expiresAt,
      });
    signal.throwIfAborted();
    return { code, expiresAt: expiresAt.toISOString() };
  },
);

const claimEmailConnectionCode$ = command(
  async (
    { set },
    args: {
      readonly codeHash: string;
      readonly sender: string;
      readonly providerEmailId: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const claimed = db.$with("claimed_email_code").as(
      db
        .update(emailConnectionCodes)
        .set({
          consumedAt: nowDate(),
          consumedEmail: args.sender,
          consumedProviderEmailId: args.providerEmailId,
        })
        .where(
          and(
            eq(emailConnectionCodes.codeHash, args.codeHash),
            isNull(emailConnectionCodes.consumedAt),
            gt(emailConnectionCodes.expiresAt, nowDate()),
          ),
        )
        .returning({
          userId: emailConnectionCodes.userId,
          orgId: emailConnectionCodes.orgId,
        }),
    );
    const previous = db.$with("disconnected_email").as(
      db
        .delete(emailUserLinks)
        .where(
          and(
            eq(emailUserLinks.emailAddress, args.sender),
            isNotNull(emailUserLinks.disconnectedAt),
            exists(db.select().from(claimed)),
          ),
        )
        .returning({ id: emailUserLinks.id }),
    );
    // Finish retiring the old unique key before inserting its replacement.
    const retired = db
      .select({ count: count().as("count") })
      .from(previous)
      .as("retired_email");
    const [linked] = await db
      .with(claimed, previous)
      .insert(emailUserLinks)
      .select(
        db
          .select({
            id: sql`${randomUUID()}::uuid`.mapWith(emailUserLinks.id).as("id"),
            emailAddress: sql`${args.sender}::text`
              .mapWith(emailUserLinks.emailAddress)
              .as("email_address"),
            userId: claimed.userId,
            orgId: claimed.orgId,
            disconnectedAt: sql`NULL::timestamp`
              .mapWith(emailUserLinks.disconnectedAt)
              .as("disconnected_at"),
            createdAt: sql`now()`
              .mapWith(emailUserLinks.createdAt)
              .as("created_at"),
          })
          .from(claimed)
          .crossJoin(retired)
          .where(gte(retired.count, 0)),
      )
      .onConflictDoUpdate({
        target: emailUserLinks.emailAddress,
        set: { emailAddress: args.sender },
        setWhere: and(
          eq(emailUserLinks.userId, args.userId),
          eq(emailUserLinks.orgId, args.orgId),
          isNull(emailUserLinks.disconnectedAt),
        ),
      })
      .returning();
    signal.throwIfAborted();
    return linked;
  },
);

export const consumeEmailConnectionCode$ = command(
  async (
    { get, set },
    args: {
      readonly code: string;
      readonly sender: string;
      readonly providerEmailId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const codeHash = hashEmailCode(args.code);
    const [code] = await db
      .select()
      .from(emailConnectionCodes)
      .where(eq(emailConnectionCodes.codeHash, codeHash))
      .limit(1);
    signal.throwIfAborted();
    if (!code) {
      return { kind: "ignored" } as const;
    }
    const user = await findClerkUser(get(clerk$), code.userId, signal);
    signal.throwIfAborted();
    if (!user || user.banned) {
      return { kind: "ignored" } as const;
    }
    const role = await set(
      getMemberRoleAndUpdateCache$,
      code.orgId,
      code.userId,
      signal,
    );
    const features = await set(
      loadUserFeatureSwitchContext$,
      code.orgId,
      code.userId,
      signal,
    );
    signal.throwIfAborted();
    if (
      role.kind !== "member" ||
      !isFeatureEnabled(FeatureSwitchKey.EmailIntegration, features)
    ) {
      return { kind: "ignored" } as const;
    }
    if (code.consumedAt) {
      return await set(
        replayEmailConnectionCode$,
        { ...args, codeHash },
        signal,
      );
    }
    if (code.expiresAt <= nowDate()) {
      return { kind: "invalid" } as const;
    }
    const linked = await set(
      claimEmailConnectionCode$,
      { ...args, codeHash, userId: code.userId, orgId: code.orgId },
      signal,
    );
    signal.throwIfAborted();
    if (linked) {
      await publishUserSignal([code.userId], "email:changed");
      signal.throwIfAborted();
      return { kind: "linked", link: linked } as const;
    }
    return await set(replayEmailConnectionCode$, { ...args, codeHash }, signal);
  },
);

export const connectedMailAccounts$ = command(
  async (
    { set },
    owner: { readonly userId: string; readonly orgId: string },
    signal: AbortSignal,
  ) => {
    const accounts = await set(writeDb$)
      .select({ email: connectors.externalEmail })
      .from(connectors)
      .where(
        and(
          eq(connectors.userId, owner.userId),
          eq(connectors.orgId, owner.orgId),
          inArray(connectors.connectorSlug, ["gmail", "outlook-mail"]),
          or(
            eq(connectors.authMethod, "oauth"),
            eq(connectors.automaticAuthType, "oauth"),
          ),
          eq(connectors.needsReconnect, false),
          isNotNull(connectors.externalId),
          isNotNull(connectors.externalEmail),
        ),
      );
    signal.throwIfAborted();
    return accounts;
  },
);

export const connectEmailFromMailAccount$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorSlug: string;
      readonly email: string | null;
      readonly featureSwitchContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ) => {
    const address = email().safeParse(args.email?.toLowerCase());
    if (
      (args.connectorSlug !== "gmail" &&
        args.connectorSlug !== "outlook-mail") ||
      !address.success
    ) {
      return;
    }
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.EmailIntegration,
        args.featureSwitchContext,
      )
    ) {
      return;
    }
    // Email linking must not replace another workspace's active sender binding.
    await set(
      linkEmailIdentity$,
      {
        email: address.data,
        orgId: args.orgId,
        userId: args.userId,
        reconnect: true,
      },
      signal,
    );
  },
);

const replayEmailConnectionCode$ = command(
  async (
    { set },
    args: {
      readonly codeHash: string;
      readonly sender: string;
      readonly providerEmailId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [code] = await db
      .select()
      .from(emailConnectionCodes)
      .where(eq(emailConnectionCodes.codeHash, args.codeHash))
      .limit(1);
    signal.throwIfAborted();
    if (
      code?.consumedEmail !== args.sender ||
      code.consumedProviderEmailId !== args.providerEmailId
    ) {
      return { kind: "invalid" } as const;
    }
    const [link] = await db
      .select()
      .from(emailUserLinks)
      .where(eq(emailUserLinks.emailAddress, args.sender))
      .limit(1);
    signal.throwIfAborted();
    if (!link || link.disconnectedAt) {
      return { kind: "invalid" } as const;
    }
    if (link.userId !== code.userId || link.orgId !== code.orgId) {
      return { kind: "conflict" } as const;
    }
    await publishUserSignal([code.userId], "email:changed");
    signal.throwIfAborted();
    return { kind: "linked", link } as const;
  },
);
