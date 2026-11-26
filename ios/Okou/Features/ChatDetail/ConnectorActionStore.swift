import CCState
import ChatData
import ChatDomain
import Foundation
import Observation

@MainActor @Observable
final class ConnectorAuthorizationFlow: Identifiable {
  let id = UUID()
  let action: ChatConnectorAction
  let status: ChatConnectorStatus
  var methodID: String
  var values: [String: String] = [:]
  var options: [String: String] = [:]
  var code = ""
  var error: String?
  var notice: String?
  var busy = false
  var browserURL: URL?
  var usesProviderApplication = false
  var session: ChatConnectorReceipt?
  var expiresAt: Date?
  var checking = false
  var browserClosed = false
  var browserLeftApp = false
  var pollInterval: Double = 2
  var operatedID: String?
  // Once recovery opens the form, keep it mounted through a retry.
  var presentsForm = true
  init(action: ChatConnectorAction, status: ChatConnectorStatus) {
    self.action = action
    self.status = status
    methodID =
      status.account?.authMethod ?? status.builtin?.authMethods.first { $0.grantKind != "managed" }?
      .id ?? ""
  }
  var method: ChatConnectorMethod? { status.builtin?.authMethods.first { $0.id == methodID } }
  var availableMethods: [ChatConnectorMethod] {
    status.builtin?.authMethods.filter { $0.grantKind != "managed" } ?? []
  }
  var supportsProviderApplication: Bool {
    status.target == .builtin("strava") && method?.id == "oauth"
      && method?.grantKind == "auth-code"
  }
  var startsWithoutForm: Bool {
    needsConnection && availableMethods.count == 1 && method?.grantKind == "auth-code"
      && method?.manualFields.isEmpty == true && method?.startOptions.isEmpty == true
      && status.builtin?.connectNotice == nil && !supportsProviderApplication
  }
  var waiting: Bool { session != nil }
  var isExternalCode: Bool { method?.grantKind == "external-code" && waiting }
  var needsConnection: Bool {
    switch action.kind {
    case .select, .unavailable: false
    case .reconnect, .configuration: true
    case .connect: !status.connected
    }
  }
  var canSubmit: Bool {
    if operatedID != nil { return !busy }
    guard !busy, !waiting else {
      return isExternalCode && !busy
        && !code.trimmingCharacters(in: .ecmaScriptWhitespace).isEmpty
    }
    if !needsConnection { return true }
    if let method {
      return method.hasRequiredInputs(values: values, options: options)
    }
    return status.custom?.canSubmit(values: values, account: status.account) == true
  }
}

/// Owns card reads and one cancellable authorization attempt for this conversation's scope. The
/// attempt, confirmed notices and an activation failure are kept in the workspace session's Store.
@MainActor
final class ConnectorActionStore {
  /// What the cards and sheets render. The attempt compares by identity; its form and phases stay
  /// on the flow.
  struct Presentation: Equatable {
    var active: ConnectorAuthorizationFlow?
    // Confirmed operation notices and continuation identities are not cached read phases.
    var notices: [String: String] = [:]
    var activationError: String?

    @MainActor func isAuthorizing(target: ChatConnectorTarget) -> Bool {
      guard let flow = active, flow.status.target == target else { return false }
      return flow.busy || flow.waiting || flow.checking
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
      lhs.active === rhs.active && lhs.notices == rhs.notices
        && lhs.activationError == rhs.activationError
    }
  }

  let resources: ConnectorActionResources
  /// Views resolve it; the accessors below serve actions and tests.
  let presentationValue: Computed<Presentation>
  private let presentationState = CCState.State(Presentation())
  /// The workspace session's Store, which keeps the attempt and the card reads.
  let graph: CCState.Store
  private let service: ChatConnectorService
  private let providerApplication: any ConnectorProviderApplication
  private let commands: ChatCommands?
  private let thread: ChatThread?
  private let didContinue: @MainActor () async -> Void
  private let didFail: @MainActor (Error) -> Void
  private var activeRead: ConnectorActionRead?
  private var task: Task<Void, Never>?
  private var callbackIDs: [String: String] = [:]
  private var closed = false
  private let pollSleep: @Sendable (Duration) async throws -> Void

