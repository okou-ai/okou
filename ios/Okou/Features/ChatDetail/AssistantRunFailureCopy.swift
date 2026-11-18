import ChatDomain
import Foundation

extension AssistantFailureCopy {
  private typealias CopyKeys = (
    title: String.LocalizationValue, description: String.LocalizationValue
  )

  /// The generated initializer requires both copy fields for every known reason.
  static func structured(_ reason: KnownRunFailureReason) -> (title: String, description: String) {
    let keys = runCopy[reason]
    return (
      String(localized: keys.title, table: "RunFailures"),
      String(localized: keys.description, table: "RunFailures")
    )
  }

  private static let runCopy = KnownRunFailureReason.Values<CopyKeys>(
    unknown: (
      "This run couldn't finish",
      "Open the chat on the Okou website for details."
    ),
    sessionHistoryLimit: (
      "This chat has reached its limit",
      "Start a new chat and include any important details you want to carry over."
    ),
    guestRootFilesystemFull: (
      "This run ran out of space",
      "This run couldn't save more files. Try again to continue."
    ),
    guestHomeFilesystemFull: (
      "This run ran out of space",
      "This run couldn't save more files. Try again to continue."
    ),
    guestMemoryOomKilled: (
      "This run couldn't finish",
      "Oops, something went wrong."
    ),
    executionTimeout: (
      "Time limit reached",
      "You can continue from where this run stopped."
    ),
    insufficientCredits: (
      "Out of credits",
      "Check your workspace's plan or credit balance."
    ),
    providerInsufficientCredits: (
      "Your subscription account needs more credit",
      "Check your subscription account's usage or credit balance, then try again."
    ),
    invalidApiKey: (
      "Your subscription sign-in needs updating",
      "Open Settings > Models to reconnect or update your account, then try again."
    ),
    invalidCredentials: (
      "Your model connection needs attention",
      "Open Settings > Models to reconnect or update your account, then try again."
    ),
    termsAcceptanceRequired: (
      "Claude terms need acceptance",
      "Accept Claude's latest terms, then come back and try again."
    ),
    accountVerificationRequired: (
      "Claude account verification required",
      "Your Claude account can't receive replies right now. Check the Anthropic Verification Portal for the next step."
    ),
    contextWindowExceeded: (
      "This chat is too long",
      "Start a new chat and include any important details you want to carry over."
    ),
    inputTooLarge: (
      "Your message is too large",
      "Shorten your message and send it again."
    ),
    providerImageTooLarge: (
      "Your message is too large",
      "Shorten your message and send it again."
    ),
    outputTokenLimit: (
      "The response reached its length limit",
      "The response stopped before it finished. Continue to pick up from there."
    ),
    providerRateLimited: (
      "Too many model requests right now",
      "Try again in a moment, or choose another model to keep working."
    ),
    providerOverloaded: (
      "This model is busy right now",
      "Try again in a moment, or choose another model to keep working."
    ),
    providerStreamTimeout: (
      "The model response timed out",
      "Try again in a moment, or choose another model to keep working."
    ),
    providerRequestTimeout: (
      "The model response timed out",
      "Try again in a moment, or choose another model to keep working."
    ),
    providerQueueTimeout: (
      "The model didn't start in time",
      "Try again in a moment, or choose another model to keep working."
    ),
    providerServerError: (
      "The model provider had a temporary error",
      "Try again in a moment, or choose another model to keep working."
    ),
    firewallAuthFailed: (
      "This run couldn't finish",
      "Oops, something went wrong."
    ),
    providerBadRequest: (
      "The model provider returned an error",
      "Try again, or switch to another model to continue."
    ),
    responseConnectionLost: (
      "The response was interrupted",
      "Try again in a moment, or choose another model to keep working."
    ),
    safetyPolicyRefusal: (
      "The model couldn't help with this request",
      "This request didn't pass the model's safety checks. Try rephrasing it or choosing another model."
    ),
    reconnectRequired: (
      "Reconnect your model account",
      "Open Settings > Models to reconnect or update your account, then try again."
    ),
    codexAccessProgramUnavailable: (
      "Codex access is temporarily unavailable",
      "Try again in a little while. You can keep this chat open."
    ),
    unsupportedModel: (
      "Selected model isn't available",
      "Choose a different model that works with your provider account."
    ),
    providerModelRestricted: (
      "Selected model isn't available",
      "The current model is unavailable."
    ),
    usageLimit: (
      "Model provider limit reached",
      "You can continue when your usage limit resets, or switch models now."
    )
  )
}
