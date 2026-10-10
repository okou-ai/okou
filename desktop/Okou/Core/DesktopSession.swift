import Foundation

public struct DesktopSessionIdentity: Sendable, Equatable {
  public let userId: String
  public let sessionId: String
  public let organizationId: String?

  public init(userId: String, sessionId: String, organizationId: String?) {
    self.userId = userId
    self.sessionId = sessionId
    self.organizationId = organizationId
  }
}

public struct DesktopSessionSnapshot: Sendable, Equatable {
  public let loaded: Bool
  public let active: Bool
  public let identity: DesktopSessionIdentity?
  public let email: String?
  public let organizationName: String?

  public init(
    loaded: Bool, active: Bool, identity: DesktopSessionIdentity?,
    email: String? = nil, organizationName: String? = nil
  ) {
    self.loaded = loaded
    self.active = active
    self.identity = identity
    self.email = email
    self.organizationName = organizationName
  }
}

/// Clerk stays in the App target; Core consumes values and the authentication boundary.
@MainActor
public protocol DesktopSessionSource: Sendable {
  var snapshot: DesktopSessionSnapshot { get }
  func updates() -> AsyncStream<DesktopSessionSnapshot>
  func token(forceRefresh: Bool) async throws -> String?
  func refresh() async throws
  func stop()
}

public struct DesktopSessionState: Sendable {
  public var preparing = true
  public var identity: DesktopSessionIdentity?
  public var canAuthenticateHost = false
  public var email = ""
  public var organizationName: String?
  public var developerToolsAvailable = false
  public var error: String?
  public var updateRequired = false
  public var minimumSupportedVersion: String?
  public init() {}
  public var signedIn: Bool { identity != nil }
}

@MainActor
public final class DesktopSessionCoordinator {
  public private(set) var state = DesktopSessionState()
  public private(set) var wantsOnline = true
  private let source: any DesktopSessionSource
  private let api: APIClient
  private let stopHost: @MainActor @Sendable () async -> Void
  private let onChange: @MainActor @Sendable (DesktopSessionState) -> Void
  private var observed: DesktopSessionSnapshot?
  private var verifiedIdentity: DesktopSessionIdentity?
  private var generation = 0
  private var paused = false
  private var stopped = false
  private var updatesTask: Task<Void, Never>?
  private var refreshTask: Task<Void, Never>?
  private var retirementTask: Task<Void, Never>?
  private var retryTask: Task<Void, Never>?
  private var pendingRefresh = false
  private var pendingSourceRefresh = false
  private var recoveryAttempt = 0

  public init(
    source: any DesktopSessionSource, api: APIClient,
    stopHost: @escaping @MainActor @Sendable () async -> Void,
    onChange: @escaping @MainActor @Sendable (DesktopSessionState) -> Void
  ) {
    self.source = source
    self.api = api
    self.stopHost = stopHost
    self.onChange = onChange
  }

  public func start() async {
    guard updatesTask == nil, !stopped else { return }
    // Subscribe before sampling so an activation during startup cannot be lost.
    let updates = source.updates()
    updatesTask = Task { [weak self] in
      for await _ in updates {
        guard let self, !Task.isCancelled else { return }
        self.receiveSnapshot()
      }
    }
    await synchronize(refreshSource: !source.snapshot.loaded)
  }

  public func synchronize(refreshSource: Bool = false) async {
    guard !paused, !stopped else { return }
    receiveSnapshot()
    requestRefresh(refreshSource: refreshSource)
    while let task = refreshTask { await task.value }
  }

  private func receiveSnapshot() {
    guard !paused, !stopped else { return }
    let snapshot = source.snapshot
    let previous = observed
    observed = snapshot
    let changed =
      previous?.identity != snapshot.identity || previous?.active != snapshot.active
    if changed {
      generation += 1
      refreshTask?.cancel()
      retryTask?.cancel()
      retryTask = nil
      recoveryAttempt = 0
      verifiedIdentity = nil
      state = DesktopSessionState()
      state.preparing = !snapshot.loaded
      if previous?.identity != nil, retirementTask == nil {
        retirementTask = Task { await stopHost() }
      }
      publish()
      requestRefresh()
    } else if previous?.loaded != snapshot.loaded {
      requestRefresh()
    } else if verifiedIdentity == snapshot.identity {
      // Profile/token events update presentation without restarting the HTTP pipeline.
      if let email = snapshot.email { state.email = email }
      if let name = snapshot.organizationName { state.organizationName = name }
      publish()
    }
  }

  private func requestRefresh(refreshSource: Bool = false) {
    guard !paused, !stopped else { return }
    // Same-scope activation and SDK events share the request already in flight.
    if let refreshTask, !refreshSource, !refreshTask.isCancelled { return }
    pendingRefresh = true
    pendingSourceRefresh = pendingSourceRefresh || refreshSource
    retryTask?.cancel()
    retryTask = nil
    guard refreshTask == nil else { return }
    refreshTask = Task { await runRefresh() }
  }

