import CCState
import ChatData
import Foundation
import Observation

/// Composes subscription resources, business commands and one authorization lifetime.
@MainActor @Observable
final class PersonalSubscriptionStore {
  typealias AuthPhase = PersonalSubscriptionAuthorization.Phase
  enum Action {
    case activate(String)
    case disconnect(String)
    case reset(String)
    case reconnect(PersonalSubscriptionType)
  }
  private enum Mutation {
    case idle, working
    case confirmed(notice: String?, refreshError: String?)
    case failed(String)
  }
  let resources: PersonalSubscriptionResources
  let authorization: PersonalSubscriptionAuthorization
  var stateStore: CCState.Store { resources.store }
  private let service: PersonalSubscriptionService
  private let didFail: @MainActor (Error) -> Void
  var didMutate: (@MainActor () async -> Void)?
  private var mutation = Mutation.idle
  private var resetKeys: [String: String] = [:]
  // A confirmed reset with failed readback retries only that read, never spends another credit.
  private var resetOutcomes: [String: String] = [:]
  @ObservationIgnored private var mutationTask: Task<Bool, Error>?
  @ObservationIgnored private var mutationRefreshTask: Task<Void, Error>?
  private var mutationRevision = UUID()
  private var closed = false

  init(
    client: APIClient, stateStore: CCState.Store = CCState.Store(),
    authNow: @escaping @Sendable () -> Date = { Date() },
    authSleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    service = PersonalSubscriptionService(client: client)
    resources = PersonalSubscriptionResources(
      store: stateStore, service: service, now: authNow, didFail: didFail)
    authorization = PersonalSubscriptionAuthorization(
      store: stateStore, service: service, now: authNow, sleep: authSleep, didFail: didFail)
    self.didFail = didFail
    authorization.didComplete = { [weak self] in
      guard let self, !closed else { return }
      do { try await refreshAfterMutation() } catch is CancellationError {} catch {
        guard !closed else { return }
        mutation = .confirmed(notice: nil, refreshError: ChatRequestFailure.message(for: error))
      }
    }
  }

  var accounts: [PersonalSubscription] { resources.accounts }
  var accountRevision: Int { resources.accountRevision }
  var isMutating: Bool {
    if case .working = mutation { return true }
    return false
  }
  var error: String? {
    switch mutation {
    case .failed(let message): message
    case .confirmed(_, let error): error
    default: nil
    }
  }
  var notice: String? {
    if case .confirmed(let notice, _) = mutation { return notice }
    return nil
  }
  var phase: AuthPhase { authorization.current.phase }
  var authType: PersonalSubscriptionType? { authorization.current.authType }
  var browserURL: URL? { authorization.current.browserURL }
  var verificationCode: String? { authorization.current.verificationCode }
  var expiresAt: Date? { authorization.current.expiresAt }
  var authError: String? { authorization.current.authError }
  var authorizationCode: String {
    get { authorization.current.authorizationCode }
    set { authorization.authorizationCode = newValue }
  }

  @ObservationIgnored private lazy var action: Command<Task<Bool, Error>, Action> = asyncCommand {
    [weak self] _, action in
    guard let self, !closed else { throw CancellationError() }
    return await perform(action)
  }

  @discardableResult
  func refresh(force: Bool = false) async -> Bool {
    do {
      _ = try await readAccounts(force: force)
      return true
    } catch { return false }
  }
  func readAccounts(force: Bool) async throws -> [PersonalSubscription] {
    let accounts = try await resources.read(force: force)
    if !isMutating {
      // Explicit readback acknowledges the displayed error without confirming or replaying a write.
      if force, case .failed = mutation { mutation = .idle }
      resetOutcomes = [:]
      if case .confirmed(let notice, _) = mutation {
        mutation = .confirmed(notice: notice, refreshError: nil)
      }
    }
    return accounts
  }
  func activate(_ account: PersonalSubscription) async { _ = await run(.activate(account.id)) }
  func disconnect(_ account: PersonalSubscription) async { _ = await run(.disconnect(account.id)) }
  func reset(_ account: PersonalSubscription) async -> Bool { await run(.reset(account.id)) }
  func reconnect(type: PersonalSubscriptionType) async -> Bool { await run(.reconnect(type)) }
  private func run(_ input: Action) async -> Bool {
    guard !closed, !isMutating, !Task.isCancelled else { return false }
    do {
      let task = try stateStore.set(action, input)
      mutationTask = task
      defer { mutationTask = nil }
      return try await task.value
    } catch is CancellationError { return false } catch {
      didFail(error)
      return false
    }
  }

