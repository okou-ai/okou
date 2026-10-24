import ChatData
import ChatDomain
import Foundation
import Observation

/// Connector choices have the same owner as the composer, never the presented sheet.
@MainActor @Observable
final class ComposerConnectorStore {
  let service: ChatComposerAccess
  let webURL: URL
  let threadID: String?
  private(set) var agentID: String?
  private(set) var connectors: [ChatComposerConnector] = []
  private(set) var remotes: ChatRemotesOverview?
  private(set) var threadAccess: ChatThreadRemoteAccess?
  private(set) var currentComputerAccess: ChatComputerAccess?
  private(set) var vncConnections: [ChatVncConnection] = []
  private(set) var connectorError: String?
  private(set) var remoteError: String?
  private(set) var error: String?
  private(set) var isLoading = false
  private(set) var isSaving = false
  private(set) var uncertain = false
  private(set) var pendingOptions = ChatComposerOptions()
  private var pendingByAgent: [String: ChatComposerOptions] = [:]
  private let authorizationService: ChatConnectorService
  private let didFail: @MainActor (Error) -> Void
  private var generation = UUID()
  private var closed = false

  struct WebDestination: Identifiable { let id = UUID(); let url: URL }
  var webDestination: WebDestination?
  @ObservationIgnored lazy var authorization = ConnectorActionStore(
    service: authorizationService,
    didContinue: { [weak self] in await self?.refresh() }, didFail: didFail)

  init(
    service: ChatComposerAccess, authorizationService: ChatConnectorService, webURL: URL,
    thread: ChatThread? = nil, didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.service = service
    self.authorizationService = authorizationService
    self.webURL = webURL
    threadID = thread?.id
    agentID = thread?.agentID
    self.didFail = didFail
  }

  var canSend: Bool { !isSaving && !uncertain }

  func configure(agentID: String?) {
    guard !closed, self.agentID != agentID else { return }
    if threadID == nil, let previous = self.agentID { pendingByAgent[previous] = pendingOptions }
    generation = UUID()
    authorization.cancel()
    self.agentID = agentID
    pendingOptions = agentID.flatMap { pendingByAgent[$0] } ?? ChatComposerOptions()
    connectors = []
    remotes = nil
    threadAccess = nil
    currentComputerAccess = nil
    vncConnections = []
    connectorError = nil
    remoteError = nil
    error = nil
    uncertain = false
    isSaving = false
    isLoading = false
  }

  func refresh() async {
    guard !closed, !Task.isCancelled, let agentID, !isLoading else { return }
    let request = generation
    isLoading = true
    defer { if request == generation { isLoading = false } }
    async let connected: Void = loadConnectors(agentID: agentID, request: request)
    async let remote: Void = loadRemotes(request: request)
    _ = await (connected, remote)
    guard !closed, request == generation else { return }
    if connectorError == nil, remoteError == nil { uncertain = false; error = nil }
  }

  private func loadConnectors(agentID: String, request: UUID) async {
    do {
      try await service.validate(agentID: agentID, threadID: threadID)
      let values = try await service.connectors(agentID: agentID)
      guard !closed, !Task.isCancelled, request == generation else { return }
      connectors = values
      connectorError = nil
    } catch is CancellationError {
    } catch {
      guard !closed, request == generation else { return }
      connectorError = error.localizedDescription
      didFail(error)
    }
  }

  private func loadRemotes(request: UUID) async {
    do {
      let overview = try await service.remotes()
      var access: ChatThreadRemoteAccess?
      var computer: ChatComputerAccess?
      if let threadID {
        access = try await service.remoteAccess(threadID: threadID)
        computer = try await service.computerAccess(threadID: threadID)
      }
      var connections: [ChatVncConnection] = []
      if !overview.vncHosts.isEmpty { connections = try await service.vncConnections() }
      guard !closed, !Task.isCancelled, request == generation else { return }
      remotes = overview
      threadAccess = access
      currentComputerAccess = computer
      vncConnections = connections
      remoteError = nil
    } catch is CancellationError {
    } catch {
      guard !closed, request == generation else { return }
      remoteError = error.localizedDescription
      didFail(error)
    }
  }

