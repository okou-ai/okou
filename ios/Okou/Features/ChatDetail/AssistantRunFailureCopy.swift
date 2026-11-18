import ChatDomain
import Foundation

extension AssistantFailureCopy {
  /// Every known case needs both fields; future wire tokens are normalized by the caller.
  static func structured(_ reason: KnownRunFailureReason) -> (title: String, description: String) {
    (String(localized: titleKey(reason)), String(localized: descriptionKey(reason)))
  }

  private static func titleKey(_ reason: KnownRunFailureReason) -> String.LocalizationValue {
    switch reason {
    case .sessionHistoryLimit: "This chat has reached its limit"
    case .guestRootFilesystemFull, .guestHomeFilesystemFull: "This run ran out of space"
    case .executionTimeout: "Time limit reached"
    case .providerInsufficientCredits: "Your subscription account needs more credit"
    case .invalidApiKey: "Your subscription sign-in needs updating"
    case .invalidCredentials: "Your model connection needs attention"
    case .termsAcceptanceRequired: "Claude terms need acceptance"
    case .contextWindowExceeded: "This chat is too long"
    case .inputTooLarge, .providerImageTooLarge: "Your message is too large"
    case .outputTokenLimit: "The response reached its length limit"
    case .providerRateLimited: "Too many model requests right now"
    case .providerOverloaded: "This model is busy right now"
    case .providerStreamTimeout, .providerRequestTimeout: "The model response timed out"
    case .providerQueueTimeout: "The model didn't start in time"
    case .codexAccessProgramUnavailable: "Codex access is temporarily unavailable"
    case .providerServerError: "The model provider had a temporary error"
    case .responseConnectionLost: "The response was interrupted"
    case .safetyPolicyRefusal: "The model couldn't help with this request"
    case .reconnectRequired: "Reconnect your model account"
    case .unsupportedModel, .providerModelRestricted: "Selected model isn't available"
    case .usageLimit: "Model provider limit reached"
    case .unknown, .guestMemoryOomKilled, .firewallAuthFailed: "This run couldn't finish"
    case .insufficientCredits: "Out of credits"
    case .accountVerificationRequired: "Claude account verification required"
    case .providerBadRequest: "The model provider returned an error"
    }
  }

  private static func descriptionKey(_ reason: KnownRunFailureReason) -> String.LocalizationValue {
    switch reason {
    case .sessionHistoryLimit, .contextWindowExceeded:
      "Start a new chat and include any important details you want to carry over."
    case .guestRootFilesystemFull, .guestHomeFilesystemFull:
      "This run couldn't save more files. Try again to continue."
    case .executionTimeout: "You can continue from where this run stopped."
    case .providerInsufficientCredits:
      "Check your subscription account's usage or credit balance, then try again."
    case .invalidApiKey, .invalidCredentials, .reconnectRequired:
      "Open Settings > Models to reconnect or update your account, then try again."
    case .termsAcceptanceRequired: "Accept Claude's latest terms, then come back and try again."
    case .inputTooLarge, .providerImageTooLarge: "Shorten your message and send it again."
    case .outputTokenLimit:
      "The response stopped before it finished. Continue to pick up from there."
    case .providerRateLimited, .providerOverloaded, .providerStreamTimeout, .providerQueueTimeout,
      .providerServerError, .responseConnectionLost, .providerRequestTimeout:
      "Try again in a moment, or choose another model to keep working."
    case .codexAccessProgramUnavailable: "Try again in a little while. You can keep this chat open."
    case .safetyPolicyRefusal:
      "This request didn't pass the model's safety checks. Try rephrasing it or choosing another model."
    case .unsupportedModel: "Choose a different model that works with your provider account."
    case .usageLimit: "You can continue when your usage limit resets, or switch models now."
    case .unknown: "Open the chat on the Okou website for details."
    case .guestMemoryOomKilled, .firewallAuthFailed: "Oops, something went wrong."
    case .insufficientCredits: "Check your workspace's plan or credit balance."
    case .accountVerificationRequired:
      "Your Claude account can't receive replies right now. Check the Anthropic Verification Portal for the next step."
    case .providerBadRequest: "Try again, or switch to another model to continue."
    case .providerModelRestricted: "The current model is unavailable."
    }
  }
}