  private func perform(_ input: Action) async -> Bool {
    guard !closed, !isMutating, !Task.isCancelled else { return false }
    mutation = .working
    var confirmed = false
    var message: String?
    do {
      if case .reconnect(let type) = input {
        let accounts = try await resources.read(force: true)
        guard !closed, !Task.isCancelled else { throw CancellationError() }
        guard
          let account = accounts.first(where: { $0.type == type.rawValue && $0.isActive != false })
        else {
          mutation = .failed(
            String(localized: "Refresh subscriptions and select an account to reconnect."))
          return false
        }
        mutation = .idle
        resetOutcomes = [:]
        authorization.start(type: type, accountID: account.id)
        return true
      }
      var canContinue = true
      switch input {
      case .activate(let id): try await service.activate(id: id)
      case .disconnect(let id): try await service.disconnect(id: id)
      case .reset(let id):
        let outcome: String
        if let prior = resetOutcomes[id] {
          outcome = prior
        } else {
          let key = resetKeys[id] ?? UUID().uuidString
          resetKeys[id] = key
          outcome = try await service.reset(id: id, idempotencyKey: key)
          guard ["reset", "alreadyRedeemed", "nothingToReset", "noCredit"].contains(outcome)
          else { throw APIClientError.invalidResponse }
          resetOutcomes[id] = outcome
          resetKeys[id] = nil
        }
        switch outcome {
        case "reset", "alreadyRedeemed": message = String(localized: "Usage reset.")
        case "nothingToReset": message = String(localized: "No usage needs resetting.")
        default: message = String(localized: "No reset credits available.")
        }
        canContinue = outcome != "noCredit"
      case .reconnect: break
      }
      confirmed = true
      guard !closed, !Task.isCancelled else { throw CancellationError() }
      try await refreshAfterMutation()
      guard !closed, !Task.isCancelled else { throw CancellationError() }
      if case .reset(let id) = input { resetOutcomes[id] = nil }
      mutation = .confirmed(notice: message, refreshError: nil)
      return canContinue
    } catch is CancellationError {
      if !closed { mutation = .idle }
    } catch {
      guard !closed else { return false }
      let text = ChatRequestFailure.message(for: error)
      mutation = confirmed ? .confirmed(notice: message, refreshError: text) : .failed(text)
      // Read errors are reported once by their resource owner.
      if !confirmed, case .reconnect = input {} else if !confirmed { didFail(error) }
    }
    return false
  }

  /// Owned by the workspace, so dismissal cannot cancel confirmed-write reconciliation.
  private func refreshAfterMutation() async throws {
    mutationRefreshTask?.cancel()
    let request = UUID()
    mutationRevision = request
    let task = Task { @MainActor [weak self] in
      guard let self, !closed else { throw CancellationError() }
      defer { if mutationRevision == request { mutationRefreshTask = nil } }
      await didMutate?()
      try Task.checkCancellation()
      guard !closed else { throw CancellationError() }
      _ = try await resources.read(force: true)
    }
    mutationRefreshTask = task
    try await task.value
  }

  func start(type: PersonalSubscriptionType, accountID: String? = nil) {
    authorization.start(type: type, accountID: accountID)
  }
  func retryAuth() { authorization.retryAuth() }
  func submitClaudeCode() async { await authorization.submitClaudeCode() }
  func cancelAuth() { authorization.cancelAuth() }
  func close() {
    closed = true
    mutationTask?.cancel()
    mutationTask = nil
    mutationRefreshTask?.cancel()
    mutationRefreshTask = nil
    authorization.close()
    resources.close()
    resetKeys = [:]
    resetOutcomes = [:]
    mutation = .idle
  }
}
