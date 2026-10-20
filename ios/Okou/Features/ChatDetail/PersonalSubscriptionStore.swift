import ChatData
import Foundation
import Observation

@MainActor @Observable
final class PersonalSubscriptionStore {
  enum AuthPhase: Equatable { case idle, starting, pending, completing, complete, expired, failed }
  private let service: PersonalSubscriptionService
  private let didFail: @MainActor (Error) -> Void
  var didMutate: (@MainActor () async -> Void)?
  private(set) var accounts: [PersonalSubscription] = []
  private(set) var accountRevision = 0
  private(set) var isLoading = false
  private(set) var isMutating = false
  private(set) var error: String?
  private(set) var notice: String?
  private(set) var phase = AuthPhase.idle
  private(set) var authType: PersonalSubscriptionType?
  private(set) var browserURL: URL?
  private(set) var verificationCode: String?
  private(set) var expiresAt: Date?
  var authorizationCode = ""
  private(set) var authError: String?
  @ObservationIgnored private var session: SubscriptionAuthSession?
  @ObservationIgnored private var flowTask: Task<Void, Never>?
  @ObservationIgnored private var mutationRefreshTask: Task<Void, Never>?
  private var mutationRevision = UUID()
  private var authAccountID: String?
  private var authRevision = UUID()
  private var readRevision = 0
  private var lastRead: Date?
  private var resetKeys: [String: String] = [:]
  private var closed = false

  init(client: APIClient, didFail: @escaping @MainActor (Error) -> Void) {
    service = PersonalSubscriptionService(client: client)
    self.didFail = didFail
  }
  @discardableResult
  func refresh(force: Bool = false) async -> Bool {
    guard !closed, !Task.isCancelled else { return false }
    guard force || lastRead.map({ Date().timeIntervalSince($0) >= 60 }) != false else {
      return error == nil
    }
    guard !isLoading || force else { return false }
    readRevision += 1
    let request = readRevision
    isLoading = true
    defer { if request == readRevision { isLoading = false } }
    do {
      let result = try await service.list()
      guard !closed, !Task.isCancelled, request == readRevision else { return false }
      accounts = result
      accountRevision += 1
      lastRead = Date()
      error = nil
      return true
    } catch is CancellationError {
    } catch {
      guard !closed, request == readRevision else { return false }
      self.error = error.localizedDescription
      didFail(error)
    }
    return false
  }
  func activate(_ account: PersonalSubscription) async {
    await mutate { try await self.service.activate(id: account.id) }
  }
  func disconnect(_ account: PersonalSubscription) async {
    await mutate { try await self.service.disconnect(id: account.id) }
  }
  @discardableResult
  func reset(_ account: PersonalSubscription) async -> Bool {
    guard !isMutating else { return false }
    let key = resetKeys[account.id] ?? UUID().uuidString
    resetKeys[account.id] = key
    var canContinue = false
    let succeeded = await mutate {
      let outcome = try await self.service.reset(id: account.id, idempotencyKey: key)
      switch outcome {
      case "reset", "alreadyRedeemed": self.notice = String(localized: "Usage reset.")
      case "nothingToReset": self.notice = String(localized: "No usage needs resetting.")
      case "noCredit": self.notice = String(localized: "No reset credits available.")
      default: throw APIClientError.invalidResponse
      }
      canContinue = outcome != "noCredit"
      self.resetKeys[account.id] = nil
    }
    return succeeded && canContinue
  }
  @discardableResult
  private func mutate(_ action: @MainActor () async throws -> Void) async -> Bool {
    guard !closed, !isMutating else { return false }
    isMutating = true
    error = nil
    notice = nil
    defer { isMutating = false }
    do {
      try await action()
      guard !closed, !Task.isCancelled else { return false }
      await refreshAfterMutation()
      return !closed && !Task.isCancelled && error == nil
    } catch is CancellationError {
    } catch {
      guard !closed else { return false }
      self.error = error.localizedDescription
      didFail(error)
    }
    return false
  }
  func reconnect(type: PersonalSubscriptionType) async -> Bool {
    await refresh(force: true)
    guard !closed, !Task.isCancelled, error == nil else { return false }
    guard let account = accounts.first(where: { $0.type == type.rawValue && $0.isActive != false })
    else {
      error = String(localized: "Refresh subscriptions and select an account to reconnect.")
      return false
    }
    start(type: type, accountID: account.id)
    return true
  }
  func start(type: PersonalSubscriptionType, accountID: String? = nil) {
    guard !closed else { return }
    cancelAuth()
    authType = type
    authAccountID = accountID
    phase = .starting
    let request = authRevision
    // Do not cancel a start request: a late successful session still needs server cancellation.
    flowTask = Task { [weak self] in
      guard let self else { return }
      do {
        let result = try await service.start(type: type, accountID: accountID)
        guard !closed, authRevision == request else {
          await cancelRemote(type: type, token: result.sessionToken)
          return
        }
        session = result
        browserURL = result.browserUrl
        verificationCode = result.verificationCode
        expiresAt = Date().addingTimeInterval(TimeInterval(result.expiresIn))
        phase = .pending
        while !closed, authRevision == request {
          let delay = type == .codex ? max(1, result.interval ?? 1) : 1
          try await Task.sleep(for: .seconds(delay))
          guard authRevision == request, !closed else { return }
          if let expiresAt, Date() >= expiresAt {
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
        authError = error.localizedDescription
        phase = .failed
        if let session { await cancelRemote(type: type, token: session.sessionToken) }
        clearSecrets()
        didFail(error)
      }
    }
  }
  func retryAuth() {
    guard let type = authType else { return }
    start(type: type, accountID: authAccountID)
  }
  func submitClaudeCode() async {
    guard !closed, phase == .pending, authType == .claude,
      let session, !authorizationCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return }
    let request = authRevision
    guard expiresAt.map({ Date() < $0 }) == true else {
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
      authError = error.localizedDescription
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
    await refreshAfterMutation()
  }
  /// Successful mutations invalidate model structure before slow upstream quota reads.
  /// This workspace-owned task survives dismissal of the authorization sheet.
  private func refreshAfterMutation() async {
    mutationRefreshTask?.cancel()
    let request = UUID()
    mutationRevision = request
    let task = Task { [weak self] in
      guard let self, !closed else { return }
      defer { if mutationRevision == request { mutationRefreshTask = nil } }
      await didMutate?()
      guard !closed, !Task.isCancelled else { return }
      await refresh(force: true)
    }
    mutationRefreshTask = task
    await task.value
  }
  private func expire(type: PersonalSubscriptionType, token: String, request: UUID) async {
    guard authRevision == request, !closed else { return }
    authRevision = UUID()
    phase = .expired
    clearSecrets()
    await cancelRemote(type: type, token: token)
  }
  func cancelAuth() {
    let oldSession = session
    let oldType = authType
    authRevision = UUID()
    if phase != .starting { flowTask?.cancel() }
    flowTask = nil
    phase = .idle
    authType = nil
    authAccountID = nil
    authError = nil
    clearSecrets()
    if let oldSession, let oldType {
      Task { await cancelRemote(type: oldType, token: oldSession.sessionToken) }
    }
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
    {} catch { if !closed { self.error = error.localizedDescription } }
  }
  func close() {
    closed = true
    mutationRefreshTask?.cancel()
    mutationRefreshTask = nil
    cancelAuth()
    readRevision += 1
    accounts = []
    resetKeys = [:]
    lastRead = nil
  }
}
