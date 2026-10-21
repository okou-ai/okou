import ChatDomain
import SwiftUI

struct AssistantFailureCard: View {
  let state: AssistantFailureState
  @Bindable var conversation: ConversationStore
  @State private var showsModels = false

  private var copy: (title: String, description: String) { AssistantFailureCopy.content(state) }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(copy.title, systemImage: state.recovery.continues ? "clock" : "exclamationmark.circle")
        .font(.subheadline.weight(.semibold))
      if !copy.description.isEmpty {
        Text(copy.description).font(.subheadline).foregroundStyle(.secondary).textSelection(
          .enabled)
      }
      if let account = state.accountLabel {
        Text("Personal subscription \(account)").font(.caption).textSelection(.enabled)
      }
      if state.disconnected {
        Text("Personal subscription disconnected").font(.caption)
      }
      ForEach(state.resetDetails, id: \.self) { Text($0).font(.caption) }
      if state.isCurrent {
        actions
        if let error = state.accountError ?? state.billingError {
          Text(error).font(.caption).foregroundStyle(.red)
          Button("Refresh recovery options") {
            Task { await conversation.refreshFailureAccounts() }
          }
          .disabled(state.isBusy)
        }
        if let notice = conversation.modelSelection?.models.subscriptions.notice,
          state.recovery.kind == .usage
        {
          Text(notice).font(.caption).foregroundStyle(.secondary)
        }
        if let error = conversation.modelSelection?.models.subscriptions.error,
          state.recovery.kind == .usage, error != state.accountError
        {
          Text(error).font(.caption).foregroundStyle(.red)
        }
      }
      if state.failure.error != copy.description && !state.failure.error.isEmpty {
        DisclosureGroup("Details") {
          Text(state.failure.error).font(.caption).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }.font(.caption)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    .accessibilityIdentifier("assistant-failure-\(state.failure.id)")
    .sheet(isPresented: $showsModels) {
      if let selection = conversation.modelSelection {
        ChatModelPickerView(selection: selection)
          .safeAreaInset(edge: .bottom) {
            Link(
              "Open model settings",
              destination: conversation.webURL.appending(queryItems: [
                URLQueryItem(name: "settings", value: "model")
              ])
            ).padding()
          }
          .presentationDetents([.medium, .large])
          .presentationDragIndicator(.visible)
      }
    }
  }

  @ViewBuilder private var actions: some View {
    if state.recovery.kind == .billing {
      if let billing = state.billing {
        if billing.canManageBilling && !billing.hasCredits {
          Link(
            billing.canBuyCredits ? "Add credits" : "Upgrade to Pro",
            destination: conversation.webURL.appending(queryItems: [
              URLQueryItem(name: "settings", value: "billing"),
              URLQueryItem(name: "billingView", value: billing.canBuyCredits ? "credits" : "plans"),
            ])
          )
          .buttonStyle(.bordered).controlSize(.regular)
          .accessibilityIdentifier("failure-billing")
        }
        Button("Check credits") { Task { await conversation.refreshFailureAccounts() } }
          .disabled(state.isBusy)
      } else if state.billingError == nil {
        ProgressView("Checking billing permissions…").font(.caption)
      }
    } else {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 12) { recoveryButtons }
        VStack(alignment: .leading, spacing: 8) { recoveryButtons }
      }
      .buttonStyle(.bordered)
      .disabled(state.isBusy)
    }
  }

  @ViewBuilder private var recoveryButtons: some View {
    if state.showsModelPicker, conversation.modelSelection != nil {
      Button("Switch model") { showsModels = true }
        .accessibilityIdentifier("failure-switch-model")
    }
    if state.recovery.canRetry {
      Button {
        Task { await conversation.recoverFailure(state.failure.id) }
      } label: {
        HStack {
          if conversation.isRecoveringFailure { ProgressView().controlSize(.mini) }
          Text(state.actionTitle)
        }
      }
      .disabled(!state.canSend)
      .accessibilityIdentifier("failure-continue")
    }
    if state.resetAccountID != nil {
      Button("Reset · \(state.resetsRemaining) left") {
        Task { await conversation.recoverFailure(state.failure.id, resetUsage: true) }
      }
      .disabled(!state.canSend)
      .accessibilityIdentifier("failure-reset-usage")
    }
    if state.recovery.kind == .settings {
      if conversation.modelSelection != nil {
        Button("Open model settings") { showsModels = true }
      } else {
        Link(
          "Open model settings",
          destination: conversation.webURL.appending(queryItems: [
            URLQueryItem(name: "settings", value: "model")
          ]))
      }
    }
    if state.recovery.kind == .newChat {
      Button("New chat") { conversation.newChatAfterFailure(state.failure.id) }
        .accessibilityIdentifier("failure-new-chat")
    }
    if state.recovery.kind == .terms {
      Link("Open Claude", destination: URL(string: "https://claude.ai")!)
    }
  }
}