  init(
    service: ChatConnectorService, graph: CCState.Store, commands: ChatCommands? = nil,
    thread: ChatThread? = nil,
    didContinue: @escaping @MainActor () async -> Void,
    didFail: @escaping @MainActor (Error) -> Void,
    providerApplication: any ConnectorProviderApplication = SystemConnectorProviderApplication(),
    pollSleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    }
  ) {
    self.service = service
    self.providerApplication = providerApplication
    resources = ConnectorActionResources(service: service, graph: graph, didFail: didFail)
    self.graph = graph
    let presentationState = presentationState
    presentationValue = Computed { try $0(presentationState) }
    self.commands = commands
    self.thread = thread
    self.didContinue = didContinue
    self.didFail = didFail
    self.pollSleep = pollSleep
  }
  func refresh(_ action: ChatConnectorAction) async {
    guard !closed, !Task.isCancelled else { return }
    _ = await resources.read(action).result(refresh: true)
  }
  func refreshKnown() async { await resources.refreshKnown() }
  func activate(_ action: ChatConnectorAction) {
    guard !closed, active == nil else { return }
    update { $0.activationError = nil }
    task?.cancel()
    let read = resources.read(action)
    task = Task { [weak self, read] in
      guard let self else { return }
      do {
        let status = try await read.load(refresh: true)
        guard !closed, !Task.isCancelled else { return }
        guard let status else {
          update {
            $0.activationError = "This connector is no longer available. Refresh and try again."
          }
          return
        }
        // The attempt pins its shared read across cache eviction and native row recycling.
        activeRead = read
        let flow = ConnectorAuthorizationFlow(action: action, status: status)
        update {
          $0.notices[action.id] = nil
          $0.active = flow
        }
        if flow.startsWithoutForm, flow.canSubmit {
          flow.presentsForm = false
          flow.busy = true
          await performSubmission(flow)
        }
      } catch {
        guard !closed, !Task.isCancelled else { return }
        update { $0.activationError = ChatRequestFailure.message(for: error) }
      }
    }
  }
  func submit() {
    guard !closed, let flow = active, flow.canSubmit else { return }
    flow.busy = true
    flow.error = nil
    task?.cancel()
    task = Task { [weak self, weak flow] in
      guard let self, let flow else { return }
      await performSubmission(flow)
    }
  }
  private func performSubmission(_ flow: ConnectorAuthorizationFlow) async {
    defer { flow.busy = false }
    do {
      guard let current = try await service.status(flow.action) else {
        throw APIClientError.http(status: 404, message: "This action is no longer available.")
      }
      try check(flow)
      guard current.target == flow.status.target else { throw APIClientError.invalidResponse }
      if let id = flow.operatedID {
        try await accept(id, flow: flow)
        return
      }
      guard
        current.mutationConnectionID?.lowercased()
          == flow.status.mutationConnectionID?.lowercased()
      else {
        throw APIClientError.http(
          status: 409, message: "The connector account changed. Close this card and refresh.")
      }
      if case .select = flow.action.kind {
        try await service.select(flow.action, status: current)
        try await finish(flow)
        return
      }
      let reconnect: Bool
      switch flow.action.kind {
      case .reconnect, .configuration: reconnect = true
      default: reconnect = false
      }
      if current.connected && !reconnect && flow.session == nil {
        try await finish(flow)
        return
      }
      if flow.isExternalCode,
        let receipt = flow.session, let slug = current.target.connectorSlug
      {
        guard flow.expiresAt.map({ $0 > Date() }) == true else {
          throw APIClientError.http(
            status: 410, message: "Authorization expired. Close this card and try again.")
        }
        let result = try await service.completeSession(
          slug: slug, receipt: receipt,
          code: flow.code.trimmingCharacters(in: .ecmaScriptWhitespace))
        flow.code = ""
        try check(flow)
        try await accept(result.operatedID, flow: flow)
        return
      }
      try await startAuthorization(flow, status: current)
    } catch is CancellationError {
    } catch {
      guard active === flow, !closed else { return }
      flow.error = ChatRequestFailure.message(for: error)
      flow.presentsForm = true
      didFail(error)
    }
  }
  private func startAuthorization(
    _ flow: ConnectorAuthorizationFlow, status current: ChatConnectorStatus
  ) async throws {
    flow.usesProviderApplication = false
    let nativeAppAuthorization = flow.supportsProviderApplication
    let result = try await service.start(
      status: current, method: flow.method, values: flow.values, options: flow.options,
      nativeAppAuthorization: nativeAppAuthorization)
    try check(flow)
    flow.values = [:]
    flow.code = ""
    flow.browserClosed = false
    flow.browserLeftApp = false
    if let sessionID = result.sessionId {
      guard UUID(uuidString: sessionID) != nil, result.sessionToken != nil,
        let expires = result.expiresIn, expires > 0
      else { throw APIClientError.invalidResponse }
      flow.session = result
      flow.expiresAt = Date().addingTimeInterval(expires)
      flow.pollInterval = max(1, result.interval ?? 2)
      flow.browserURL = try browserURL(
        result.authorizationUrl ?? result.verificationUriComplete ?? result.verificationUri)
      if flow.method?.grantKind == "device-auth" { startPolling(flow) }
      return
    }
    if let attemptID = result.oauthAttemptId {
      guard UUID(uuidString: attemptID) != nil else { throw APIClientError.invalidResponse }
      let webURL = try browserURL(result.authorizationUrl)
      try ConnectorProviderAuthorization.validateCallback(result)
      let appURL = try ConnectorProviderAuthorization.appURL(
        receipt: result, target: current.target, methodID: flow.methodID, webURL: webURL)
      flow.session = result
      flow.expiresAt = Date().addingTimeInterval(600)
      if let appURL {
        // A refused/canceled authorization is not a failed launch. Only a
        // definitive OS launch failure permits the same attempt's web fallback.
        let opened = await providerApplication.open(appURL)
        try check(flow)
        flow.usesProviderApplication = opened
        flow.browserURL = opened ? nil : webURL
      } else {
        flow.browserURL = webURL
      }
      startPolling(flow)
      return
    }
    try await accept(result.operatedID, flow: flow)
  }

  private func browserURL(_ url: URL?) throws -> URL {
    guard let url, url.scheme?.lowercased() == "https", url.user == nil, url.password == nil else {
      throw APIClientError.invalidResponse
    }
    return url
  }
  private func check(_ flow: ConnectorAuthorizationFlow) throws {
    try Task.checkCancellation()
    guard !closed, active === flow else { throw CancellationError() }
  }
  private func startPolling(_ flow: ConnectorAuthorizationFlow) {
    // The attempt owns polling. Dismissal and workspace replacement revoke continuation.
    task?.cancel()
    task = Task { [weak self, weak flow] in
      guard let self, let flow else { return }
      while active === flow, !closed, !Task.isCancelled {
        do {
          try await pollSleep(.seconds(flow.pollInterval))
          if try await checkCompletion(flow) { return }
          if flow.browserClosed, !flow.checking, flow.session?.oauthAttemptId != nil {
            if !flow.presentsForm {
              cancel()
              return
            }
            flow.session = nil
            flow.notice = String(localized: "Authorization canceled. You can try again.")
            return
          }
        } catch is CancellationError { return } catch {
          guard active === flow, !closed else { return }
          flow.error = ChatRequestFailure.message(for: error)
          flow.presentsForm = true
          flow.session = nil
          flow.browserURL = nil
          didFail(error)
          return
        }
      }
    }
  }
  private func checkCompletion(_ flow: ConnectorAuthorizationFlow) async throws -> Bool {
    try check(flow)
    guard !flow.checking, let receipt = flow.session, !flow.isExternalCode else { return false }
    flow.checking = true
    defer { flow.checking = false }
    guard flow.expiresAt.map({ $0 > Date() }) == true else {
      throw APIClientError.http(status: 410, message: "Authorization expired. Try again.")
    }
    let id: String?
    if let attemptID = receipt.oauthAttemptId {
      id = try await service.oauthCompletion(attemptID: attemptID, target: flow.status.target)
    } else if let slug = flow.status.target.connectorSlug {
      let result = try await service.completeSession(slug: slug, receipt: receipt, code: nil)
      if result.status == "pending" {
        guard let interval = result.interval, interval > 0 else {
          throw APIClientError.invalidResponse
        }
        flow.pollInterval = interval
        return false
      }
      guard result.status == "complete" else {
        throw APIClientError.http(
          status: 400,
          message: result.errorMessage ?? "Authorization was canceled or expired. Try again.")
      }
      id = try result.operatedID
    } else {
      throw APIClientError.invalidResponse
    }
    guard let id else { return false }
    try check(flow)
    try await accept(id, flow: flow)
    return true
  }
  private func accept(_ id: String?, flow: ConnectorAuthorizationFlow) async throws {
    guard let id else { throw APIClientError.incompatibleData }
    if let expected = flow.status.mutationConnectionID, id.lowercased() != expected.lowercased() {
      throw APIClientError.invalidResponse
    }
    flow.operatedID = id
    flow.session = nil
    flow.browserURL = nil
    if flow.status.custom?.managed != true {
      let account = try await service.account(id: id, target: flow.status.target)
      try check(flow)
      guard account.ready else {
        throw APIClientError.http(
          status: 409, message: "Connector setup is incomplete. Refresh and try again.")
      }
    }
    try await finish(flow)
  }
  private func finish(_ flow: ConnectorAuthorizationFlow) async throws {
    try check(flow)
    guard
      let verified = try await service.status(flow.action.confirming(accountID: flow.operatedID))
    else {
      throw APIClientError.invalidResponse
    }
    if case .select = flow.action.kind {
      guard verified.selected else { throw APIClientError.invalidResponse }
    } else {
      guard verified.connected else { throw APIClientError.invalidResponse }
    }
    try check(flow)
    if case .connect = flow.action.kind, let id = flow.operatedID,
      verified.mutationConnectionID?.lowercased() != id.lowercased()
    {
      throw APIClientError.http(
        status: 409, message: "The default account changed. Refresh the card before continuing.")
    }
    if let id = flow.operatedID, verified.custom?.managed != true {
      let account = try await service.account(id: id, target: verified.target)
      guard account.ready else { throw APIClientError.invalidResponse }
    }
    try check(flow)
    if let prompt = flow.action.callbackPrompt, let thread, let commands {
      let eventID = callbackIDs[flow.action.id] ?? UUID().uuidString
      callbackIDs[flow.action.id] = eventID
      _ = try await commands.send(
        thread: thread, text: prompt, clientEventID: eventID)
      try check(flow)
      callbackIDs[flow.action.id] = nil
    }
    activeRead?.invalidate()
    let notice =
      flow.action.callbackPrompt == nil
      ? String(localized: "Account connected.")
      : String(localized: "Connected. Chat continued.")
    flow.browserURL = nil
    flow.session = nil
    flow.values = [:]
    flow.code = ""
    update {
      $0.notices[flow.action.id] = notice
      $0.active = nil
    }
    activeRead = nil
    await didContinue()
  }
  func browserDismissed() {
    guard let flow = active else { return }
    flow.browserURL = nil
    flow.browserClosed = true
  }

  func receiveProviderReturn(_ url: URL) {
    guard !closed, let flow = active,
      flow.session?.nativeAppAuthorization?.provider == "strava"
        || flow.session?.nativeCallbackUrl != nil,
      let attemptID = ConnectorProviderAuthorization.returnAttemptID(url),
      flow.session?.oauthAttemptId?.lowercased() == attemptID
    else { return }
    // Both success and denial wake the attempt. Only its authenticated backend
    // receipt can establish success or identify the exact connection.
    flow.browserURL = nil
    flow.browserClosed = true
    if task == nil { startPolling(flow) }
  }

  func authorizationSceneChanged(isActive: Bool, isBackground: Bool) {
    guard !closed, let flow = active, flow.session != nil else { return }
    if flow.usesProviderApplication {
      if isActive {
        if task == nil { startPolling(flow) }
      } else {
        task?.cancel()
        task = nil
      }
    } else if flow.browserURL != nil {
      if isBackground {
        flow.browserLeftApp = true
      } else if isActive, flow.browserLeftApp {
        flow.browserLeftApp = false
        // Returning without a callback may mean cancellation. Check the backend
        // receipt before clearing this attempt or allowing another authorization.
        browserDismissed()
      }
    }
  }

  func browserOpenFailed(flow: ConnectorAuthorizationFlow, url: URL) {
    guard !closed, active === flow, flow.browserURL == url else { return }
    task?.cancel()
    task = nil
    flow.session = nil
    flow.browserURL = nil
    flow.error = String(localized: "Could not open connector")
    flow.presentsForm = true
  }

  func cancel() {
    task?.cancel()
    task = nil
    let flow = active
    if let flow {
      flow.values = [:]
      flow.code = ""
      flow.session = nil
      flow.browserURL = nil
    }
    update {
      if let flow { $0.notices[flow.action.id] = String(localized: "Authorization canceled.") }
      $0.active = nil
    }
    activeRead = nil
  }
  func close() {
    closed = true
    cancel()
    resources.close()
    callbackIDs = [:]
  }
}

extension ConnectorActionStore {
  /// The current value of `presentationValue`.
  var presentation: Presentation {
    // A synchronous local business value, not a network or persistence boundary.
    do { return try graph.get(presentationValue) } catch {
      preconditionFailure("Cannot read the connector authorization: \(error)")
    }
  }
  var active: ConnectorAuthorizationFlow? { presentation.active }
  var notices: [String: String] { presentation.notices }
  var activationError: String? { presentation.activationError }

  func dismissActivationError() { update { $0.activationError = nil } }

  fileprivate func update(_ change: (inout Presentation) -> Void) {
    var next = presentation
    change(&next)
    guard next != presentation else { return }
    do { try graph.set(presentationState, next) } catch {
      preconditionFailure("Cannot publish the connector authorization: \(error)")
    }
  }
}
