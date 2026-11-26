import CCState
import CCStateSwiftUI
import ChatData
import ChatDomain
import SwiftUI

/// The transcript keeps its native row owner; read phases come from the original resource Tasks.
struct AssistantFailureRecoveryCard: View {
  let failure: ChatFailure
  let conversation: ConversationStore
  let providerMessage: String?

  var body: some View {
    // Transcript cells host this card outside the workspace root, so it provides the session
    // Store that keeps the recovery state.
    StoreProvider(conversation.graph) {
      FailureRecoveryCardContent(
        failure: failure, conversation: conversation, providerMessage: providerMessage)
    }
  }
}

/// Reads the recovery and model selection state in the session Store. A failure context's own
/// reads may live in another Store, so that state is handed to the cards below as values.
private struct FailureRecoveryCardContent: View {
  let failure: ChatFailure
  let conversation: ConversationStore
  let providerMessage: String?
  @LoadableValue private var recovery: Loadable<ConversationFailureRecovery.Recovery>
  @ResolvedValue private var resolvedModels: ChatModelSelectionStore.Presentation??

  init(failure: ChatFailure, conversation: ConversationStore, providerMessage: String?) {
    self.failure = failure
    self.conversation = conversation
    self.providerMessage = providerMessage
    _recovery = LoadableValue(conversation.failureRecoveryActions.recovery)
    _resolvedModels = ResolvedValue(
      ChatModelSelectionStore.presentation(of: conversation.modelSelection))
  }

  private var current: ConversationFailureRecovery.Recovery {
    recovery.data ?? conversation.failureRecoveryActions.currentRecovery
  }
  private var models: ChatModelSelectionStore.Presentation? {
    resolvedModels ?? conversation.modelSelection?.presentation
  }

  var body: some View {
    if let context = current.context, context.failureID == failure.id {
      StoreProvider(context.store) {
        if let accounts = context.accounts {
          FailureAccountCard(
            failure: failure, conversation: conversation, providerMessage: providerMessage,
            context: context, accounts: accounts, models: models,
            isRecovering: current.isRecovering)
        } else if let billing = context.billing {
          FailureBillingCard(
            failure: failure, conversation: conversation, providerMessage: providerMessage,
            context: context, billing: billing, models: models,
            isRecovering: current.isRecovering)
        } else {
          content
        }
      }.id(ObjectIdentifier(context))
    } else {
      content
    }
  }

  private var content: some View {
    AssistantFailureCard(
      state: conversation.failureState(failure, models: models), conversation: conversation,
      providerMessage: providerMessage, isRecovering: current.isRecovering)
  }
}

private struct FailureAccountCard: View {
  let failure: ChatFailure
  let conversation: ConversationStore
  let providerMessage: String?
  let context: FailureRecoveryResources
  let models: ChatModelSelectionStore.Presentation?
  let isRecovering: Bool
  @LoadableValue private var accounts: Loadable<[PersonalSubscription]>

  init(
    failure: ChatFailure, conversation: ConversationStore, providerMessage: String?,
    context: FailureRecoveryResources, accounts: Signal<Task<[PersonalSubscription], Error>>,
    models: ChatModelSelectionStore.Presentation?, isRecovering: Bool
  ) {
    self.failure = failure
    self.conversation = conversation
    self.providerMessage = providerMessage
    self.context = context
    self.models = models
    self.isRecovering = isRecovering
    _accounts = LoadableValue(task: accounts)
  }

  var body: some View {
    AssistantFailureCard(
      state: conversation.failureState(
        failure, models: models, context: context, accounts: accounts.data,
        accountsError: accounts.error),
      conversation: conversation, providerMessage: providerMessage, isRecovering: isRecovering)
  }
}

private struct FailureBillingCard: View {
  let failure: ChatFailure
  let conversation: ConversationStore
  let providerMessage: String?
  let context: FailureRecoveryResources
  let models: ChatModelSelectionStore.Presentation?
  let isRecovering: Bool
  @LoadableValue private var billing: Loadable<ChatBillingRecovery>

  init(
    failure: ChatFailure, conversation: ConversationStore, providerMessage: String?,
    context: FailureRecoveryResources, billing: Signal<Task<ChatBillingRecovery, Error>>,
    models: ChatModelSelectionStore.Presentation?, isRecovering: Bool
  ) {
    self.failure = failure
    self.conversation = conversation
    self.providerMessage = providerMessage
    self.context = context
    self.models = models
    self.isRecovering = isRecovering
    _billing = LoadableValue(task: billing)
  }

  var body: some View {
    AssistantFailureCard(
      state: conversation.failureState(
        failure, models: models, context: context, billing: billing.data,
        billingError: billing.error),
      conversation: conversation, providerMessage: providerMessage, isRecovering: isRecovering)
  }
}

struct AssistantFailureCard: View {
  let state: AssistantFailureState
  @Bindable var conversation: ConversationStore
  /// The provider's own error line from the same run.
  var providerMessage: String?
  /// Whether an explicit recovery is running, from the session graph.
  var isRecovering = false
  @State private var showsModels = false

