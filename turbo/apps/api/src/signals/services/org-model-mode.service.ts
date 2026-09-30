import { command } from "ccstate";
import { and, eq, ne, notInArray } from "drizzle-orm";
import {
  modelProviderTypeSchema,
  type OrgModelMode,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { modelProviderConnections } from "@okouai/db/schema/model-provider-gateway";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";

import { badRequestMessage, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { deleteModelProviderConnection$ } from "./model-provider-gateway.service";
import { deleteOrgModelProvider$ } from "./model-provider.service";
import {
  listOrgModelPolicies$,
  updateOrgModelPolicies$,
} from "./model-policy.service";

const ORG_SENTINEL_USER_ID = "__org__";

type PolicyWriteFailure = Exclude<
  Awaited<ReturnType<typeof updateOrgModelPolicies$.write>>,
  { readonly ok: true }
>;

type OrgModelModeResult =
  | { readonly ok: true; readonly mode: OrgModelMode }
  | {
      readonly ok: false;
      readonly response:
        | ReturnType<typeof notFound>
        | ReturnType<typeof badRequestMessage>
        | Extract<
            PolicyWriteFailure,
            { readonly response: unknown }
          >["response"];
    };

function policyWriteFailure(result: PolicyWriteFailure): OrgModelModeResult {
  return {
    ok: false,
    response:
      "response" in result
        ? result.response
        : badRequestMessage(result.message),
  };
}

interface ModeParams {
  readonly orgId: string;
  readonly userId: string;
}

/** Remove org-owned credentials with their existing single-resource writers. */
const removeOrgProviderConnections$ = command(
  async ({ set }, orgId: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    const legacyProviders = await db
      .select({ type: modelProviders.type })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, orgId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
          ne(modelProviders.type, "built-in"),
        ),
      );
    signal.throwIfAborted();
    for (const provider of legacyProviders) {
      await set(
        deleteOrgModelProvider$,
        { orgId, type: modelProviderTypeSchema.parse(provider.type) },
        signal,
      );
    }
    const connections = await db
      .select({ id: modelProviderConnections.id })
      .from(modelProviderConnections)
      .where(eq(modelProviderConnections.orgId, orgId));
    signal.throwIfAborted();
    for (const connection of connections) {
      await set(
        deleteModelProviderConnection$,
        { orgId, connectionId: connection.id },
        signal,
      );
    }
  },
);

/**
 * Reset policies and remove org-owned connections first, then flip the mode
 * last: a failed step leaves the org in Custom, and a retry repeats the
 * idempotent cleanup.
 */
const enterAutoMode$ = command(
  async (
    { set },
    params: ModeParams & { readonly currentMode: OrgModelMode },
    signal: AbortSignal,
  ): Promise<OrgModelModeResult> => {
    if (params.currentMode !== "auto") {
      const snapshot = await set(listOrgModelPolicies$, params, signal);
      const written = await set(
        updateOrgModelPolicies$,
        {
          orgId: params.orgId,
          userId: params.userId,
          revision: snapshot.revision,
          policies: [
            {
              model: "okou-1.0",
              isDefault: true,
              defaultProviderType: "built-in",
              credentialScope: "org",
              modelProviderId: null,
            },
          ],
        },
        signal,
      );
      if (!written.ok) {
        return policyWriteFailure(written);
      }
    }
    await set(removeOrgProviderConnections$, params.orgId, signal);
    await set(writeDb$)
      .update(orgMetadata)
      .set({ modelMode: "auto", updatedAt: nowDate() })
      .where(
        and(
          eq(orgMetadata.orgId, params.orgId),
          eq(orgMetadata.modelMode, "custom"),
        ),
      );
    signal.throwIfAborted();
    return { ok: true, mode: "auto" };
  },
);

/** Subscription models were member-only; Custom members select org policies. */
const enterCustomMode$ = command(
  async ({ set }, orgId: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    await db
      .update(orgMetadata)
      .set({ modelMode: "custom", updatedAt: nowDate() })
      .where(
        and(eq(orgMetadata.orgId, orgId), eq(orgMetadata.modelMode, "auto")),
      );
    signal.throwIfAborted();
    // Reconcile on every Custom request so a retry repairs a partial switch.
    const policies = await db
      .select({
        model: orgModelPolicies.model,
        isDefault: orgModelPolicies.isDefault,
      })
      .from(orgModelPolicies)
      .where(eq(orgModelPolicies.orgId, orgId));
    signal.throwIfAborted();
    const defaultPolicy = policies.find((policy) => {
      return policy.isDefault;
    });
    if (!defaultPolicy) {
      return;
    }
    await db
      .update(orgMembersMetadata)
      .set({
        selectedModel: defaultPolicy.model,
        serviceTier: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          notInArray(
            orgMembersMetadata.selectedModel,
            policies.map((policy) => {
              return policy.model;
            }),
          ),
        ),
      );
    signal.throwIfAborted();
  },
);

/** Debug-only mode switch built from the existing policy and connection writers. */
export const updateOrgModelMode$ = command(
  async (
    { set },
    params: ModeParams & { readonly mode: OrgModelMode },
    signal: AbortSignal,
  ): Promise<OrgModelModeResult> => {
    const [org] = await set(writeDb$)
      .select({ mode: orgMetadata.modelMode })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, params.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (!org) {
      return { ok: false, response: notFound("Organization not found") };
    }
    if (params.mode === "auto") {
      return await set(
        enterAutoMode$,
        {
          orgId: params.orgId,
          userId: params.userId,
          currentMode: org.mode === "auto" ? "auto" : "custom",
        },
        signal,
      );
    }
    await set(enterCustomMode$, params.orgId, signal);
    return { ok: true, mode: "custom" };
  },
);
