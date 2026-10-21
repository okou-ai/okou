import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { command } from "ccstate";
import { and, asc, eq } from "drizzle-orm";

import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { fetchFeishuTenantAccessToken } from "../external/feishu-client";
import { settle } from "../utils";
import {
  encryptPersistentSecretValue,
  decryptPersistentSecretValue,
} from "./crypto.utils";
import {
  feishuInstallationConfigReadPlan,
  feishuInstallationConfigFromSecrets,
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
  type FeishuInstallationConfig,
} from "./feishu-config";
import { ensureManagedFeishuConnector$ } from "./feishu-custom-connector.service";

interface ConfigureFeishuArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly platform?: FeishuPlatform;
  readonly appId: string;
  readonly appSecret: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
  readonly installationId?: string;
  readonly createNew?: boolean;
}

export type ConfigureFeishuResult =
  | {
      readonly kind: "ok";
      readonly installationId: string;
      readonly connectorConfigurationChanged: boolean;
    }
  | { readonly kind: "installation_not_found" }
  | { readonly kind: "app_identity_mismatch" }
  | { readonly kind: "app_in_use" }
  | { readonly kind: "installation_exists" };

type PreparedFeishuInstallation =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "changed";
      readonly connectorConfigurationChanged: boolean;
      readonly callbackConfigurationChanged: boolean;
      readonly encryptedAppSecret: string;
      readonly encryptedVerificationToken: string;
      readonly encryptedEncryptKey: string;
      readonly encryptedTenantAccessToken: string;
      readonly tokenExpiresAt: Date;
    };

function feishuInstallationCredentialsMatch(
  input: ConfigureFeishuArgs,
  existing: FeishuInstallationConfig,
): boolean {
  return (
    input.appId === existing.appId &&
    input.appSecret === existing.appSecret &&
    input.verificationToken === existing.verificationToken &&
    input.encryptKey === existing.encryptKey
  );
}

async function prepareFeishuInstallation(
  input: ConfigureFeishuArgs,
  existing: FeishuInstallationConfig | null,
  signal: AbortSignal,
): Promise<PreparedFeishuInstallation> {
  if (existing && feishuInstallationCredentialsMatch(input, existing)) {
    return { kind: "unchanged" };
  }
  const tenantToken = await fetchFeishuTenantAccessToken(
    {
      appId: input.appId,
      platform: input.platform ?? "feishu",
      appSecret: input.appSecret,
    },
    signal,
  );
  const context = {
    orgId: input.orgId,
    userId: input.userId,
  };
  const [
    encryptedAppSecret,
    encryptedVerificationToken,
    encryptedEncryptKey,
    encryptedTenantAccessToken,
  ] = await Promise.all([
    existing && input.appSecret === existing.appSecret
      ? Promise.resolve(existing.encryptedAppSecret)
      : encryptPersistentSecretValue(input.appSecret, context),
    encryptPersistentSecretValue(input.verificationToken, context),
    encryptPersistentSecretValue(input.encryptKey, context),
    encryptPersistentSecretValue(tenantToken.token, context),
  ]);
  signal.throwIfAborted();
  return {
    kind: "changed",
    connectorConfigurationChanged:
      !existing || input.appSecret !== existing.appSecret,
    callbackConfigurationChanged:
      !existing ||
      input.verificationToken !== existing.verificationToken ||
      input.encryptKey !== existing.encryptKey,
    encryptedAppSecret,
    encryptedVerificationToken,
    encryptedEncryptKey,
    encryptedTenantAccessToken,
    tokenExpiresAt: new Date(
      nowDate().getTime() + tenantToken.expiresInSeconds * 1000,
    ),
  };
}

type FeishuInstallationTargetResult =
  | {
      readonly kind: "target";
      readonly installationId: string | undefined;
    }
  | { readonly kind: "installation_not_found" }
  | { readonly kind: "app_identity_mismatch" }
  | { readonly kind: "app_in_use" }
  | { readonly kind: "installation_exists" };

