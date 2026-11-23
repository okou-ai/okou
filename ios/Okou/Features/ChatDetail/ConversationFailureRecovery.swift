import ChatData
import ChatDomain
import Foundation
import Observation

/// Current-failure reads and explicit recovery retain their own lifetime and command identity.
@MainActor @Observable
final class ConversationFailureRecovery {
  private typealias PendingMessage = ConversationStore.PendingMessage
  private weak var conversation: ConversationStore?
  private let commands: ChatCommands
  private let lifecycleTasks: LifecycleTasks
  private let detailOwner: @MainActor () -> UUID?
  private let refresh: @MainActor () async -> Void
  private let continueMessage: @MainActor (ConversationStore.PendingMessage) async -> Void
  private let didRequestNewChat: @MainActor () -> Void
  private let didSettle: @MainActor () -> Void
  private let report: @MainActor (Error) -> Void
  private(set) var isRecoveringFailure = false
  private(set) var failureContext: FailureRecoveryResources?
  private var failureReadsEnabled = true
  private var failureRecoveryTask: Task<Void, Never>?
  private var closed = false

  init(
    conversation: ConversationStore, commands: ChatCommands, lifecycleTasks: LifecycleTasks,
    detailOwner: @escaping @MainActor () -> UUID?,
    refresh: @escaping @MainActor () async -> Void,
    continueMessage: @escaping @MainActor (ConversationStore.PendingMessage) async -> Void,
    didRequestNewChat: @escaping @MainActor () -> Void,
    didSettle: @escaping @MainActor () -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.conversation = conversation
    self.commands = commands
    self.lifecycleTasks = lifecycleTasks
    self.detailOwner = detailOwner
    self.refresh = refresh
    self.continueMessage = continueMessage
    self.didRequestNewChat = didRequestNewChat
    self.didSettle = didSettle
    report = didFail
  }

  func failureState(
    _ failure: ChatFailure, context: FailureRecoveryResources? = nil,
    accounts: [PersonalSubscription]? = nil,
    accountsError: Error? = nil, billing: ChatBillingRecovery? = nil, billingError: Error? = nil
  ) -> AssistantFailureState {
    guard let conversation = conversation else {
      return AssistantFailureState.make(
        failure: failure, current: false, selection: nil, accounts: accounts, busy: false)
    }
    var state = AssistantFailureState.make(
      failure: failure,
      current: !closed && !conversation.needsUpgrade && failureReadsEnabled
        && conversation.pending.isEmpty
        && conversation.history?.latestFailureID == failure.id
        && (context == nil || failureContext === context),
      selection: conversation.modelSelection, accounts: accounts,
      busy: isRecoveringFailure || conversation.isSending,
      accountsError: accountsError.map(ChatRequestFailure.message(for:)))
    if state.isCurrent {
      state.billing = billing
      state.billingError = billingError.map(ChatRequestFailure.message(for:))
    }
    return state
  }

  /// Commands await the same original reads as the card, then recheck the failure owner.
  func readFailureState(_ failure: ChatFailure) async -> AssistantFailureState {
    guard let context = failureContext, context.failureID == failure.id else {
      return failureState(failure)
    }
    do {
      if context.accounts != nil {
        let accounts = try await context.readAccounts()
        guard !Task.isCancelled, failureContext === context else { return failureState(failure) }
        return failureState(failure, context: context, accounts: accounts)
      }
      if let signal = context.billing {
        let result = await (try context.store.get(signal)).result
        guard !Task.isCancelled, failureContext === context else { return failureState(failure) }
        switch result {
        case .success(let billing): return failureState(failure, context: context, billing: billing)
        case .failure(let error):
          return failureState(failure, context: context, billingError: error)
        }
      }
    } catch {
      guard failureContext === context else { return failureState(failure) }
      if context.accounts != nil {
        return failureState(failure, context: context, accountsError: error)
      }
      return failureState(failure, context: context, billingError: error)
    }
    return failureState(failure)
  }

  func newChatAfterFailure(_ id: String) {
    guard let conversation = conversation else { return }
    guard conversation.history?.latestFailureID == id, conversation.pending.isEmpty, !closed else {
      return
    }
    didRequestNewChat()
  }

  func refreshFailureAccounts() async {
    guard let conversation = conversation else { return }
    guard !closed, !conversation.needsUpgrade, !Task.isCancelled else { return }
    requestFailureAccounts()
    guard let context = failureContext else { return }
    do { try context.retry() } catch is CancellationError {} catch { report(error) }
    guard let failure = conversation.messages.first(where: { $0.id == context.failureID })?.failure
    else {
      return
    }
    _ = await readFailureState(failure)
  }

