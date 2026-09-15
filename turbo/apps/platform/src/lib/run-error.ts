import {
  CHAT_RUN_CONTENT_POLICY_REJECTED_MESSAGE,
  CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE,
  CHAT_RUN_TRANSIENT_ERROR_MESSAGE,
  CLAUDE_CODE_ANTHROPIC_API_KEY_ADMIN_MESSAGE,
  CLAUDE_CODE_ANTHROPIC_API_KEY_MEMBER_MESSAGE,
  CLAUDE_CODE_SUBSCRIPTION_RECONNECT_REQUIRED_MESSAGE,
  CLAUDE_CODE_TERMS_ACCEPTANCE_REQUIRED_MESSAGE,
  CLAUDE_PROVIDER_OVERLOADED_GUIDANCE,
  CODEX_OAUTH_RECONNECT_REQUIRED_MESSAGE,
  CODEX_PROVIDER_OVERLOADED_MESSAGE,
  INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE,
} from "@okouai/api-contracts/contracts/errors";
import {
  MODEL_UNAVAILABLE_MESSAGE,
  PROVIDER_INSUFFICIENT_CREDITS_MESSAGE,
} from "@okouai/api-contracts/contracts/run-balance-errors";
import { i18n } from "../i18n/index.ts";

function localizedCredentialError(message: string): string | undefined {
  switch (message) {
    case CODEX_OAUTH_RECONNECT_REQUIRED_MESSAGE: {
      return i18n.t(($) => {
        return $.runErrors.codexReconnect;
      });
    }
    case CLAUDE_CODE_SUBSCRIPTION_RECONNECT_REQUIRED_MESSAGE: {
      return i18n.t(($) => {
        return $.runErrors.claudeReconnect;
      });
    }
    case CLAUDE_CODE_ANTHROPIC_API_KEY_ADMIN_MESSAGE: {
      return i18n.t(($) => {
        return $.runErrors.anthropicKeyAdmin;
      });
    }
    case CLAUDE_CODE_ANTHROPIC_API_KEY_MEMBER_MESSAGE: {
      return i18n.t(($) => {
        return $.runErrors.anthropicKeyMember;
      });
    }
    case CLAUDE_CODE_TERMS_ACCEPTANCE_REQUIRED_MESSAGE: {
      return i18n.t(($) => {
        return $.runErrors.claudeTerms;
      });
    }
    default: {
      return undefined;
    }
  }
}

function localizedRunErrorText(message: string): string | undefined {
  switch (message) {
    case PROVIDER_INSUFFICIENT_CREDITS_MESSAGE: {
      return i18n.t(($) => {
        return $.runErrors.providerBalance;
      });
    }
    case MODEL_UNAVAILABLE_MESSAGE: {
      return i18n.t(($) => {
        return $.runErrors.modelUnavailable;
      });
    }
    case CHAT_RUN_TRANSIENT_ERROR_MESSAGE: {
      return i18n.t(($) => {
        return $.runErrors.transient;
      });
    }
    case CHAT_RUN_CONTENT_POLICY_REJECTED_MESSAGE: {
      return i18n.t(($) => {
        return $.runErrors.contentPolicyRejected;
      });
    }
    case CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE: {
      return i18n.t(($) => {
        return $.runErrors.executionTimeout;
      });
    }
    case INSUFFICIENT_CREDITS_ASK_ADMIN_MESSAGE: {
      return i18n.t(($) => {
        return $.runErrors.askAdmin;
      });
    }
    case "insufficient_credits": {
      return i18n.t(($) => {
        return $.chat.billing.outOfCredits;
      });
    }
    case "pro_required": {
      return i18n.t(($) => {
        return $.activity.detail.errorGuidance.paidPlanRequired.title;
      });
    }
    case "Insufficient credits. Add credits or configure your own API key to continue.":
    case "API Error: 402 Insufficient credits. Add credits or configure your own API key to continue.": {
      return i18n.t(($) => {
        return $.runErrors.vm0Credits;
      });
    }
    case "Run failed": {
      return i18n.t(($) => {
        return $.runErrors.failed;
      });
    }
    case "Run cancelled": {
      return i18n.t(($) => {
        return $.chat.errors.runCancelled;
      });
    }
    case CODEX_PROVIDER_OVERLOADED_MESSAGE: {
      return i18n.t(($) => {
        return $.runErrors.codexOverloaded;
      });
    }
    default: {
      const suffix = ` ${CLAUDE_PROVIDER_OVERLOADED_GUIDANCE}`;
      if (message.endsWith(suffix)) {
        return i18n.t(
          ($) => {
            return $.runErrors.overloaded;
          },
          {
            model: message.slice(0, -suffix.length),
          },
        );
      }
      return (
        localizedCredentialError(message) ?? localizedModelAvailability(message)
      );
    }
  }
}

function localizedModelAvailability(message: string): string | undefined {
  switch (message) {
    case "Every built-in model route for this model is temporarily unavailable":
    case "Every built-in model route for this model is temporarily unavailable. Please try again later.": {
      return i18n.t(($) => {
        return $.runErrors.modelRoutesUnavailable;
      });
    }
    case "Model temporarily unavailable": {
      return i18n.t(($) => {
        return $.runErrors.modelTemporarilyUnavailable;
      });
    }
    case "The model provider is temporarily unavailable. Please try again later.": {
      return i18n.t(($) => {
        return $.activity.detail.errorGuidance.providerTemporarilyUnavailable
          .guidance;
      });
    }
    case "Provider temporarily unavailable": {
      return i18n.t(($) => {
        return $.activity.detail.errorGuidance.providerTemporarilyUnavailable
          .title;
      });
    }
    case "Concurrent run limit reached": {
      return i18n.t(($) => {
        return $.activity.detail.errorGuidance.concurrentRunLimitReached.title;
      });
    }
    case "Wait for your current run to complete before starting a new one.": {
      return i18n.t(($) => {
        return $.activity.detail.errorGuidance.concurrentRunLimitReached
          .guidance;
      });
    }
    default: {
      return undefined;
    }
  }
}

function localizedRunErrorAction(action: string): string {
  const separator = action.indexOf(": ");
  if (separator === -1) {
    return action;
  }
  const label = action.slice(0, separator);
  const localized = (() => {
    switch (label) {
      case "Reconnect Claude Code": {
        return i18n.t(($) => {
          return $.runErrors.actions.reconnectClaude;
        });
      }
      case "Open Model Providers": {
        return i18n.t(($) => {
          return $.runErrors.actions.openModelProviders;
        });
      }
      case "Share with an admin": {
        return i18n.t(($) => {
          return $.runErrors.actions.shareWithAdmin;
        });
      }
      case "Add credits": {
        return i18n.t(($) => {
          return $.runErrors.actions.addCredits;
        });
      }
      case "Compare plans": {
        return i18n.t(($) => {
          return $.chat.billing.comparePlans;
        });
      }
      default: {
        return undefined;
      }
    }
  })();
  return localized === undefined
    ? action
    : `${localized}${action.slice(separator)}`;
}

/** Translate platform-authored error copy at render time, preserving diagnostics and action URLs. */
export function localizedRunError(error: string): string {
  const parts = error.split("\n\n");
  const localized = localizedRunErrorText(parts[0]!);
  return localized === undefined
    ? error
    : [localized, ...parts.slice(1).map(localizedRunErrorAction)].join("\n\n");
}
