import CCState
import ChatData
import Foundation

@MainActor
final class PersonalSubscriptionAuthorization {
  enum Phase: Equatable, Sendable {
    case idle, starting, pending, completing, complete, expired, failed
  }
  struct Presentation: Equatable, Sendable {
    var phase = Phase.idle
    var authType: PersonalSubscriptionType?
    var browserURL: URL?
    var verificationCode: String?
    var expiresAt: Date?
    var authorizationCode = ""
    var authError: String?
  }
  private let store: CCState.Store
  private let presentation = CCState.State(Presentation())
  let value: Computed<Presentation>
  private let change: Command<Void, @MainActor (inout Presentation) -> Void>
  private let service: PersonalSubscriptionService
  private let authNow: @Sendable () -> Date
  private let authSleep: @Sendable (Duration) async throws -> Void
  private let didFail: @MainActor (Error) -> Void
  var didComplete: (@MainActor () async -> Void)?
  private var session: SubscriptionAuthSession?
  private var flowTask: Task<Void, Never>?
  private var finishingFlows: [UUID: Task<Void, Never>] = [:]
  private var authAccountID: String?
  private var authRevision = UUID()
  private var closed = false

  init(
    store: CCState.Store, service: PersonalSubscriptionService,
    now: @escaping @Sendable () -> Date,
    sleep: @escaping @Sendable (Duration) async throws -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.store = store
    self.service = service
    authNow = now
    authSleep = sleep
    self.didFail = didFail
    let presentation = presentation
    value = Computed { get in try get(presentation) }
    change = Command { context, update in
      try context.set(
        presentation,
        update: { current in
          var next = current
          update(&next)
          return next
        })
    }
  }