  private func runRefresh() async {
    defer {
      refreshTask = nil
      if pendingRefresh, !paused, !stopped { requestRefresh() }
    }
    let current = generation
    let refreshSource = pendingSourceRefresh
    pendingRefresh = false
    pendingSourceRefresh = false
    do {
      if refreshSource {
        try await boundedSourceRefresh()
        try checkLifetime(current)
        receiveSnapshot()
        // SDK refresh may have changed the identity and retired this request.
        try checkLifetime(current)
      }
      if let retirementTask {
        await retirementTask.value
        self.retirementTask = nil
      }
      try checkLifetime(current)
      let snapshot = source.snapshot
      guard snapshot.loaded else { return }
      guard snapshot.active, let identity = snapshot.identity else {
        verifiedIdentity = nil
        state = DesktopSessionState()
        state.preparing = false
        publish()
        return
      }
      let me = try await authenticatedGet("api/auth/me", identity: identity, generation: current)
      if await reject(me, identity: identity, generation: current) { return }
      guard me.status == 200 else {
        throw DesktopFailure("network_error", "Unable to verify Desktop account")
      }
      guard me.body["userId"].string == identity.userId,
        me.body["sessionId"].string == identity.sessionId,
        me.body["orgId"].string == identity.organizationId,
        let email = me.body["email"].string
      else {
        await invalidate(generation: current)
        throw DesktopFailure(
          "invalid_response", "Desktop account response does not match its session")
      }
      var name = source.snapshot.organizationName
      if let orgId = identity.organizationId, name == nil {
        // A restored SDK client may not yet contain its active organization resource.
        let org = try await authenticatedGet("api/org", identity: identity, generation: current)
        if await reject(org, identity: identity, generation: current) { return }
        if org.status == 404 {
          await invalidate(generation: current)
          return
        }
        guard org.status == 200, org.body["id"].string == orgId,
          let loadedName = org.body["name"].string
        else { throw DesktopFailure("invalid_response", "Unable to verify Desktop workspace") }
        name = loadedName
      }
      try checkIdentity(identity, generation: current)
      verifiedIdentity = identity
      state.identity = identity
      state.canAuthenticateHost = identity.organizationId != nil
      state.email = source.snapshot.email ?? email
      state.organizationName = name
      state.preparing = false
      state.developerToolsAvailable = false
      if identity.organizationId != nil {
        let switches = try await authenticatedGet(
          "api/feature-switches", identity: identity, generation: current)
        if switches.status == 403 {
          try checkIdentity(identity, generation: current)
          state.error = "Desktop feature switches are unavailable."
          publish()
          return
        }
        if await reject(switches, identity: identity, generation: current) { return }
        try checkIdentity(identity, generation: current)
        guard switches.status == 200 else {
          throw DesktopFailure("network_error", "Unable to refresh Desktop feature switches")
        }
        state.developerToolsAvailable = switches.body["effectiveSwitches"]["_debug"].bool == true
      }
      try checkIdentity(identity, generation: current)
      state.error = nil
      recoveryAttempt = 0
      publish()
    } catch is CancellationError {
    } catch {
      guard current == generation, !paused, !stopped else { return }
      let authenticationFailed =
        (error as? DesktopFailure)?.code == "unauthenticated"
      if authenticationFailed { await invalidate(generation: current) }
      guard current == generation, !paused, !stopped else { return }
      state.preparing = false
      state.error = error.localizedDescription
      state.developerToolsAvailable = false
      publish()
      scheduleRetry(refreshSource: authenticationFailed)
    }
  }

  private func authenticatedGet(
    _ path: String, identity: DesktopSessionIdentity, generation current: Int
  ) async throws -> APIResponse {
    let response = try await api.authenticatedRequest(
      path, timeout: 10,
      tokenProvider: { forceRefresh in
        try await self.readToken(
          identity: identity, generation: current, forceRefresh: forceRefresh)
      })
    try checkIdentity(identity, generation: current)
    return response
  }

  private func readToken(
    identity: DesktopSessionIdentity, generation current: Int, forceRefresh: Bool
  ) async throws -> String {
    try checkIdentity(identity, generation: current)
    guard let token = try await source.token(forceRefresh: forceRefresh) else {
      throw DesktopFailure("unauthenticated", "Desktop session is no longer signed in")
    }
    try checkIdentity(identity, generation: current)
    return token
  }

