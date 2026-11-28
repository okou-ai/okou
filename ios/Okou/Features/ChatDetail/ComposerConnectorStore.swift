import CCState
import ChatData
import ChatDomain
import Foundation

/// Connector choices have the same owner as the composer, never the presented sheet.
@MainActor
final class ComposerConnectorStore {
  let service: ChatComposerAccess
  let webURL: URL
  let threadID: String?
  let includesRemote: Bool
  let remoteDevices: RemoteDeviceResources?
  /// The workspace session's Store in production; every connector read keeps its values here.
  let graph: CCState.Store

  /// What the composer acts on: the last confirmed connector and remote reads, with a new
  /// chat's pending account choices applied. The payloads are not Equatable, so each
  /// publication is a new revision.
  struct Snapshot: Equatable {
    fileprivate(set) var connectedServices: [ChatComposerConnector]?
    var connectors: [ChatComposerConnector] { connectedServices ?? [] }
    fileprivate var reconnectIDs: Set<String> = []
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

    /// Only offer reconnect for an inspected account that is still in this overview.
    func reconnectAccountIDs(for connector: ChatComposerConnector) -> [String] {
      connector.access.accounts.compactMap { reconnectIDs.contains($0.id) ? $0.id : nil }
    }

    /// A chat's own hosts, or the workspace's before the chat exists.
    func hosts(_ protocol: ChatRemoteProtocol) -> [ChatRemoteHost] {
      if let threadAccess { return `protocol` == .ssh ? threadAccess.ssh : threadAccess.vnc }
      return (`protocol` == .ssh ? remotes?.sshHosts : remotes?.vncHosts) ?? []
    }
  }
  private let snapshotState = CCState.State(Snapshot())
  /// Kept in the composer's Store, where the reads publish it. Views resolve it; `snapshot` and
  /// the accessors below serve actions and tests.
  let snapshotValue: Computed<Snapshot>
  private let statusState = CCState.State(Status())
  /// The composer's connector writes, a new chat's pending choices and the pages it presents,
  /// kept in the composer's Store. Views resolve it; `status` and its accessors serve actions
  /// and tests.
  let statusValue: Computed<Status>
  /// The status of a composer without connector choices: idle, with nothing presented.
  static let noStatus = Computed { _ in Status() }
  private let readRetrySleep: @Sendable (Duration) async throws -> Void
  let authorizationService: ChatConnectorService
  private let memberAccessEnabled: @MainActor () -> Bool
  private let didFail: @MainActor (Error) -> Void
  private var generation = UUID()
  private(set) var resources: ComposerConnectorResources?
  private var refreshTask: Task<Void, Never>? {
    didSet { updateStatus { $0.isRefreshing = refreshTask != nil } }
  }
  private var refreshAgain = false
  private var confirmationRevision = 0
  private var closed = false

  struct WebDestination: Identifiable {
    let id = UUID()
    let url: URL
  }
  private var permissionWrite: Task<Bool, Never>?
  private var accountPages: [ComposerConnectorAccountResources] = []
  private var accountWrite: Task<Void, Never>? {
    didSet { updateStatus { $0.isUpdatingAccounts = accountWrite != nil } }
  }
  lazy var authorization = ConnectorActionStore(
    service: authorizationService, graph: graph,
    didContinue: { [weak self] in await self?.refresh() }, didFail: didFail)

