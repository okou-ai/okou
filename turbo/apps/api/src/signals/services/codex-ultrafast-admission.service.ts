import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";
import { array, object, string } from "zod";
import { db$ } from "../external/db";
import {
  personalSubscriptionAccountCiphertextsReadPlan,
  personalSubscriptionAccountCiphertextsFromRows,
  personalSubscriptionCredentialValues,
} from "./model-provider-account.service";
import type { ResolvedModelProviderEnvironment } from "./agent-run-contracts";
import { badRequestMessage, providerUnavailable } from "../../lib/error";

const codexCatalogSchema = object({
  models: array(
    object({
      slug: string(),
      service_tiers: array(object({ id: string() })).default([]),
    }),
  ),
});

export const validateCodexUltrafast$ = command(
  async (
    { get },
    input: {
      readonly orgId: string;
      readonly userId: string;
      readonly featureSwitchContext: FeatureSwitchContext;
      readonly provider: ResolvedModelProviderEnvironment;
    },
    signal: AbortSignal,
  ) => {
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.CodexSubscriptionUltrafast,
        input.featureSwitchContext,
      )
    ) {
      return badRequestMessage("Ultrafast is unavailable in this workspace");
    }
    const { provider } = input;
    if (provider.type !== "codex-oauth-token" || !provider.id) {
      return badRequestMessage(
        "Ultrafast requires a connected Codex subscription",
      );
    }
    const db = get(db$);
    const plan = personalSubscriptionAccountCiphertextsReadPlan({
      orgId: input.orgId,
      userId: input.userId,
      type: provider.type,
      sourceId: provider.id,
    });
    const rows = await db
      .select(plan.columns)
      .from(plan.from)
      .leftJoin(plan.join.table, plan.join.on)
      .where(plan.where);
    const credentials = personalSubscriptionAccountCiphertextsFromRows(rows);
    if (!credentials || credentials.account.needsReconnect) {
      return providerUnavailable(
        "The selected Codex subscription is unavailable",
      );
    }
    const values = await personalSubscriptionCredentialValues(
      credentials.secrets,
      input.featureSwitchContext,
    );
    signal.throwIfAborted();
    const token = values.get("CHATGPT_ACCESS_TOKEN");
    const account = values.get("CHATGPT_ACCOUNT_ID");
    if (
      !token ||
      !account ||
      account !== provider.environment.CODEX_OAUTH_ACCOUNT_ID
    ) {
      return providerUnavailable(
        "The selected Codex subscription is unavailable",
      );
    }
    const unavailable =
      "Couldn't check Ultrafast on this Codex subscription. Try again.";
    try {
      const response = await fetch(
        "https://chatgpt.com/backend-api/codex/models?client_version=0.170.0",
        {
          headers: {
            authorization: `Bearer ${token}`,
            "chatgpt-account-id": account,
            originator: "codex_cli_rs",
            "user-agent": "codex_cli_rs/0.170.0",
          },
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return providerUnavailable(unavailable);
      }
      const catalog = codexCatalogSchema.safeParse(await response.json());
      if (!catalog.success) {
        return providerUnavailable(unavailable);
      }
      const model = catalog.data.models.find(
        ({ slug }) => slug === provider.upstreamModel,
      );
      return model?.service_tiers.some(({ id }) => id === "ultrafast")
        ? undefined
        : badRequestMessage(
            "This Codex subscription doesn't support Ultrafast for the selected model",
          );
    } catch {
      signal.throwIfAborted();
      return providerUnavailable(unavailable);
    }
  },
);
