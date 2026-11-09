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
  private(set) var chatAccountAccess = false
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
  private(set) var notice: String?
  private let readRetrySleep: @Sendable (Duration) async throws -> Void
  private(set) var pendingOptions = ChatComposerOptions()
  private var pendingByAgent: [String: ChatComposerOptions] = [:]
  private let authorizationService: ChatConnectorService
  private let didFail: @MainActor (Error) -> Void
  private var generation = UUID()
  private var refreshAgain = false
  private var confirmationRevision = 0
  private var closed = false

  struct WebDestination: Identifiable {
    let id = UUID()
    let url: URL
  }
  var webDestination: WebDestination?
  private(set) var directory: ComposerConnectorDirectoryResources?
  private(set) var permissions: ComposerConnectorPermissionResources?
  private var permissionWrite: Task<Void, Never>?
  @ObservationIgnored lazy var authorization = ConnectorActionStore(
    service: authorizationService,
    didContinue: { [weak self] in await self?.refresh() }, didFail: didFail)

  init(
    service: ChatComposerAccess, authorizationService: ChatConnectorService, webURL: URL,
    thread: ChatThread? = nil,
    readRetrySleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.readRetrySleep = readRetrySleep
    self.service = service
    self.authorizationService = authorizationService
    self.webURL = webURL
    threadID = thread?.id
    agentID = thread?.agentID
    self.didFail = didFail
  }

  var canSend: Bool { !isSaving && !uncertain }

  func canConfigurePermissions(slug: String?) -> Bool {
    guard let slug, let connector = connectors.first(where: { $0.target == .builtin(slug) }),
      connector.hasPermissions
    else { return false }
    return !chatAccountAccess || connector.access?.accounts.isEmpty == false
  }

  func configure(agentID: String?) {
    guard !closed, self.agentID != agentID else { return }
    if threadID == nil, let previous = self.agentID { pendingByAgent[previous] = pendingOptions }
    generation = UUID()
    closeDirectory()
    closePermissions()
    permissionWrite?.cancel()
    permissionWrite = nil
    authorization.cancel()
    authorization.activationError = nil
    webDestination = nil
    self.agentID = agentID
    pendingOptions = agentID.flatMap { pendingByAgent[$0] } ?? ChatComposerOptions()
    connectors = []
    chatAccountAccess = false
    remotes = nil
    threadAccess = nil
    currentComputerAccess = nil
    vncConnections = []
    connectorError = nil
    remoteError = nil
    error = nil
    notice = nil
    uncertain = false
    isSaving = false
    isLoading = false
    refreshAgain = false
  }

  func refresh() async {
    guard !closed, !Task.isCancelled, let agentID else { return }
    if isLoading {
      refreshAgain = true
      return
    }
    let request = generation
    isLoading = true
    defer { if request == generation { isLoading = false } }
    repeat {
      refreshAgain = false
      let readRevision = confirmationRevision
      async let connected = loadConnectors(agentID: agentID, request: request)
      async let remote = loadRemotes(request: request)
      let (connectorsLoaded, remotesLoaded) = await (connected, remote)
      guard !closed, !Task.isCancelled, request == generation else { return }
      // A write requested another read; this older snapshot cannot confirm it.
      if refreshAgain { continue }
      guard readRevision == confirmationRevision, connectorsLoaded, remotesLoaded else { return }
      uncertain = false
      error = nil
    } while refreshAgain
  }

  private func loadConnectors(agentID: String, request: UUID) async -> Bool {
    do {
      let (enabled, values) = try await read(request: request) {
        try await service.validate(agentID: agentID, threadID: threadID)
        let enabled = try await service.chatAccountAccessEnabled()
        let values = try await service.connectors(
          agentID: agentID, chatAccountAccess: enabled, threadID: threadID, options: pendingOptions)
        return (enabled, values)
      }
      guard !closed, !Task.isCancelled, request == generation else { return false }
      connectors = values
      chatAccountAccess = enabled
      pendingOptions.chatAccountAccess = enabled
      if enabled, threadID == nil {
        let touched = Set(
          pendingOptions.connectorSelections.map { $0.target.key }
            + pendingOptions.initialConnectorAccessOverrides.map { $0.target.key })
        for connector in values where touched.contains(connector.target.key) {
          updatePendingAccess(target: connector.target)
        }
      }
      connectorError = nil
      return true
    } catch {
      guard !closed, !Task.isCancelled, request == generation else { return false }
      connectorError =
        isCancellation(error)
        ? "Could not load connectors. Try again." : ChatRequestFailure.message(for: error)
      didFail(error)
      return false
    }
  }

  private func loadRemotes(request: UUID) async -> Bool {
    do {
      let (overview, access, computer, connections) = try await read(request: request) {
        let overview = try await service.remotes()
        var access: ChatThreadRemoteAccess?
        var computer: ChatComputerAccess?
        if let threadID {
          access = try await service.remoteAccess(threadID: threadID)
          computer = try await service.computerAccess(threadID: threadID)
        }
        var connections: [ChatVncConnection] = []
        if !overview.vncHosts.isEmpty { connections = try await service.vncConnections() }
        return (overview, access, computer, connections)
      }
      guard !closed, !Task.isCancelled, request == generation else { return false }
      remotes = overview
      threadAccess = access
      currentComputerAccess = computer
      vncConnections = connections
      remoteError = nil
      return true
    } catch {
      guard !closed, !Task.isCancelled, request == generation else { return false }
      remoteError =
        isCancellation(error)
        ? "Could not load remote access. Try again." : ChatRequestFailure.message(for: error)
      didFail(error)
      return false
    }
  }

  /// Only repeat reads cancelled by the transport while their owner is still active.
  private func read<Value: Sendable>(
    request: UUID, _ body: @MainActor () async throws -> Value
  ) async throws -> Value {
    return try await ChatReadRecovery.read("connector settings", sleep: readRetrySleep) {
      guard !closed, !Task.isCancelled, request == generation else { throw CancellationError() }
      do {
        return try await body()
      } catch {
        guard !closed, !Task.isCancelled, request == generation, isCancellation(error) else {
          throw error
        }
        return try await body()
      }
    }
  }

  private func isCancellation(_ error: Error) -> Bool {
    error is CancellationError || (error as? URLError)?.code == .cancelled
  }

  func perform(_ operation: @MainActor () async throws -> Void) async {
    guard !closed, !isSaving, !uncertain, let agentID else { return }
    let request = generation
    isSaving = true
    notice = nil
    var submitted = false
    defer { if request == generation { isSaving = false } }
    do {
      try await service.validate(agentID: agentID, threadID: threadID)
      guard !closed, !Task.isCancelled, request == generation else { return }
      submitted = true
      try await operation()
      guard !closed, !Task.isCancelled, request == generation else { return }
      confirmationRevision += 1
      uncertain = true
      await refresh()
      if connectorError != nil || remoteError != nil { uncertain = true }
    } catch {
      guard !closed, request == generation else { return }
      confirmationRevision += 1
      uncertain = true
      self.error = ChatRequestFailure.message(for: error)
      didFail(error)
      if submitted && ChatRequestFailure.isTransient(error) {
        await refresh()
        guard !closed, !Task.isCancelled, request == generation else { return }
        if !uncertain {
          notice = String(
            localized: "Settings checked. Review the current choices before continuing.")
        }
      }
    }
  }

  func setAuthorized(_ connector: ChatComposerConnector, enabled: Bool) async {
    guard !chatAccountAccess, let agentID else { return }
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
          threadID: threadID, protocol: `protocol`, connectionID: host.connectionId,
          enabled: enabled)
      }
    } else {
      pendingOptions.initialRemoteAccessOverrides.removeAll {
        $0.protocol == `protocol` && $0.connectionId == host.connectionId
      }
      if let enabled {
        pendingOptions.initialRemoteAccessOverrides.append(
          ChatRemoteOverride(
            protocol: `protocol`, connectionId: host.connectionId, enabled: enabled))
      }
    }
  }

  var computerAccess: ChatComputerAccess {
    currentComputerAccess ?? pendingOptions.computerAccess
      ?? ChatComputerAccess(cloudBrowserEnabled: remotes?.cloudBrowserEnabledByDefault ?? false)
  }
  var visibleComputerUseHosts: [ChatComputerHost] {
    let selectedID = computerAccess.computerUseHostId
    return (remotes?.computerUseHosts ?? []).filter {
      $0.status == "online" || $0.id == selectedID
    }
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
      if chatAccountAccess {
        guard let connectionID else { return }
        await perform {
          try await service.setCurrentAccount(
            target: target, connectionID: connectionID, threadID: threadID)
        }
      } else {
        await perform {
          try await service.selectAccount(
            target: target, connectionID: connectionID, threadID: threadID)
        }
      }
    } else {
      pendingOptions.connectorSelections.removeAll { $0.target == target }
      if let connectionID {
        pendingOptions.connectorSelections.append(
          ChatConnectorSelection(target: target, connectionId: connectionID))
      }
      if chatAccountAccess {
        updatePendingAccess(target: target)
        await refresh()
      }
    }
  }

  func setAccountAccess(
    target: ChatConnectorTarget, connectionID: String, enabled: Bool?
  ) async {
    guard chatAccountAccess, !closed, !isSaving else { return }
    if let threadID {
      await perform {
        try await service.setConnectorAccess(
          target: target, connectionID: connectionID, threadID: threadID, enabled: enabled)
      }
      return
    }
    if !pendingOptions.connectorSelections.contains(where: { $0.target == target }),
      let current = connectors.first(where: { $0.target == target })?.access?.currentConnectionId
    {
      pendingOptions.connectorSelections.append(
        ChatConnectorSelection(target: target, connectionId: current))
    }
    pendingOptions.initialConnectorAccessOverrides.removeAll {
      $0.target == target && $0.connectionId == connectionID
    }
    if let enabled {
      pendingOptions.initialConnectorAccessOverrides.append(
        ChatConnectorAccessOverride(target: target, connectionId: connectionID, enabled: enabled))
    }
    updatePendingAccess(target: target)
    await refresh()
  }

  private func updatePendingAccess(target: ChatConnectorTarget) {
    guard let index = connectors.firstIndex(where: { $0.target == target }),
      let previous = connectors[index].access
    else { return }
    let next = previous.pending(
      overrides: pendingOptions.initialConnectorAccessOverrides,
      selections: pendingOptions.connectorSelections)
    pendingOptions.connectorSelections.removeAll { $0.target == target }
    if let id = next.currentConnectionId {
      pendingOptions.connectorSelections.append(
        ChatConnectorSelection(target: target, connectionId: id))
    }
    connectors[index].access = next
    if connectors[index].currentAccount?.id != next.currentConnectionId {
      connectors[index].currentAccount = nil
    }
  }
  func connect(target: ChatConnectorTarget, accountID: String? = nil) {
    guard let agentID, !closed else { return }
    authorization.activate(
      .configuration(
        target: target, agentID: agentID, threadID: threadID, connectionID: accountID))
  }
  func openWeb(path: String, query: [URLQueryItem] = []) {
    guard !closed else { return }
    authorization.cancel()
    webDestination = WebDestination(url: webURL.appending(path: path).appending(queryItems: query))
  }
  func setupRemote(_ protocol: ChatRemoteProtocol) {
    var query = [
      URLQueryItem(name: "scope", value: "remote-control"),
      URLQueryItem(name: "type", value: `protocol`.rawValue),
    ]
    if let threadID { query.append(URLQueryItem(name: "returnThread", value: threadID)) }
    openWeb(path: "connectors", query: query)
  }
  func consumeNewChatOptions(agentID: String) {
    guard threadID == nil else { return }
    pendingByAgent[agentID] = nil
    if self.agentID == agentID { pendingOptions = ChatComposerOptions() }
  }
  func openDirectory() {
    guard !closed else { return }
    closeDirectory()
    directory = ComposerConnectorDirectoryResources(service: service, didFail: didFail)
  }

  func closeDirectory() {
    directory?.close()
    directory = nil
  }

  func openPermissions(slug: String, label: String) {
    guard !closed, let agentID else { return }
    closePermissions()
    permissions = ComposerConnectorPermissionResources(
      composer: self, agentID: agentID, slug: slug, label: label, didFail: didFail)
  }

  func closePermissions() {
    permissions?.close()
    permissions = nil
  }

  func applyPermissions(
    owner: ComposerConnectorPermissionResources, edits: [ChatPermissionEdit], reset: Bool
  ) async {
    guard !closed, permissions === owner, agentID == owner.agentID,
      permissionWrite == nil, !isSaving, !uncertain
    else { return }
    let request = generation
    // Dismissing the read surface is not a rollback of a committed permission change.
    let task = Task { @MainActor [self] in
      defer { if request == generation { permissionWrite = nil } }
      await perform {
        try await service.savePermissions(
          slug: owner.slug, agentID: owner.agentID, edits: edits, reset: reset)
      }
      guard !closed, !Task.isCancelled, request == generation else { return }
      if let presented = permissions,
        presented.agentID == owner.agentID, presented.slug == owner.slug
      {
        await presented.refresh()
      }
    }
    permissionWrite = task
    await task.value
  }

  func close() {
    closeDirectory()
    closePermissions()
    permissionWrite?.cancel()
    permissionWrite = nil
    closed = true
    generation = UUID()
    authorization.close()
    webDestination = nil
  }
}
