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
  var session: ChatConnectorReceipt?
  var expiresAt: Date?
  var checking = false
  var browserClosed = false
  var pollInterval: Double = 2
  var operatedID: String?
  init(action: ChatConnectorAction, status: ChatConnectorStatus) {
    self.action = action
    self.status = status
    methodID =
      status.account?.authMethod ?? status.builtin?.authMethods.first { $0.grantKind != "managed" }?
      .id ?? ""
    for option in method?.startOptions ?? [] { options[option.id] = option.defaultValue }
  }
  var method: ChatConnectorMethod? { status.builtin?.authMethods.first { $0.id == methodID } }
  var waiting: Bool { session != nil }
  var isExternalCode: Bool { method?.grantKind == "external-code" && waiting }
  var needsConnection: Bool {
    switch action.kind {
    case .select, .unavailable: false
    case .reconnect: true
    case .connect: !status.connected
    }
  }
  var canSubmit: Bool {
    if operatedID != nil { return !busy }
    guard !busy, !waiting else {
      return isExternalCode && !busy
        && !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    if !needsConnection { return true }
    if let method {
      return method.manualFields.allSatisfy { !$0.required || values[$0.id]?.isEmpty == false }
        && method.startOptions.allSatisfy { !$0.required || options[$0.id]?.isEmpty == false }
    }
    return status.custom?.fields.allSatisfy { !$0.required || values[$0.key]?.isEmpty == false }
      ?? false
  }
}

/// Owns card reads and one cancellable authorization attempt for this conversation's scope.
@MainActor @Observable
final class ConnectorActionStore {
  enum State {
    case loading, unavailable
    case failed(String)
    case ready(ChatConnectorStatus)
  }
  private(set) var states: [String: State] = [:]
  private(set) var active: ConnectorAuthorizationFlow?
  private(set) var notices: [String: String] = [:]
  private let service: ChatConnectorService
  private let commands: ChatCommands
  private let thread: ChatThread
  private let didContinue: @MainActor () async -> Void
  private let didFail: @MainActor (Error) -> Void
  private var known: [String: ChatConnectorAction] = [:]
  private struct Read {
    let id = UUID()
    let task: Task<ChatConnectorStatus?, Error>
  }
  private var reads: [String: Read] = [:]
  private var task: Task<Void, Never>?
  private var callbackIDs: [String: String] = [:]
  private var closed = false