  var body: some View {
    let copy = AssistantFailureCopy.content(state, providerMessage: providerMessage)
    VStack(alignment: .leading, spacing: OkouSpace.md) {
      ChatCardHeader(
        title: copy.title,
        icon: state.recovery.continues ? "clock" : "circle-alert"
      ) {
        if !copy.description.isEmpty {
          Text(copy.description).textSelection(.enabled)
        }
        if let account = state.accountLabel {
          Text("Personal subscription \(account)").textSelection(.enabled)
        }
        if state.disconnected {
          Text("Personal subscription disconnected")
        }
        ForEach(state.resetDetails, id: \.self) { Text($0) }
      }
      if state.isCurrent {
        actions
        if let error = state.accountError ?? state.billingError {
          OkouLoadErrorRow(
            message: error, actionTitle: "Refresh recovery options", isRetrying: state.isBusy
          ) { await conversation.refreshFailureAccounts() }
        }
        if let notice = conversation.modelSelection?.models.subscriptions.notice,
          state.recovery.kind == .usage
        {
          Text(notice).font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
        }
        if let error = conversation.modelSelection?.models.subscriptions.error,
          state.recovery.kind == .usage, error != state.accountError
        {
          OkouLoadErrorRow(message: error)
        }
      }
      if state.recovery.kind != .billing, let outputError = state.failure.outputError,
        outputError != copy.description && !outputError.isEmpty
      {
        DisclosureGroup("Details") {
          Text(outputError).font(.okou(.footnote)).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.okou(.footnote))
        .foregroundStyle(OkouColor.mutedForeground)
      }
    }
    .buttonStyle(ChatCardButtonStyle())
    .padding(.horizontal, OkouSpace.lg)
    .padding(.vertical, OkouSpace.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .modifier(ChatCardSurface())
    .accessibilityIdentifier("assistant-failure-\(state.failure.id)")
    .sheet(isPresented: $showsModels) {
      if let selection = conversation.modelSelection {
        ChatModelPickerView(
          selection: selection,
          settingsURL: conversation.webURL.appending(queryItems: [
            URLQueryItem(name: "settings", value: "model")
          ])
        )
      }
    }
  }

  @ViewBuilder private var actions: some View {
    if state.recovery.kind == .billing {
      if state.billing != nil {
        Button("Check credits") { Task { await conversation.refreshFailureAccounts() } }
          .disabled(state.isBusy)
      } else if state.billingError == nil {
        OkouLoadingRow("Checking credits…")
      }
    } else {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: OkouSpace.md) { recoveryButtons }
        VStack(alignment: .leading, spacing: OkouSpace.sm) { recoveryButtons }
      }
      .buttonStyle(ChatCardButtonStyle())
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
          if isRecovering { ProgressView().controlSize(.mini) }
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
  static func billing(_ reason: ChatFailure.BillingReason) -> (title: String, description: String) {
    switch reason {
    case .insufficientCredits:
      structured(.insufficientCredits)
    case .planRestricted:
      (
        String(localized: "Plan restricted"),
        String(localized: "This model is restricted by your plan.")
      )
    }
  }

  static func content(_ state: AssistantFailureState, providerMessage: String? = nil)
    -> (title: String, description: String)
  {
    if let reason = state.failure.billingReason {
      if reason == .insufficientCredits, state.billing?.hasCredits == true {
        return (
          String(localized: "Credits available", table: "RunFailures"),
          String(localized: "You can continue chatting.", table: "RunFailures")
        )
      }
      return billing(reason)
    }
    let copy = recoveryContent(state)
    return (copy.title, providerMessage ?? copy.description)
  }

  private static func recoveryContent(_ state: AssistantFailureState) -> (
    title: String, description: String
  ) {
    let recovery = state.recovery
    let outputError = state.failure.outputError ?? ""
    if recovery.kind == .usage {
      let title: String
      if !state.failure.isRunFailure, let framework = recovery.framework {
        title = "\(framework == .codex ? "Codex" : "Claude Code") limit reached"
      } else {
        title = "Model provider limit reached"
      }
      return (
        title,
        state.accountLabel != nil || state.disconnected || !state.resetDetails.isEmpty
          ? "" : "You can continue when your usage limit resets, or switch models now."
      )
    }
    if recovery.kind == .subscription { return ("This run couldn't finish", outputError) }
    if !state.failure.isRunFailure, recovery.kind == .unknown,
      outputError.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        == "run cancelled"
    {
      return ("Run paused — resume anytime.", "")
    }
    if state.failure.isRunFailure {
      let reason = state.failure.reason.flatMap(KnownRunFailureReason.init(rawValue:)) ?? .unknown
      return structured(reason)
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
        outputError.isEmpty
          ? "Open the chat on the Okou website for details."
          : outputError.count <= 240 && !outputError.contains("\n")
            ? outputError : ""
      )
    }
  }
}
