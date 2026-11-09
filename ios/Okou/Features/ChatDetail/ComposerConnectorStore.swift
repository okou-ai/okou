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
  private(set) var error: String?
  private(set) var isSaving = false
  private(set) var uncertain = false
  private(set) var notice: String?
  private let readRetrySleep: @Sendable (Duration) async throws -> Void
  private(set) var pendingOptions = ChatComposerOptions()
  private var pendingByAgent: [String: ChatComposerOptions] = [:]
  private let authorizationService: ChatConnectorService
  private let didFail: @MainActor (Error) -> Void
  private var generation = UUID()
  private(set) var resources: ComposerConnectorResources?
  private var refreshTask: Task<Void, Never>?
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
  private var accountPages: [ComposerConnectorAccountResources] = []
  private var accountWrite: Task<Void, Never>?
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
    resources = makeResources()
  }

  var canSend: Bool { !isSaving && !uncertain }
  // This Task owns write-confirmation orchestration, not the Views’ resource phase.
  var isRefreshing: Bool { refreshTask != nil }
  var isUpdatingAccounts: Bool { accountWrite != nil }

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
    resources?.close()
    refreshTask?.cancel()
    refreshTask = nil
    closeDirectory()
    closeAccounts()
    accountWrite?.cancel()
    accountWrite = nil
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
    error = nil
    notice = nil
    uncertain = false
    isSaving = false
    refreshAgain = false
    resources = makeResources()
  }

  /// One owned confirmation cycle can serve several refresh callers.
  func refresh() async {
    guard !closed, !Task.isCancelled, let resources else { return }
    if refreshTask != nil {
      // A write or foreground refresh needs a read newer than the current snapshot.
      refreshAgain = true
      return
    }
    let request = generation
    let task = Task { @MainActor [weak self, resources] in
      guard let self else { return }
      defer { if request == generation { refreshTask = nil } }
      repeat {
        refreshAgain = false
        let readRevision = confirmationRevision
        do {
          try resources.invalidate(options: pendingOptions)
          let pending = try resources.requests()
          let (connected, remote) = await (pending.connected.result, pending.remote.result)
          guard !closed, !Task.isCancelled, request == generation else { return }
          if refreshAgain {
            continue
          }
          // A pre-write read can publish data, but it cannot confirm a newer mutation.
          guard readRevision == confirmationRevision else { return }
          if case .success = connected, case .success = remote {
            uncertain = false
            error = nil
          }
        } catch {
          guard !closed, !Task.isCancelled, request == generation else { return }
          didFail(error)
        }
      } while refreshAgain
    }
    refreshTask = task
    await task.value
  }

  private func makeResources() -> ComposerConnectorResources? {
    guard let agentID else { return nil }
    let request = generation
    return ComposerConnectorResources(
      service: service, agentID: agentID, threadID: threadID, options: pendingOptions,
      sleep: readRetrySleep,
      didLoadConnected: { [weak self] value in
        guard let self, !closed, request == generation else { return }
        if chatAccountAccess != value.chatAccountAccess { closeAccounts() }
        // Confirmed business values are also consumed by drafts and account actions.
        connectors = value.connectors
        chatAccountAccess = value.chatAccountAccess
        pendingOptions.chatAccountAccess = value.chatAccountAccess
        if chatAccountAccess, threadID == nil {
          let touched = Set(
            pendingOptions.connectorSelections.map { $0.target.key }
              + pendingOptions.initialConnectorAccessOverrides.map { $0.target.key })
          for connector in connectors where touched.contains(connector.target.key) {
            updatePendingAccess(target: connector.target)
          }
        }
        for page in accountPages { page.reconcile() }
      },
      didLoadRemote: { [weak self] value in
        guard let self, !closed, request == generation else { return }
        remotes = value.overview
        threadAccess = value.access
        currentComputerAccess = value.computer
        vncConnections = value.connections
      }, didFail: didFail)
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

  @discardableResult
  func openPermissions(slug: String, label: String) -> ComposerConnectorPermissionResources? {
    guard !closed, let agentID else { return nil }
    closePermissions()
    permissions = ComposerConnectorPermissionResources(
      composer: self, agentID: agentID, slug: slug, label: label, didFail: didFail)
    return permissions
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

  func openAccounts(
    _ connector: ChatComposerConnector, managesDefaults: Bool = false
  ) -> ComposerConnectorAccountResources? {
    guard !closed, let agentID else { return nil }
    let page = ComposerConnectorAccountResources(
      composer: self, connector: connector, agentID: agentID,
      managesDefaults: managesDefaults, didFail: didFail)
    accountPages.append(page)
    return page
  }

  func retireAccounts(_ page: ComposerConnectorAccountResources) {
    accountPages.removeAll { $0 === page }
  }

  func closeAccounts() {
    for page in accountPages { page.close() }
    accountPages = []
  }

  func applyAccountAction(
    owner: ComposerConnectorAccountResources, action: ComposerConnectorAccountResources.Action
  ) async {
    guard !closed, !owner.isClosed, accountPages.contains(where: { $0 === owner }),
      owner.agentID == agentID, owner.chatAccountAccess == chatAccountAccess,
      connectors.contains(where: { $0.target == owner.connector.target }),
      accountWrite == nil, !isSaving, !uncertain
    else { return }
    let request = generation
    let target = owner.connector.target
    let task = Task { @MainActor [self] in
      defer { if request == generation { accountWrite = nil } }
      guard !closed, !Task.isCancelled, request == generation,
        owner.chatAccountAccess == chatAccountAccess
      else { return }
      switch action {
      case .select(let id): await selectAccount(target: target, connectionID: id)
      case .access(let id, let enabled):
        await setAccountAccess(target: target, connectionID: id, enabled: enabled)
      case .defaultAccount(let id):
        await perform { try await service.setDefaultAccount(target: target, connectionID: id) }
      case .defaultEnabled(let id, let enabled):
        await perform {
          try await service.setDefaultEnabled(target: target, connectionID: id, enabled: enabled)
        }
      }
      guard !closed, !Task.isCancelled, request == generation else { return }
      // The current destinations, including one reopened during the write, need readback.
      for page in accountPages where page.connector.target == target {
        await page.refresh()
      }
    }
    accountWrite = task
    await task.value
  }

  func close() {
    resources?.close()
    resources = nil
    refreshTask?.cancel()
    refreshTask = nil
    closeDirectory()
    closeAccounts()
    accountWrite?.cancel()
    accountWrite = nil
    closePermissions()
    permissionWrite?.cancel()
    permissionWrite = nil
    closed = true
    generation = UUID()
    authorization.close()
    webDestination = nil
  }
}
