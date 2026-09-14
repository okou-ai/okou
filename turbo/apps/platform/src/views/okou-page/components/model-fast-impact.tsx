import {
  isBuiltInModelProviderType,
  type OrgModelPolicy,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { useTranslation } from "react-i18next";

// ChatGPT speed guidance differs from OpenAI API Fast processing:
// https://developers.openai.com/codex/speed
// https://developers.openai.com/codex/changelog (CLI 0.153.2, Astra correction)
const CHATGPT_FAST_MODEL_SPEED: Readonly<
  Partial<Record<SupportedRunModel, number>>
> = Object.freeze({
  "gpt-6-astra": 2,
  "gpt-5.6-sol": 1.5,
  "gpt-5.6-terra": 1.5,
  "gpt-5.6-luna": 1.5,
});

export function ModelFastImpact({ policy }: { policy: OrgModelPolicy }) {
  const { t } = useTranslation();
  const builtIn = isBuiltInModelProviderType(policy.defaultProviderType);
  const provider = builtIn
    ? policy.runtimeProviderType
    : policy.defaultProviderType;
  let speed = t(($) => {
    return $.settings.models.picker.fastImpact.providerSpeed;
  });
  const chatGptSpeed = CHATGPT_FAST_MODEL_SPEED[policy.model];
  if (provider === "codex-oauth-token" && chatGptSpeed !== undefined) {
    speed = t(
      ($) => {
        return $.settings.models.picker.fastImpact.modelSpeed;
      },
      { multiplier: chatGptSpeed },
    );
  } else if (provider === "openai-api-key") {
    // Only Sol has a model-specific API speed multiplier in the Fast guide:
    // https://developers.openai.com/api/docs/guides/fast-mode
    speed =
      policy.model === "gpt-5.6-sol"
        ? t(($) => {
            return $.settings.models.picker.fastImpact.solApiSpeed;
          })
        : t(($) => {
            return $.settings.models.picker.fastImpact.fasterResponses;
          });
  }

  let usage = t(($) => {
    return $.settings.models.picker.fastImpact.providerUsage;
  });
  if (builtIn) {
    // The supported built-in GPT models use 2x Standard token prices for Fast.
    usage = t(($) => {
      return $.settings.models.picker.fastImpact.okouCredits;
    });
  } else if (provider === "codex-oauth-token") {
    usage = t(($) => {
      return $.settings.models.picker.fastImpact.chatGptUsage;
    });
  } else if (provider === "openai-api-key") {
    usage = t(($) => {
      return $.settings.models.picker.fastImpact.apiCost;
    });
  }
  return t(
    ($) => {
      return $.settings.models.picker.fastImpact.summary;
    },
    { speed, usage },
  );
}