  var current: Presentation {
    do { return try store.get(value) } catch {
      preconditionFailure("Cannot read subscription authorization state: \(error)")
    }
  }
  private func update(_ body: @escaping @MainActor (inout Presentation) -> Void) {
    do { try store.set(change, body) } catch {
      preconditionFailure("Cannot update subscription authorization state: \(error)")
    }
  }
  var phase: Phase {
    get { current.phase }
    set { update { $0.phase = newValue } }
  }
  var authType: PersonalSubscriptionType? {
    get { current.authType }
    set { update { $0.authType = newValue } }
  }
  var browserURL: URL? {
    get { current.browserURL }
    set { update { $0.browserURL = newValue } }
  }
  var verificationCode: String? {
    get { current.verificationCode }
    set { update { $0.verificationCode = newValue } }
  }
  var expiresAt: Date? {
    get { current.expiresAt }
    set { update { $0.expiresAt = newValue } }
  }
  var authorizationCode: String {
    get { current.authorizationCode }
    set { update { $0.authorizationCode = newValue } }
  }
  var authError: String? {
    get { current.authError }
    set { update { $0.authError = newValue } }
  }
  private struct Target {
    let type: PersonalSubscriptionType
    let accountID: String?
  }
  private lazy var startCommand = Command<Void, Target> { [weak self] _, target in
    self?.begin(type: target.type, accountID: target.accountID)
  }
  private lazy var retryCommand = Command<Void, Void> { [weak self] _ in self?.retryFlow() }
  private lazy var cancelCommand = Command<Void, Void> { [weak self] _ in _ = self?.cancelFlow() }
  private lazy var submitCommand: Command<Task<Void, Error>, Void> = asyncCommand {
    [weak self] _, _ in
    await self?.submitCode()
  }
  func start(type: PersonalSubscriptionType, accountID: String? = nil) {
    do { try store.set(startCommand, Target(type: type, accountID: accountID)) } catch {
      didFail(error)
    }
  }
  func retryAuth() {
    do { try store.set(retryCommand) } catch { didFail(error) }
  }
  func cancelAuth() {
    do { try store.set(cancelCommand) } catch { didFail(error) }
  }
  func submitClaudeCode() async {
    do { try await store.set(submitCommand).value } catch { didFail(error) }
  }
  private func begin(type: PersonalSubscriptionType, accountID: String? = nil) {
    guard !closed else { return }
    cancelFlow()
    authType = type
    authAccountID = accountID
    phase = .starting
    let request = authRevision
    // Do not cancel a start request: a late successful session still needs server cancellation.
    flowTask = Task { [weak self] in
      guard let self else { return }
      defer {
        finishingFlows[request] = nil
        if authRevision == request { flowTask = nil }
      }
      do {
        let result = try await service.start(type: type, accountID: accountID)
        guard !closed, authRevision == request else {
          await cancelRemote(type: type, token: result.sessionToken)
          return
        }
        session = result
        browserURL = result.browserUrl
        verificationCode = result.verificationCode
        expiresAt = authNow().addingTimeInterval(TimeInterval(result.expiresIn))
        phase = .pending
        while !closed, authRevision == request {
          let delay = type == .codex ? max(1, result.interval ?? 1) : 1
          try await authSleep(.seconds(delay))
          guard authRevision == request, !closed else { return }
          if let expiresAt, authNow() >= expiresAt {
            await expire(type: type, token: result.sessionToken, request: request)
            return
          }
          if type == .codex {
            let result = try await service.complete(type: type, token: result.sessionToken)
            guard authRevision == request, !closed else { return }
            if result.status == "complete" {
              await complete(request: request)
              return
            }
            guard result.status == "pending" else { throw APIClientError.invalidResponse }
            authError = result.errorMessage
          }
        }
      } catch is CancellationError {
      } catch {
        guard authRevision == request, !closed else { return }
        authError = ChatRequestFailure.message(for: error)
        phase = .failed
        if let session { await cancelRemote(type: type, token: session.sessionToken) }
        clearSecrets()
        didFail(error)
      }
    }
  }
  private func retryFlow() {
    guard let type = authType else { return }
    start(type: type, accountID: authAccountID)
  }
  private func submitCode() async {
    guard !closed, phase == .pending, authType == .claude,
      let session, !authorizationCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return }
    let request = authRevision
    guard expiresAt.map({ authNow() < $0 }) == true else {
      await expire(type: .claude, token: session.sessionToken, request: request)
      return
    }
    phase = .completing
    do {
      let result = try await service.complete(
        type: .claude, token: session.sessionToken,
        code: authorizationCode.trimmingCharacters(in: .whitespacesAndNewlines))
      guard !closed, authRevision == request else { return }
      guard result.status == "complete" else { throw APIClientError.invalidResponse }
      await complete(request: request)
    } catch {
      guard !closed, authRevision == request else { return }
      authorizationCode = ""
      authError = ChatRequestFailure.message(for: error)
      phase = .pending
      didFail(error)
    }
  }
  private func complete(request: UUID) async {
    guard authRevision == request, !closed else { return }
    if authType == .claude {
      flowTask?.cancel()
      flowTask = nil
    }
    phase = .complete
    clearSecrets()
    await didComplete?()
  }
  private func expire(type: PersonalSubscriptionType, token: String, request: UUID) async {
    guard authRevision == request, !closed else { return }
    authRevision = UUID()
    phase = .expired
    clearSecrets()
    await cancelRemote(type: type, token: token)
  }
  @discardableResult
  private func cancelFlow() -> Task<Void, Never>? {
    let oldSession = session
    let oldType = authType
    let previous = authRevision
    authRevision = UUID()
    // A late start must retain its handle until it can cancel the remote session.
    if let flowTask { finishingFlows[previous] = flowTask }
    if phase != .starting { flowTask?.cancel() }
    flowTask = nil
    phase = .idle
    authType = nil
    authAccountID = nil
    authError = nil
    clearSecrets()
    if let oldSession, let oldType {
      let id = UUID()
      let cleanup = Task {
        defer { finishingFlows[id] = nil }
        await cancelRemote(type: oldType, token: oldSession.sessionToken)
      }
      finishingFlows[id] = cleanup
      return cleanup
    }
    return nil
  }
  private func clearSecrets() {
    session = nil
    authorizationCode = ""
    browserURL = nil
    verificationCode = nil
    expiresAt = nil
  }
  private func cancelRemote(type: PersonalSubscriptionType, token: String) async {
    do { try await service.cancel(type: type, token: token) } catch let error as APIClientError
      where error.statusCode == 404
    {} catch {
      if !closed {
        self.authError = ChatRequestFailure.message(for: error)
        didFail(error)
      }
    }
  }
  @discardableResult
  func close() -> Task<Void, Never> {
    closed = true
    let current = flowTask
    let pending = Array(finishingFlows.values)
    finishingFlows.removeAll()
    let cancellation = cancelFlow()
    return Task {
      for task in pending { await task.value }
      _ = await current?.value
      _ = await cancellation?.value
    }
  }
}