  func perform(_ operation: () async throws -> Void) async {
    guard !closed, !isSaving, let agentID else { return }
    let request = generation
    isSaving = true
    defer { if request == generation { isSaving = false } }
    do {
      try await service.validate(agentID: agentID, threadID: threadID)
      try await operation()
      guard !closed, !Task.isCancelled, request == generation else { return }
      await refresh()
      if connectorError != nil || remoteError != nil { uncertain = true }
    } catch {
      guard !closed, request == generation else { return }
      uncertain = true
      self.error = error.localizedDescription
      didFail(error)
    }
  }

  func setAuthorized(_ connector: ChatComposerConnector, enabled: Bool) async {
    guard let agentID else { return }
    await perform { try await service.setAuthorized(connector, agentID: agentID, enabled: enabled) }
  }

  func hosts(_ protocol: ChatRemoteProtocol) -> [ChatRemoteHost] {
    if let threadAccess { return `protocol` == .ssh ? threadAccess.ssh : threadAccess.vnc }
    return (`protocol` == .ssh ? remotes?.sshHosts : remotes?.vncHosts) ?? []
  }
  func choice(_ host: ChatRemoteHost, protocol: ChatRemoteProtocol) -> Bool? {
    if threadID != nil { return host.overrideEnabled }
    return pendingOptions.initialRemoteAccessOverrides.first {
      $0.protocol == `protocol` && $0.connectionId == host.connectionId
    }?.enabled
  }
  func enabled(_ host: ChatRemoteHost, protocol: ChatRemoteProtocol) -> Bool {
    choice(host, protocol: `protocol`) ?? host.defaultEnabled
  }
  func setRemote(_ host: ChatRemoteHost, protocol: ChatRemoteProtocol, enabled: Bool?) async {
    guard !isSaving, !closed else { return }
    if let threadID {
      await perform {
        try await service.setRemote(
          threadID: threadID, protocol: `protocol`, connectionID: host.connectionId, enabled: enabled)
      }
    } else {
      pendingOptions.initialRemoteAccessOverrides.removeAll {
        $0.protocol == `protocol` && $0.connectionId == host.connectionId
      }
      if let enabled {
        pendingOptions.initialRemoteAccessOverrides.append(
          ChatRemoteOverride(protocol: `protocol`, connectionId: host.connectionId, enabled: enabled))
      }
    }
  }

  var computerAccess: ChatComputerAccess {
    currentComputerAccess ?? pendingOptions.computerAccess
      ?? ChatComputerAccess(cloudBrowserEnabled: remotes?.cloudBrowserEnabledByDefault ?? false)
  }
  func setComputerAccess(_ value: ChatComputerAccess) async {
    guard !isSaving, !closed else { return }
    if let threadID {
      await perform { try await service.setComputerAccess(value, threadID: threadID) }
    } else {
      pendingOptions.computerAccess = value
    }
  }
  func selectAccount(target: ChatConnectorTarget, connectionID: String?) async {
    guard !closed, !isSaving else { return }
    if let threadID {
      await perform {
        try await service.selectAccount(target: target, connectionID: connectionID, threadID: threadID)
      }
    } else {
      pendingOptions.connectorSelections.removeAll { $0.target == target }
      if let connectionID {
        pendingOptions.connectorSelections.append(
          ChatConnectorSelection(target: target, connectionId: connectionID))
      }
    }
  }
  func connect(target: ChatConnectorTarget, accountID: String? = nil) {
    guard let agentID, !closed else { return }
    authorization.activate(.configuration(
      target: target, agentID: agentID, threadID: threadID, connectionID: accountID))
  }
  func openWeb(path: String, query: [URLQueryItem] = []) {
    guard !closed else { return }
    webDestination = WebDestination(url: webURL.appending(path: path).appending(queryItems: query))
  }
  func setupRemote(_ protocol: ChatRemoteProtocol) {
    var query = [URLQueryItem(name: "scope", value: "remote-control"),
      URLQueryItem(name: "type", value: `protocol`.rawValue)]
    if let threadID { query.append(URLQueryItem(name: "returnThread", value: threadID)) }
    openWeb(path: "connectors", query: query)
  }
  func consumeNewChatOptions() {
    guard threadID == nil else { return }
    if let agentID { pendingByAgent[agentID] = nil }
    pendingOptions = ChatComposerOptions()
  }
  func close() {
    closed = true
    generation = UUID()
    authorization.close()
    webDestination = nil
  }
}