enum AssistantFailureCopy {
  static func content(_ state: AssistantFailureState) -> (title: String, description: String) {
    let recovery = state.recovery
    if recovery.kind == .billing {
      guard let billing = state.billing else {
        return state.isCurrent
          ? ("Out of credits", "Checking billing permissions…")
          : ("Workspace billing needs attention", "Check your workspace's plan or credit balance.")
      }
      if billing.hasCredits {
        return ("Credits available", "Credits added. You can continue chatting.")
      }
      let title = billing.canBuyCredits ? "Out of credits" : "Upgrade to run"
      let description =
        billing.canManageBilling
        ? (billing.canBuyCredits ? "Add credits to continue." : "Upgrade your plan to continue.")
        : (billing.canBuyCredits
          ? "Ask your workspace admin to add credits."
          : "Ask your workspace admin to upgrade the plan.")
      return (title, description)
    }
    if recovery.kind == .usage {
      let title =
        recovery.framework.map { "\($0 == .codex ? "Codex" : "Claude Code") limit reached" }
        ?? "Model provider limit reached"
      return (
        title,
        state.accountLabel != nil || state.disconnected || !state.resetDetails.isEmpty
          ? "" : "You can continue when your usage limit resets, or switch models now."
      )
    }
    if recovery.kind == .subscription { return ("This run couldn't finish", state.failure.error) }
    if recovery.kind == .unknown,
      state.failure.error.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        == "run cancelled"
    {
      return ("Run paused — resume anytime.", "")
    }
    if let reason = state.failure.reason, state.failure.isRunFailure,
      let copy = structured[reason]
    {
      return copy
    }
    switch recovery.kind {
    case .timeout: return ("Time limit reached", "You can continue from where this run stopped.")
    case .autonomy:
      return (
        "Automatic run limit reached",
        "The limit for consecutive automatic runs has been reached. Confirm to continue."
      )
    case .capacity:
      return (
        "This model is busy right now",
        "Try again in a moment, or choose another model to keep working."
      )
    case .unavailable:
      return (
        "Selected model isn't available",
        "Choose a different model that works with your provider account."
      )
    case .settings:
      return (
        "This run couldn't finish", "Connect or update your model provider in model settings."
      )
    case .newChat:
      return (
        "This run couldn't finish",
        "Start a new chat and include any important details you want to carry over."
      )
    default:
      return (
        "This run couldn't finish",
        state.failure.error.isEmpty
          ? "Open the chat on the Okou website for details."
          : state.failure.error.count <= 240 && !state.failure.error.contains("\n")
            ? state.failure.error : ""
      )
    }
  }

  private static let structured: [String: (title: String, description: String)] = [
    "session_history_limit": (
      "This chat has reached its limit",
      "Start a new chat and include any important details you want to carry over."
    ),
    "guest_root_filesystem_full": (
      "This run ran out of space", "This run couldn't save more files. Try again to continue."
    ),
    "guest_home_filesystem_full": (
      "This run ran out of space", "This run couldn't save more files. Try again to continue."
    ),
    "execution_timeout": ("Time limit reached", "You can continue from where this run stopped."),
    "provider_insufficient_credits": (
      "Your subscription account needs more credit",
      "Check your subscription account's usage or credit balance, then try again."
    ),
    "invalid_api_key": (
      "Your subscription sign-in needs updating",
      "Open Settings > Models to reconnect or update your account, then try again."
    ),
    "invalid_credentials": (
      "Your model connection needs attention",
      "Open Settings > Models to reconnect or update your account, then try again."
    ),
    "terms_acceptance_required": (
      "Claude terms need acceptance", "Accept Claude's latest terms, then come back and try again."
    ),
    "context_window_exceeded": (
      "This chat is too long",
      "Start a new chat and include any important details you want to carry over."
    ),
    "input_too_large": ("Your message is too large", "Shorten your message and send it again."),
    "provider_image_too_large": (
      "Your message is too large", "Shorten your message and send it again."
    ),
    "output_token_limit": (
      "The response reached its length limit",
      "The response stopped before it finished. Continue to pick up from there."
    ),
    "provider_rate_limited": (
      "Too many model requests right now",
      "Try again in a moment, or choose another model to keep working."
    ),
    "provider_overloaded": (
      "This model is busy right now",
      "Try again in a moment, or choose another model to keep working."
    ),
    "provider_stream_timeout": (
      "The model response timed out",
      "Try again in a moment, or choose another model to keep working."
    ),
    "provider_queue_timeout": (
      "The model didn't start in time",
      "Try again in a moment, or choose another model to keep working."
    ),
    "codex_access_program_unavailable": (
      "Codex access is temporarily unavailable",
      "Try again in a little while. You can keep this chat open."
    ),
    "provider_server_error": (
      "The model provider had a temporary error",
      "Try again in a moment, or choose another model to keep working."
    ),
    "response_connection_lost": (
      "The response was interrupted",
      "Try again in a moment, or choose another model to keep working."
    ),
    "safety_policy_refusal": (
      "The model couldn't help with this request",
      "This request didn't pass the model's safety checks. Try rephrasing it or choosing another model."
    ),
    "reconnect_required": (
      "Reconnect your model account",
      "Open Settings > Models to reconnect or update your account, then try again."
    ),
    "unsupported_model": (
      "Selected model isn't available",
      "Choose a different model that works with your provider account."
    ),
    "usage_limit": (
      "Model provider limit reached",
      "You can continue when your usage limit resets, or switch models now."
    ),
  ]
}
