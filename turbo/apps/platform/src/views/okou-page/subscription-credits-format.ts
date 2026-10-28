import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { i18n } from "../../i18n/index.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";

/** Missing snapshots are unsupported/disabled; null snapshots are unavailable. */
export function formatSubscriptionCredits({
  type,
  subscriptionCredits: credits,
}: Pick<ModelProviderResponse, "type" | "subscriptionCredits">): {
  label: string;
  value: string;
  text: string;
} | null {
  if (
    credits === undefined ||
    (type !== "codex-oauth-token" && type !== "claude-code-oauth-token")
  ) {
    return null;
  }
  const provider = type === "codex-oauth-token" ? "ChatGPT" : "Claude";
  const label = i18n.t(
    ($) => {
      return $.settings.models.personal.creditsLabel;
    },
    { provider },
  );
  const value = credits?.unlimited
    ? i18n.t(($) => {
        return $.settings.models.personal.creditsUnlimited;
      })
    : credits === null || credits.balance === null
      ? "—"
      : credits.balance > 0 && credits.balance < 0.01
        ? `< ${formatLocalizedNumber(0.01)}`
        : formatLocalizedNumber(credits.balance, { maximumFractionDigits: 2 });
  const text = i18n.t(
    ($) => {
      return $.settings.models.personal.creditsBalance;
    },
    { provider, value },
  );
  return { label, value, text };
}