  /// Execution recovery appends a new input. Uncertain delivery still uses retry(_:).
  func recoverFailure(_ id: String, resetUsage: Bool = false) async {
    guard let conversation = conversation else { return }
    guard !closed, !conversation.needsUpgrade, failureReadsEnabled, !Task.isCancelled,
      failureRecoveryTask == nil, !conversation.isSending, conversation.pending.isEmpty,
      conversation.history?.latestFailureID == id,
      let failure = conversation.messages.first(where: { $0.id == id })?.failure,
      failureState(failure).recovery.canRetry,
      conversation.modelSelection?.canSendConfirmedSelection != false,
      conversation.modelSelection?.isMutating != true
    else { return }
    isRecoveringFailure = true
    conversation.modelSelection?.isSending = true
    let owner = detailOwner()
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        isRecoveringFailure = false
        conversation.modelSelection?.isSending = false
        failureRecoveryTask = nil
        didSettle()
      }
      await refresh()
      guard !closed, !conversation.needsUpgrade, !Task.isCancelled, detailOwner() == owner,
        conversation.history?.latestFailureID == id, conversation.pending.isEmpty,
        conversation.historySyncError == nil, conversation.error == nil,
        failureState(failure).recovery.canRetry,
        conversation.modelSelection?.canSendConfirmedSelection != false
      else { return }
      if resetUsage {
        // Spending a reset credit must resolve the current subscription route first.
        await conversation.modelSelection?.refresh()
        guard conversation.modelSelection?.canSend != false else { return }
        await refreshFailureAccounts()
        let state = await readFailureState(failure)
        guard !closed, !conversation.needsUpgrade, !Task.isCancelled, detailOwner() == owner,
          conversation.history?.latestFailureID == id,
          conversation.modelSelection?.canSendConfirmedSelection != false,
          let accountID = state.resetAccountID,
          let subscriptions = conversation.modelSelection?.models.subscriptions,
          let account = subscriptions.accounts.first(where: { $0.id == accountID }),
          await subscriptions.reset(account)
        else { return }
      }
      guard !closed, !conversation.needsUpgrade, !Task.isCancelled, detailOwner() == owner,
        conversation.history?.latestFailureID == id, conversation.pending.isEmpty,
        conversation.modelSelection?.canSendConfirmedSelection != false
      else { return }
      let message = PendingMessage(
        id: UUID().uuidString.lowercased(), text: "continue", createdAt: Date(), attachments: [],
        modelSelection: conversation.modelSelection?.selection,
        reasoningEffort: conversation.modelSelection?.requestedEffort)
      await continueMessage(message)
    }
    lifecycleTasks.track(task)
    failureRecoveryTask = task
    await task.value
  }

  func requestFailureAccounts() {
    guard let conversation = conversation else { return }
    let id =
      !closed && !conversation.needsUpgrade && failureReadsEnabled && conversation.pending.isEmpty
      ? conversation.history?.latestFailureID : nil
    guard id != failureContext?.failureID else { return }
    failureContext?.close()
    failureContext = nil
    guard let id, let failure = conversation.messages.first(where: { $0.id == id })?.failure else {
      return
    }
    let context = FailureRecoveryResources(
      failure: failure, subscriptions: conversation.modelSelection?.models.subscriptions.resources,
      commands: commands, didFail: { [weak self] in self?.report($0) })
    failureContext = context
    do { try context.start() } catch is CancellationError {} catch { report(error) }
  }

  func enableReads() { failureReadsEnabled = true }

  func retireContext() {
    failureContext?.close()
    failureContext = nil
  }

  func deactivate() {
    failureReadsEnabled = false
    retireContext()
    failureRecoveryTask?.cancel()
  }

  func close() {
    closed = true
    retireContext()
    failureRecoveryTask?.cancel()
  }
}

extension ConversationStore {
  var isRecoveringFailure: Bool { failureRecoveryActions.isRecoveringFailure }
  var failureContext: FailureRecoveryResources? { failureRecoveryActions.failureContext }
  func failureState(
    _ failure: ChatFailure, context: FailureRecoveryResources? = nil,
    accounts: [PersonalSubscription]? = nil,
    accountsError: Error? = nil, billing: ChatBillingRecovery? = nil, billingError: Error? = nil
  ) -> AssistantFailureState {
    failureRecoveryActions.failureState(
      failure, context: context, accounts: accounts, accountsError: accountsError,
      billing: billing, billingError: billingError)
  }
  func readFailureState(_ failure: ChatFailure) async -> AssistantFailureState {
    await failureRecoveryActions.readFailureState(failure)
  }
  func newChatAfterFailure(_ id: String) {
    failureRecoveryActions.newChatAfterFailure(id)
  }
  func refreshFailureAccounts() async {
    await failureRecoveryActions.refreshFailureAccounts()
  }
  func recoverFailure(_ id: String, resetUsage: Bool = false) async {
    await failureRecoveryActions.recoverFailure(id, resetUsage: resetUsage)
  }
}