  init(
    service: ChatConnectorService, commands: ChatCommands, thread: ChatThread,
    didContinue: @escaping @MainActor () async -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.service = service
    self.commands = commands
    self.thread = thread
    self.didContinue = didContinue
    self.didFail = didFail
  }
  func refresh(_ action: ChatConnectorAction) async {
    guard !closed, !Task.isCancelled else { return }
    known[action.id] = action
    if action.kind == .unavailable {
      states[action.id] = .unavailable
      return
    }
    let read: Read
    if let pending = reads[action.id] {
      read = pending
    } else {
      read = Read(task: Task { [service] in try await service.status(action) })
      reads[action.id] = read
    }
    defer { if reads[action.id]?.id == read.id { reads[action.id] = nil } }
    do {
      let status = try await read.task.value
      guard !closed, !Task.isCancelled else { return }
      states[action.id] = status.map(State.ready) ?? .unavailable
    } catch is CancellationError {
    } catch {
      guard !closed else { return }
      states[action.id] = .failed(error.localizedDescription)
      didFail(error)
    }
  }
  func refreshKnown() async {
    for action in Array(known.values) { await refresh(action) }
  }
  func activate(_ action: ChatConnectorAction) {
    guard !closed, active == nil else { return }
    task?.cancel()
    task = Task { [weak self] in
      guard let self else { return }
      await refresh(action)
      guard !closed, !Task.isCancelled, case .ready(let status) = states[action.id] else { return }
      notices[action.id] = nil
      active = ConnectorAuthorizationFlow(action: action, status: status)
    }
  }
  func submit() {
    guard !closed, let flow = active, flow.canSubmit else { return }
    flow.busy = true
    flow.error = nil
    task?.cancel()
    task = Task { [weak self, weak flow] in
      guard let self, let flow else { return }
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
        guard current.account?.id == flow.status.account?.id else {
          throw APIClientError.http(
            status: 409, message: "The connector account changed. Close this card and refresh.")
        }
        if case .select = flow.action.kind {
          try await service.select(flow.action, status: current)
          try check(flow)
          guard let verified = try await service.status(flow.action), verified.selected else {
            throw APIClientError.invalidResponse
          }
          try await finish(flow, status: verified)
          return
        }
        let reconnect: Bool
        if case .reconnect = flow.action.kind { reconnect = true } else { reconnect = false }
        if current.connected && !reconnect && flow.session == nil {
          if !current.authorized { try await service.authorize(flow.action, status: current) }
          try await finish(flow, status: current)
          return
        }
        if flow.isExternalCode, let receipt = flow.session, let slug = current.target.connectorSlug
        {
          guard flow.expiresAt.map({ $0 > Date() }) == true else {
            throw APIClientError.http(
              status: 410, message: "Authorization expired. Close this card and try again.")
          }
          let result = try await service.completeSession(
            slug: slug, receipt: receipt,
            code: flow.code.trimmingCharacters(in: .whitespacesAndNewlines))
          flow.code = ""
          try check(flow)
          try await accept(result.operatedID, flow: flow)
          return
        }
        let result = try await service.start(
          flow.action, status: current, method: flow.method, values: flow.values,
          options: flow.options)
        try check(flow)
        if current.custom.map({ !["oauth", "automatic"].contains($0.authMode) }) != false {
          flow.values = [:]
        }
        flow.code = ""
        flow.browserClosed = false
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
          flow.session = result
          flow.expiresAt = Date().addingTimeInterval(600)
          flow.browserURL = try browserURL(result.authorizationUrl)
          startPolling(flow)
          return
        }
        try await accept(result.operatedID, flow: flow)
      } catch is CancellationError {
      } catch {
        guard active === flow, !closed else { return }
        flow.error = error.localizedDescription
        didFail(error)
      }
    }
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
    task = Task { [weak self, weak flow] in
      guard let self, let flow else { return }
      while active === flow, !closed, !Task.isCancelled {
        do {
          try await Task.sleep(for: .seconds(flow.pollInterval))
          if try await checkCompletion(flow) { return }
          if flow.browserClosed, flow.session?.oauthAttemptId != nil {
            flow.session = nil
            flow.notice = String(localized: "Authorization canceled. You can try again.")
            return
          }
        } catch is CancellationError { return } catch {
          guard active === flow, !closed else { return }
          flow.error = error.localizedDescription
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
    if let expected = flow.status.account?.id, id.lowercased() != expected.lowercased() {
      throw APIClientError.invalidResponse
    }
    flow.operatedID = id
    flow.session = nil
    flow.browserURL = nil
    var account = try await service.account(id: id, target: flow.status.target)
    try check(flow)
    if let custom = flow.status.custom, ["oauth", "automatic"].contains(custom.authMode),
      !flow.values.isEmpty
    {
      let receipt = try await service.configureCustom(custom, connectionID: id, values: flow.values)
      try check(flow)
      guard try receipt.operatedID == id else { throw APIClientError.invalidResponse }
      flow.values = [:]
      account = try await service.account(id: id, target: flow.status.target)
      try check(flow)
    }
    guard account.ready else {
      throw APIClientError.http(
        status: 409, message: "Connector setup is incomplete. Refresh and try again.")
    }
    guard let current = try await service.status(flow.action) else {
      throw APIClientError.invalidResponse
    }
    try check(flow)
    if !current.authorized { try await service.authorize(flow.action, status: current) }
    try await finish(flow, status: current)
  }
  private func finish(_ flow: ConnectorAuthorizationFlow, status: ChatConnectorStatus) async throws
  {
    try check(flow)
    guard let verified = try await service.status(flow.action) else {
      throw APIClientError.invalidResponse
    }
    if case .select = flow.action.kind {
      guard verified.selected && verified.authorized else { throw APIClientError.invalidResponse }
    } else {
      guard verified.complete else { throw APIClientError.invalidResponse }
    }
    try check(flow)
    if case .connect = flow.action.kind, let id = flow.operatedID, verified.custom?.managed != true,
      verified.account?.id.lowercased() != id.lowercased()
    {
      throw APIClientError.http(
        status: 409, message: "The default account changed. Refresh the card before continuing.")
    }
    if let id = flow.operatedID {
      let account = try await service.account(id: id, target: status.target)
      guard account.ready else { throw APIClientError.invalidResponse }
    }
    try check(flow)
    if let prompt = flow.action.callbackPrompt {
      let eventID = callbackIDs[flow.action.id] ?? UUID().uuidString
      callbackIDs[flow.action.id] = eventID
      _ = try await commands.send(
        thread: thread, text: prompt, clientEventID: eventID, expectedAgentID: flow.action.agentID)
      try check(flow)
      callbackIDs[flow.action.id] = nil
    }
    states[flow.action.id] = .ready(verified)
    notices[flow.action.id] =
      flow.action.callbackPrompt == nil
      ? String(localized: "Connected and authorized for this Agent.")
      : String(localized: "Connected. Conversation continued.")
    flow.browserURL = nil
    flow.session = nil
    flow.values = [:]
    flow.code = ""
    active = nil
    await didContinue()
  }
  func browserDismissed() {
    guard let flow = active else { return }
    flow.browserURL = nil
    flow.browserClosed = true
  }

  func cancel() {
    task?.cancel()
    task = nil
    if let flow = active {
      notices[flow.action.id] = String(localized: "Authorization canceled.")
      flow.values = [:]
      flow.code = ""
      flow.session = nil
      flow.browserURL = nil
    }
    active = nil
  }
  func close() {
    closed = true
    cancel()
    for read in reads.values { read.task.cancel() }
    reads = [:]
    known = [:]
    states = [:]
    callbackIDs = [:]
  }
}