  public func token(forceRefresh: Bool) async throws -> String {
    guard !stopped, let identity = verifiedIdentity, identity.organizationId != nil else {
      throw DesktopFailure("unauthenticated", "Sign in and select a workspace before going online")
    }
    let snapshot = source.snapshot
    guard snapshot.active, snapshot.identity == identity else {
      receiveSnapshot()
      throw DesktopFailure("unauthenticated", "Desktop account changed. Go offline and reconnect.")
    }
    return try await readToken(
      identity: identity, generation: generation, forceRefresh: forceRefresh)
  }

  /// Local auth mutations retain the old SDK session until claimed work has drained.
  public func transition(
    _ action: @MainActor @Sendable () async throws -> Void
  ) async throws {
    guard !stopped, !paused else { throw CancellationError() }
    paused = true
    generation += 1
    pendingRefresh = false
    pendingSourceRefresh = false
    refreshTask?.cancel()
    retryTask?.cancel()
    retryTask = nil
    await stopHost()
    if let retirementTask {
      await retirementTask.value
      self.retirementTask = nil
    }
    guard !stopped else { throw CancellationError() }
    do {
      try await action()
    } catch {
      setOnlineIntent(false)
      await resumeAfterTransition()
      throw error
    }
    await resumeAfterTransition()
  }

  private func resumeAfterTransition() async {
    guard !stopped else { return }
    // The old host was already drained before the SDK mutation.
    observed = nil
    verifiedIdentity = nil
    state = DesktopSessionState()
    state.preparing = !source.snapshot.loaded
    paused = false
    publish()
    await synchronize()
  }

  public func authorityRejected(_ failure: HostAuthorityFailure) {
    guard !paused, !stopped else { return }
    setOnlineIntent(false)
    if failure == .permissionDenied {
      state.developerToolsAvailable = false
      publish()
    }
    requestRefresh(refreshSource: failure == .authentication)
  }

  public func setOnlineIntent(_ online: Bool) {
    guard !stopped, wantsOnline != online else { return }
    wantsOnline = online
    publish()
  }

  private func reject(
    _ response: APIResponse, identity: DesktopSessionIdentity, generation current: Int
  ) async -> Bool {
    guard !stopped, current == generation,
      source.snapshot.active, source.snapshot.identity == identity
    else { return true }
    guard [401, 403, 426].contains(response.status) else { return false }
    setOnlineIntent(false)
    if response.status == 403 {
      verifiedIdentity = nil
      state = DesktopSessionState()
      state.preparing = false
      state.identity = identity
      state.email = source.snapshot.email ?? ""
      state.organizationName = source.snapshot.organizationName
      state.error = "Computer Use permissions are unavailable for this workspace."
      publish()
      await stopHost()
      return true
    }
    await invalidate(generation: current)
    guard current == generation else { return true }
    if response.status == 426 {
      state.updateRequired = true
      state.minimumSupportedVersion = response.body["minimumSupportedVersion"].string
    }
    state.error =
      response.status == 426
      ? "This version of Okou must be updated." : "Sign in and select an available workspace."
    publish()
    return true
  }

  private func invalidate(generation current: Int) async {
    guard !stopped, current == generation else { return }
    verifiedIdentity = nil
    state = DesktopSessionState()
    state.preparing = false
    publish()
    await stopHost()
  }

  private func checkLifetime(_ current: Int) throws {
    try Task.checkCancellation()
    guard !stopped, current == generation else { throw CancellationError() }
  }

  private func checkIdentity(_ identity: DesktopSessionIdentity, generation current: Int) throws {
    try checkLifetime(current)
    let snapshot = source.snapshot
    guard snapshot.active, snapshot.identity == identity else { throw CancellationError() }
  }

  private func boundedSourceRefresh() async throws {
    try await withThrowingTaskGroup(of: Void.self) { group in
      group.addTask { try await self.source.refresh() }
      group.addTask {
        try await Task.sleep(for: .seconds(10))
        throw DesktopFailure("network_error", "Desktop account refresh timed out")
      }
      defer { group.cancelAll() }
      try await group.next()
    }
  }

  private func scheduleRetry(refreshSource: Bool) {
    guard retryTask == nil else { return }
    recoveryAttempt += 1
    let delay = min(60, 2 * pow(2, Double(min(recoveryAttempt - 1, 5))))
    retryTask = Task {
      do { try await Task.sleep(for: .seconds(delay)) } catch { return }
      guard !paused, !stopped else { return }
      retryTask = nil
      requestRefresh(refreshSource: refreshSource || !source.snapshot.loaded)
    }
  }

  private func publish() { onChange(state) }

  public func stop() async {
    stopped = true
    wantsOnline = false
    generation += 1
    pendingRefresh = false
    updatesTask?.cancel()
    retryTask?.cancel()
    refreshTask?.cancel()
    source.stop()
    await updatesTask?.value
    await refreshTask?.value
    await retirementTask?.value
    updatesTask = nil
    retryTask = nil
    refreshTask = nil
    retirementTask = nil
  }
}