  init(
    service: ChatComposerAccess, authorizationService: ChatConnectorService, webURL: URL,
    graph: CCState.Store, threadID: String? = nil, includesRemote: Bool = true,
    remoteDevices: RemoteDeviceResources? = nil,
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
    self.remoteDevices = remoteDevices
    self.memberAccessEnabled = memberAccessEnabled
    self.didFail = didFail
    let snapshotState = snapshotState
    snapshotValue = Computed { try $0(snapshotState) }
    let statusState = statusState
    statusValue = Computed { try $0(statusState) }
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

  var canSend: Bool { status.canSend }
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
  var isRefreshing: Bool { status.isRefreshing }
  var isUpdatingAccounts: Bool { status.isUpdatingAccounts }

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
          snapshot.connectedServices = entries
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
      didInspect: { [weak self] ids in
        guard let self, !closed, request == generation, snapshot.reconnectIDs != ids else { return }
        publish { $0.reconnectIDs = ids }
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
  /// A host's explicit choice. A view passes the status it resolved.
  func choice(
    _ host: ChatRemoteHost, protocol: ChatRemoteProtocol, in status: Status? = nil
  ) -> Bool? {
    if threadID != nil { return host.overrideEnabled }
    return (status ?? self.status).pendingOptions.initialRemoteAccessOverrides.first {
      $0.protocol == `protocol` && $0.connectionId == host.connectionId
    }?.enabled
  }
  func enabled(
    _ host: ChatRemoteHost, protocol: ChatRemoteProtocol, in status: Status? = nil
  ) -> Bool {
    choice(host, protocol: `protocol`, in: status) ?? host.defaultEnabled
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
  /// The chat's computer access, or a new chat's pending choice. A view passes the snapshot and
  /// status it resolved.
  func computerAccess(in snapshot: Snapshot, status: Status? = nil) -> ChatComputerAccess {
    snapshot.currentComputerAccess ?? (status ?? self.status).pendingOptions.computerAccess
      ?? ChatComputerAccess(
        cloudBrowserEnabled: snapshot.remotes?.cloudBrowserEnabledByDefault ?? false)
  }
  var visibleComputerUseHosts: [ChatComputerHost] { visibleComputerUseHosts(in: snapshot) }
  func visibleComputerUseHosts(
    in snapshot: Snapshot, status: Status? = nil
  ) -> [ChatComputerHost] {
    let selectedID = computerAccess(in: snapshot, status: status).computerUseHostId
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
    snapshot.connectedServices?[index].access = next
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
    if let remoteDevices, (try? graph.get(remoteDevices.enabled)) == true {
      query.append(URLQueryItem(name: "setup", value: `protocol`.rawValue))
    }
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
    updateStatus {
      $0.webDestination = nil
      $0.isClosed = true
    }
  }
}

extension ComposerConnectorStore {
  /// The composer's connector writes, a new chat's pending choices and the pages it presents.
  /// Page owners compare by identity.
  struct Status: Equatable {
    var error: String?
    var notice: String?
    var isSaving = false
    /// A write may have committed, and no read has confirmed the current choices since.
    var uncertain = false
    var isRefreshing = false
    var isUpdatingAccounts = false
    var pendingOptions = ChatComposerOptions()
    var webDestination: WebDestination?
    var directory: ComposerConnectorDirectoryResources?
    var permissions: ComposerConnectorPermissionResources?
    /// The owner closed: its reads and pages are gone.
    var isClosed = false

    var canSend: Bool { !isSaving && !uncertain }

    static func == (lhs: Self, rhs: Self) -> Bool {
      lhs.error == rhs.error && lhs.notice == rhs.notice && lhs.isSaving == rhs.isSaving
        && lhs.uncertain == rhs.uncertain && lhs.isRefreshing == rhs.isRefreshing
        && lhs.isUpdatingAccounts == rhs.isUpdatingAccounts
        && lhs.pendingOptions == rhs.pendingOptions
        && lhs.webDestination?.id == rhs.webDestination?.id
        && lhs.directory === rhs.directory && lhs.permissions === rhs.permissions
        && lhs.isClosed == rhs.isClosed
    }
  }

  /// The current value of `statusValue`.
  var status: Status {
    // A synchronous local business value, not a network or persistence boundary.
    do { return try graph.get(statusValue) } catch {
      preconditionFailure("Cannot read the connector status: \(error)")
    }
  }
  /// The status of an optional composer's connector choices, for views that may have none.
  static func status(of store: ComposerConnectorStore?) -> Computed<Status> {
    store?.statusValue ?? noStatus
  }
  private(set) var error: String? {
    get { status.error }
    set { updateStatus { $0.error = newValue } }
  }
  private(set) var notice: String? {
    get { status.notice }
    set { updateStatus { $0.notice = newValue } }
  }
  private(set) var isSaving: Bool {
    get { status.isSaving }
    set { updateStatus { $0.isSaving = newValue } }
  }
  private(set) var uncertain: Bool {
    get { status.uncertain }
    set { updateStatus { $0.uncertain = newValue } }
  }
  private(set) var pendingOptions: ChatComposerOptions {
    get { status.pendingOptions }
    set { updateStatus { $0.pendingOptions = newValue } }
  }
  var webDestination: WebDestination? {
    get { status.webDestination }
    set { updateStatus { $0.webDestination = newValue } }
  }
  private(set) var directory: ComposerConnectorDirectoryResources? {
    get { status.directory }
    set { updateStatus { $0.directory = newValue } }
  }
  private(set) var permissions: ComposerConnectorPermissionResources? {
    get { status.permissions }
    set { updateStatus { $0.permissions = newValue } }
  }

  private func updateStatus(_ change: (inout Status) -> Void) {
    var next = status
    change(&next)
    guard next != status else { return }
    do { try graph.set(statusState, next) } catch {
      preconditionFailure("Cannot publish the connector status: \(error)")
    }
  }
}