const resolveFeishuInstallationTarget$ = command(
  async (
    { get },
    args: ConfigureFeishuArgs,
    signal: AbortSignal,
  ): Promise<FeishuInstallationTargetResult> => {
    const db = get(db$);
    const [appOwner] = await db
      .select({
        id: feishuOrgInstallations.id,
        orgId: feishuOrgInstallations.orgId,
        platform: feishuOrgInstallations.platform,
      })
      .from(feishuOrgInstallations)
      .where(eq(feishuOrgInstallations.appId, args.appId))
      .limit(1);
    signal.throwIfAborted();
    if (
      appOwner &&
      (appOwner.orgId !== args.orgId ||
        appOwner.platform !== (args.platform ?? "feishu"))
    ) {
      return { kind: "app_in_use" };
    }
    if (
      args.installationId &&
      appOwner &&
      appOwner.id !== args.installationId
    ) {
      return { kind: "app_in_use" };
    }
    let targetInstallationId =
      args.installationId ?? (args.createNew ? undefined : appOwner?.id);
    if (!targetInstallationId) {
      const [existingInstallation] = await db
        .select({ id: feishuOrgInstallations.id })
        .from(feishuOrgInstallations)
        .where(
          and(
            eq(feishuOrgInstallations.orgId, args.orgId),
            eq(feishuOrgInstallations.platform, args.platform ?? "feishu"),
          ),
        )
        .orderBy(asc(feishuOrgInstallations.createdAt))
        .limit(1);
      signal.throwIfAborted();
      if (existingInstallation && args.createNew) {
        return { kind: "installation_exists" };
      }
      targetInstallationId = existingInstallation?.id;
    }
    if (targetInstallationId) {
      const [installation] = await db
        .select({
          id: feishuOrgInstallations.id,
          appId: feishuOrgInstallations.appId,
        })
        .from(feishuOrgInstallations)
        .where(
          and(
            eq(feishuOrgInstallations.id, targetInstallationId),
            eq(feishuOrgInstallations.orgId, args.orgId),
            eq(feishuOrgInstallations.platform, args.platform ?? "feishu"),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!installation) {
        return { kind: "installation_not_found" };
      }
      if (installation.appId !== args.appId) {
        return { kind: "app_identity_mismatch" };
      }
    }
    return { kind: "target", installationId: targetInstallationId };
  },
);

const persistFeishuInstallation$ = command(
  async (
    { set },
    args: {
      readonly input: ConfigureFeishuArgs;
      readonly prepared: PreparedFeishuInstallation;
      readonly targetInstallationId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<ConfigureFeishuResult> => {
    const db = set(writeDb$);
    let targetInstallationId = args.targetInstallationId;
    if (!targetInstallationId) {
      if (args.prepared.kind === "unchanged") {
        throw new Error("A new Feishu installation requires credentials");
      }
      const inserted = await settle(
        db
          .insert(feishuOrgInstallations)
          .values({
            orgId: args.input.orgId,
            ownerUserId: args.input.userId,
            appId: args.input.appId,
            platform: args.input.platform ?? "feishu",
            encryptedAppSecret: args.prepared.encryptedAppSecret,
            encryptedVerificationToken:
              args.prepared.encryptedVerificationToken,
            encryptedEncryptKey: args.prepared.encryptedEncryptKey,
            encryptedTenantAccessToken:
              args.prepared.encryptedTenantAccessToken,
            tenantAccessTokenExpiresAt: args.prepared.tokenExpiresAt,
          })
          .returning({ id: feishuOrgInstallations.id }),
        signal,
      );
      if (inserted.ok) {
        const [created] = inserted.value;
        if (!created) {
          throw new Error("Expected a Feishu installation to be created");
        }
        return {
          kind: "ok",
          installationId: created.id,
          connectorConfigurationChanged: true,
        };
      }
      if (
        !isUniqueViolation(
          inserted.error,
          "idx_feishu_org_installations_app",
        ) &&
        !isUniqueViolation(
          inserted.error,
          "idx_feishu_org_installations_org_platform",
        )
      ) {
        throw inserted.error;
      }
      const target = await set(
        resolveFeishuInstallationTarget$,
        args.input,
        signal,
      );
      if (target.kind !== "target") {
        return target;
      }
      if (!target.installationId) {
        return { kind: "installation_not_found" };
      }

      // A unique-conflict replay may update only the freshly resolved owned target.
      targetInstallationId = target.installationId;
    }
    const [updated] = await db
      .update(feishuOrgInstallations)
      .set({
        ...(args.prepared.kind === "changed"
          ? {
              encryptedAppSecret: args.prepared.encryptedAppSecret,
              encryptedVerificationToken:
                args.prepared.encryptedVerificationToken,
              encryptedEncryptKey: args.prepared.encryptedEncryptKey,
              encryptedTenantAccessToken:
                args.prepared.encryptedTenantAccessToken,
              tenantAccessTokenExpiresAt: args.prepared.tokenExpiresAt,
              ...(args.prepared.callbackConfigurationChanged
                ? { callbackVerifiedAt: null }
                : {}),
            }
          : {}),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(feishuOrgInstallations.id, targetInstallationId),
          eq(feishuOrgInstallations.orgId, args.input.orgId),
          eq(feishuOrgInstallations.platform, args.input.platform ?? "feishu"),
          eq(feishuOrgInstallations.appId, args.input.appId),
        ),
      )
      .returning({ id: feishuOrgInstallations.id });
    signal.throwIfAborted();
    if (!updated) {
      return { kind: "installation_not_found" };
    }
    return {
      kind: "ok",
      installationId: updated.id,
      connectorConfigurationChanged:
        args.prepared.kind === "changed" &&
        args.prepared.connectorConfigurationChanged,
    };
  },
);

export const configureFeishuInstallation$ = command(
  async (
    { set },
    args: ConfigureFeishuArgs,
    signal: AbortSignal,
  ): Promise<ConfigureFeishuResult> => {
    const db = set(writeDb$);
    const preflight = await set(resolveFeishuInstallationTarget$, args, signal);
    if (preflight.kind !== "target") {
      return preflight;
    }
    const installationId = preflight.installationId;
    const existing = installationId
      ? await (async () => {
          const plan = feishuInstallationConfigReadPlan(installationId);
          const [installation] = await db
            .select(plan.columns)
            .from(feishuOrgInstallations)
            .where(plan.condition)
            .limit(1);
          if (
            !installation ||
            !(await (async () => {
              const availability =
                feishuInstallationAvailabilityReadPlan(installation);
              if (availability.kind === "resolved") {
                return availability.enabled;
              }
              const rows = await db
                .select(availability.columns)
                .from(userFeatureSwitches)
                .where(availability.condition);
              return feishuInstallationEnabledFromRows(
                availability.scope,
                rows,
              );
            })())
          ) {
            return null;
          }
          const context = { orgId: installation.orgId };
          const secrets = await Promise.all([
            decryptPersistentSecretValue(
              installation.encryptedAppSecret,
              context,
            ),
            decryptPersistentSecretValue(
              installation.encryptedVerificationToken,
              context,
            ),
            decryptPersistentSecretValue(
              installation.encryptedEncryptKey,
              context,
            ),
          ]);
          return feishuInstallationConfigFromSecrets(installation, secrets);
        })()
      : null;
    signal.throwIfAborted();
    if (existing && existing.appId !== args.appId) {
      return { kind: "app_identity_mismatch" };
    }
    const prepared = await prepareFeishuInstallation(args, existing, signal);
    const result = await set(
      persistFeishuInstallation$,
      {
        input: args,
        prepared,
        targetInstallationId: preflight.installationId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "ok") {
      await set(
        ensureManagedFeishuConnector$,
        {
          orgId: args.orgId,
          userId: args.userId,
          installationId: result.installationId,
          configurationChanged: result.connectorConfigurationChanged,
        },
        signal,
      );
      signal.throwIfAborted();
    }
    return result;
  },
);
