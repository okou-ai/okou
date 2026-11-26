import CCState
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
  let includesRemote: Bool
  /// The workspace session's Store in production; every connector read keeps its values here.
  @ObservationIgnored let graph: CCState.Store

  /// What the composer acts on: the last confirmed connector and remote reads, with a new
  /// chat's pending account choices applied. The payloads are not Equatable, so each
  /// publication is a new revision.
  struct Snapshot: Equatable {
    fileprivate(set) var connectors: [ChatComposerConnector] = []
    fileprivate(set) var remotes: ChatRemotesOverview?
    fileprivate(set) var threadAccess: ChatThreadRemoteAccess?
    fileprivate(set) var currentComputerAccess: ChatComputerAccess?
    fileprivate(set) var vncConnections: [ChatVncConnection] = []
    /// Distinguishes composers whose snapshots reach the same revision.
    fileprivate let origin = UUID()
    fileprivate var revision = 0

    static func == (lhs: Self, rhs: Self) -> Bool {
      lhs.origin == rhs.origin && lhs.revision == rhs.revision
    }

    /// A chat's own hosts, or the workspace's before the chat exists.
    func hosts(_ protocol: ChatRemoteProtocol) -> [ChatRemoteHost] {
      if let threadAccess { return `protocol` == .ssh ? threadAccess.ssh : threadAccess.vnc }
      return (`protocol` == .ssh ? remotes?.sshHosts : remotes?.vncHosts) ?? []
    }
  }
  @ObservationIgnored private let snapshotState = CCState.State(Snapshot())
  /// Kept in the composer's Store, where the reads publish it. Views resolve it; `snapshot` and
  /// the accessors below serve actions and tests.
  let snapshotValue: Computed<Snapshot>
  private(set) var error: String?
  private(set) var isSaving = false
  private(set) var uncertain = false
  private(set) var notice: String?
  private let readRetrySleep: @Sendable (Duration) async throws -> Void
  private(set) var pendingOptions = ChatComposerOptions()
  private let authorizationService: ChatConnectorService
  private let memberAccessEnabled: @MainActor () -> Bool
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
  private var permissionWrite: Task<Bool, Never>?
  private var accountPages: [ComposerConnectorAccountResources] = []
  private var accountWrite: Task<Void, Never>?
  @ObservationIgnored lazy var authorization = ConnectorActionStore(
    service: authorizationService, graph: graph,
    didContinue: { [weak self] in await self?.refresh() }, didFail: didFail)

  init(
    service: ChatComposerAccess, authorizationService: ChatConnectorService, webURL: URL,
    graph: CCState.Store, threadID: String? = nil, includesRemote: Bool = true,
    memberAccessEnabled: @escaping @MainActor () -> Bool = { false },
    readRetrySleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.readRetrySleep = readRetrySleep
    self.service = service
    self.authorizationService = authorizationService
    self.webURL = webURL
    self.graph = graph
    self.threadID = threadID
    self.includesRemote = includesRemote
    self.memberAccessEnabled = memberAccessEnabled
    self.didFail = didFail
    let snapshotState = snapshotState
    snapshotValue = Computed { try $0(snapshotState) }
    resources = makeResources()
  }

  /// The current value of `snapshotValue`.
  var snapshot: Snapshot {
    // A synchronous local business value, not a network or persistence boundary.
    do { return try graph.get(snapshotValue) } catch {
      preconditionFailure("Cannot read the connector snapshot: \(error)")
    }
  }
  var connectors: [ChatComposerConnector] { snapshot.connectors }
  var currentComputerAccess: ChatComputerAccess? { snapshot.currentComputerAccess }
  var vncConnections: [ChatVncConnection] { snapshot.vncConnections }

  private func publish(_ change: (inout Snapshot) -> Void) {
    var next = snapshot
    change(&next)
    next.revision += 1
    do { try graph.set(snapshotState, next) } catch {
      preconditionFailure("Cannot publish the connector snapshot: \(error)")
    }
  }

  var canSend: Bool { !isSaving && !uncertain }
  var usesMemberAccess: Bool { memberAccessEnabled() }
  var submissionOptions: ChatComposerOptions {
    guard usesMemberAccess else { return pendingOptions }
    var options = pendingOptions
    // The only client-written selections currently come from legacy draft overrides.
    options.initialConnectorAccessOverrides = []
    options.connectorSelections = []
    return options
  }
  // This Task owns write-confirmation orchestration, not the Views’ resource phase.
  var isRefreshing: Bool { refreshTask != nil }
  var isUpdatingAccounts: Bool { accountWrite != nil }

  func canConfigurePermissions(slug: String?) -> Bool {
    canConfigurePermissions(slug: slug, in: snapshot)
  }

  func canConfigurePermissions(slug: String?, in snapshot: Snapshot) -> Bool {
    guard let slug,
      let connector = snapshot.connectors.first(where: { $0.target == .builtin(slug) }),
      connector.hasPermissions
    else { return false }
    return !connector.access.accounts.isEmpty
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
          let connected: Result<[ChatComposerConnector], Error>
          let remoteConfirmed: Bool
          if includesRemote {
            let pending = try resources.requests()
            let results = await (pending.connected.result, pending.remote.result)
            connected = results.0
            if case .success = results.1 { remoteConfirmed = true } else { remoteConfirmed = false }
          } else {
            connected = await (try resources.store.get(resources.connected)).result
            remoteConfirmed = true
          }
          guard !closed, !Task.isCancelled, request == generation else { return }
          if refreshAgain {
            continue
          }
          // A pre-write read can publish data, but it cannot confirm a newer mutation.
          guard readRevision == confirmationRevision else { return }
          if case .success = connected, remoteConfirmed {
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
    let request = generation
    return ComposerConnectorResources(
      service: service, graph: graph, threadID: threadID, options: pendingOptions,
      includesRemote: includesRemote, memberAccessEnabled: memberAccessEnabled,
      sleep: readRetrySleep,
      didLoadConnected: { [weak self] entries in
        guard let self, !closed, request == generation else { return }
        // Drafts and account actions act on these confirmed values; views resolve the snapshot.
        publish { snapshot in
          snapshot.connectors = entries
          guard threadID == nil && !usesMemberAccess else { return }
          let touched = Set(
            pendingOptions.connectorSelections.map { $0.target.key }
              + pendingOptions.initialConnectorAccessOverrides.map { $0.target.key })
          for connector in entries where touched.contains(connector.target.key) {
            updatePendingAccess(target: connector.target, in: &snapshot)
          }
        }
        for page in accountPages { page.reconcile() }
      },
      didLoadRemote: { [weak self] value in
        guard let self, !closed, request == generation else { return }
        publish { snapshot in
          snapshot.remotes = value.overview
          snapshot.threadAccess = value.access
          snapshot.currentComputerAccess = value.computer
          snapshot.vncConnections = value.connections
        }
      }, didFail: didFail)
  }

  func perform(_ operation: @MainActor () async throws -> Void) async {
    guard !closed, !isSaving, !uncertain else { return }
    let request = generation
    isSaving = true
    notice = nil
    var submitted = false
    defer { if request == generation { isSaving = false } }
    do {
      try await service.validate(threadID: threadID)
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

  func hosts(_ protocol: ChatRemoteProtocol) -> [ChatRemoteHost] { snapshot.hosts(`protocol`) }
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

  var computerAccess: ChatComputerAccess { computerAccess(in: snapshot) }
  func computerAccess(in snapshot: Snapshot) -> ChatComputerAccess {
    snapshot.currentComputerAccess ?? pendingOptions.computerAccess
      ?? ChatComputerAccess(
        cloudBrowserEnabled: snapshot.remotes?.cloudBrowserEnabledByDefault ?? false)
  }
  var visibleComputerUseHosts: [ChatComputerHost] { visibleComputerUseHosts(in: snapshot) }
  func visibleComputerUseHosts(in snapshot: Snapshot) -> [ChatComputerHost] {
    let selectedID = computerAccess(in: snapshot).computerUseHostId
    return (snapshot.remotes?.computerUseHosts ?? []).filter {
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
  func setAccountAccess(
    target: ChatConnectorTarget, connectionID: String, enabled: Bool?
  ) async {
    guard !closed, !isSaving, !usesMemberAccess else { return }
    if let threadID {
      await perform {
        try await service.setConnectorAccess(
          target: target, connectionID: connectionID, threadID: threadID, enabled: enabled)
      }
      return
    }
    if !pendingOptions.connectorSelections.contains(where: { $0.target == target }),
      let current = connectors.first(where: { $0.target == target })?.access.currentConnectionId
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
    if connectors.contains(where: { $0.target == target }) {
      publish { updatePendingAccess(target: target, in: &$0) }
    }
    await refresh()
  }

  private func updatePendingAccess(target: ChatConnectorTarget, in snapshot: inout Snapshot) {
    guard let index = snapshot.connectors.firstIndex(where: { $0.target == target }) else {
      return
    }
    let next = snapshot.connectors[index].access.pending(
      overrides: pendingOptions.initialConnectorAccessOverrides,
      selections: pendingOptions.connectorSelections)
    pendingOptions.connectorSelections.removeAll { $0.target == target }
    if let id = next.currentConnectionId {
      pendingOptions.connectorSelections.append(
        ChatConnectorSelection(target: target, connectionId: id))
    }
    snapshot.connectors[index].access = next
    if snapshot.connectors[index].currentAccount?.id != next.currentConnectionId {
      snapshot.connectors[index].currentAccount = nil
    }
  }
  func connect(_ connector: ChatCatalogConnector) {
    if connector.authMethods.contains(where: { $0.grantKind != "managed" }) {
      connect(target: .builtin(connector.slug))
    } else {
      openWeb(path: "connectors/\(connector.slug)/connect")
    }
  }

  func connect(target: ChatConnectorTarget, accountID: String? = nil) {
    guard !closed else { return }
    authorization.activate(
      .configuration(
        target: target, threadID: threadID, connectionID: accountID))
  }
  func openWeb(path: String, query: [URLQueryItem] = []) {
    guard !closed else { return }
    authorization.cancel()
    webDestination = WebDestination(url: webURL.appending(path: path).appending(queryItems: query))
  }
  func setupRemote(_ protocol: ChatRemoteProtocol) {
    var query = [
      URLQueryItem(name: "scope", value: "remote-control"),
      URLQueryItem(name: "type", value: `protocol`.rawValue)
    ]
    if let threadID { query.append(URLQueryItem(name: "returnThread", value: threadID)) }
    openWeb(path: "connectors", query: query)
  }
  func consumeNewChatOptions() {
    guard threadID == nil else { return }
    pendingOptions = ChatComposerOptions()
  }
  func openDirectory() {
    guard !closed else { return }
    closeDirectory()
    directory = ComposerConnectorDirectoryResources(
      service: service, graph: graph, didFail: didFail)
  }

  func closeDirectory() {
    directory?.close()
    directory = nil
  }

  @discardableResult
  func openPermissions(slug: String, label: String) -> ComposerConnectorPermissionResources? {
    guard !closed else { return nil }
    closePermissions()
    permissions = ComposerConnectorPermissionResources(
      composer: self, slug: slug, label: label, didFail: didFail)
    return permissions
  }

  func closePermissions() {
    permissions?.close()
    permissions = nil
  }

  @discardableResult
  func applyPermissions(
    owner: ComposerConnectorPermissionResources, edits: [ChatPermissionEdit], reset: Bool
  ) async -> Bool {
    guard !closed, permissions === owner,
      permissionWrite == nil, !isSaving, !uncertain
    else { return false }
    let request = generation
    // Dismissing the read surface is not a rollback of a committed permission change.
    let task = Task { @MainActor [self] in
      defer { if request == generation { permissionWrite = nil } }
      await perform {
        try await service.savePermissions(slug: owner.slug, edits: edits, reset: reset)
      }
      guard !closed, !Task.isCancelled, request == generation else { return false }
      if let presented = permissions,
        presented.slug == owner.slug
      {
        await presented.refresh()
      }
      return !uncertain && error == nil && notice == nil
    }
    permissionWrite = task
    return await task.value
  }

  func openAccounts(
    _ connector: ChatComposerConnector, managesDefaults: Bool = false
  ) -> ComposerConnectorAccountResources? {
    guard !closed else { return nil }
    let page = ComposerConnectorAccountResources(
      composer: self, connector: connector,
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
      connectors.contains(where: { $0.target == owner.connector.target }),
      accountWrite == nil, !isSaving, !uncertain
    else { return }
    let request = generation
    let target = owner.connector.target
    let task = Task { @MainActor [self] in
      defer { if request == generation { accountWrite = nil } }
      guard !closed, !Task.isCancelled, request == generation else { return }
      switch action {
      case .access(let id, let enabled):
        await setAccountAccess(target: target, connectionID: id, enabled: enabled)
      case .defaultAccount(let id):
        await perform { try await service.setDefaultAccount(target: target, connectionID: id) }
      case .rename(let id, let name):
        await perform {
          try await service.renameAccount(target: target, connectionID: id, displayName: name)
        }
      case .disconnect(let id):
        await perform { try await service.disconnectAccount(target: target, connectionID: id) }
      case .defaultEnabled(let id, let enabled):
        guard !usesMemberAccess else { return }
        await perform {
          try await service.setDefaultEnabled(target: target, connectionID: id, enabled: enabled)
        }
      case .policy(let id, let policy):
        guard usesMemberAccess else { return }
        await perform {
          try await service.setAccountPolicy(target: target, connectionID: id, policy: policy)
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
