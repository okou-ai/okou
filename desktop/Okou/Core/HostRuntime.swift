import Foundation

public struct CommandLog: Identifiable, Sendable {
  public let id: String
  public let kind: String
  public let payload: JSONValue
  public let startedAt: Date
  public var completedAt: Date?
  public var response: JSONValue?
  public var status: String { response?["status"].string ?? "running" }
}

public struct RuntimeState: Sendable {
  public var status = "offline"
  public var hostId: String?
  public var lastHeartbeat: Date?
  public var lastCommand: Date?
  public var lastError: String?
  public var updateRequired = false
  public var minimumSupportedVersion: String?
  public var recoveryAttempt = 0
  public var retryAt: Date?
  public var commands: [CommandLog] = []
  public var errors: [String] = []
  public init() {}
  public var busy: Bool { commands.contains { $0.response == nil } }
  public var shouldDeferUpdate: Bool {
    busy || lastCommand.map { Date().timeIntervalSince($0) < 1800 } == true
  }
}

public actor HostRuntime {
  private let api: APIClient
  private let executor: CommandExecutor
  private let notifications: any CommandNotifications
  private let installationId: String
  private let hostName: String
  private let version: String
  private let tokenProvider: @Sendable (Bool) async throws -> String
  private let onChange: @MainActor @Sendable (RuntimeState) -> Void
  private var generation = 0
  private var running = false
  private var acceptingCommands = false
  private struct Connection: Sendable {
    let hostId: String
    let generation: Int
    init?(registration: ComputerUseHostRegistration) {
      guard UUID(uuidString: registration.hostId) != nil, registration.connectionGeneration > 0
      else { return nil }
      hostId = registration.hostId
      generation = registration.connectionGeneration
    }
    func body(_ value: JSONValue) -> JSONValue {
      guard case .object(var fields) = value else { return value }
      fields["connectionGeneration"] = .number(Double(generation))
      return .object(fields)
    }
    var heartbeat: ApiRoute { ApiRoutes.computerUseHostHeartbeat(hostId: hostId) }
    var stop: ApiRoute { ApiRoutes.computerUseHostStop(hostId: hostId) }
    var nextCommand: ApiRoute { ApiRoutes.computerUseHostCommandNext(hostId: hostId) }
    func complete(commandId: String) -> ApiRoute {
      ApiRoutes.computerUseHostCommandComplete(hostId: hostId, commandId: commandId)
    }
  }
  private var connection: Connection?
  private var heartbeatTask: Task<Void, Never>?
  private var notificationTask: Task<Void, Never>?
  private var notificationStops = 0
  private var drainTask: Task<Void, Never>?
  private var commandRetryTask: Task<Void, Never>?
  private var pendingRefresh = false
  private var commandRecoveryAttempt = 0
  private var stopTask: Task<Void, Never>?
  private var registrationTask: (generation: Int, task: Task<Void, Error>)?
  private var state = RuntimeState()
  private var permissions: JSONValue = .object([
    "accessibility": .bool(false), "screenRecording": .bool(false),
  ])

  public init(
    api: APIClient, executor: CommandExecutor, installationId: String, hostName: String,
    version: String,
    notifications: any CommandNotifications,
    tokenProvider: @escaping @Sendable (Bool) async throws -> String,
    onChange: @escaping @MainActor @Sendable (RuntimeState) -> Void
  ) {
    self.api = api
    self.executor = executor
    self.notifications = notifications
    self.installationId = installationId
    self.hostName = hostName
    self.version = version
    self.tokenProvider = tokenProvider
    self.onChange = onChange
  }
  public func updatePermissions(_ value: JSONValue) { permissions = value }
  private func body() -> JSONValue {
    .object([
      "installationId": .string(installationId), "hostName": .string(hostName),
      "appVersion": .string(version),
      "osVersion": .string(ProcessInfo.processInfo.operatingSystemVersionString),
      "supportedCapabilities": .strings(CommandExecutor.capabilities), "permissions": permissions,
    ])
  }
  private func parsedConnection(_ response: APIResponse) -> Connection? {
    (try? response.decode(ComputerUseHostRegistration.self)).flatMap(Connection.init(registration:))
  }
  private func request(
    _ route: ApiRoute, connection: Connection, body: JSONValue, timeout: TimeInterval,
    generation current: Int
  ) async throws -> APIResponse {
    let provider = tokenProvider
    return try await api.authenticatedRequest(
      route, body: connection.body(body), timeout: timeout,
      tokenProvider: { forceRefresh in
        let token = try await provider(forceRefresh)
        try await self.checkGeneration(current)
        return token
      })
  }
  private func checkGeneration(_ current: Int) throws {
    guard running, generation == current else { throw CancellationError() }
  }
  private func publish() async { await onChange(state) }
  public func start() async {
    guard !running, stopTask == nil, notificationStops == 0, drainTask == nil else { return }
    generation += 1
    let current = generation
    running = true
    acceptingCommands = true
    state.status = "connecting"
    state.lastError = nil
    state.updateRequired = false
    state.minimumSupportedVersion = nil
    await publish()
    var attempt = 0
    while running && current == generation {
      do {
        let registering = Task { try await self.register(generation: current) }
        registrationTask = (current, registering)
        do { try await registering.value } catch {
          if registrationTask?.generation == current { registrationTask = nil }
          throw error
        }
        if registrationTask?.generation == current { registrationTask = nil }
        return
      } catch is CancellationError { return } catch {
        guard running, current == generation else { return }
        if await rejectAuthentication(error) { return }
        attempt += 1
        await recover(error, attempt: attempt)
        try? await Task.sleep(for: .seconds(delay(attempt)))
      }
    }
  }
  private func register(generation current: Int) async throws {
    let response = try await api.authenticatedRequest(
      ApiRoutes.computerUseHostRegister, body: body(), timeout: 10, tokenProvider: tokenProvider)
    guard running, current == generation else {
      if let lateConnection = parsedConnection(response) {
        _ = try? await api.authenticatedRequest(
          lateConnection.stop, body: lateConnection.body(.object([:])),
          timeout: 5, tokenProvider: tokenProvider)
      }
      return
    }
    guard (200..<300).contains(response.status) else {
      if response.status == 426 { recordUpgradeRequirement(response) }
      if [401, 403, 404, 409, 426].contains(response.status) {
        running = false
        state.status = response.status == 403 ? "disabled" : "error"
        state.lastError =
          response.status == 409
          ? "Computer Use is already active in another Desktop session."
          : response.status == 404
            ? "Computer Use is temporarily unavailable until the service is updated."
            : response.status == 426
              ? "This version of Okou must be updated."
              : response.status == 401
                ? "Sign in and select a workspace before going online."
                : "Computer Use is disabled for this account."
        await publish()
        return
      }
      throw DesktopFailure(
        "network_error", "Unable to register Computer Use host (HTTP \(response.status))")
    }
    let registration = try response.decode(ComputerUseHostRegistration.self)
    guard let connection = Connection(registration: registration) else {
      throw DesktopFailure("invalid_response", "Host registration response is missing its identity")
    }
    self.connection = connection
    guard let notifications = registration.commandNotifications,
      !notifications.channelName.isEmpty, !notifications.eventName.isEmpty
    else {
      // A new Desktop cannot operate against a pre-notification API. Retire
      // the registered connection instead of leaving an online, inactive host.
      _ = try? await api.authenticatedRequest(
        connection.stop, body: connection.body(.object([:])), timeout: 5,
        tokenProvider: tokenProvider)
      self.connection = nil
      running = false
      acceptingCommands = false
      state.status = "error"
      state.lastError = "Computer Use notifications are unavailable until the service is updated."
      await publish()
      return
    }
    state.hostId = connection.hostId
    state.status = "online"
    state.lastHeartbeat = Date()
    state.lastError = nil
    state.recoveryAttempt = 0
    state.retryAt = nil
    await publish()
    guard running, acceptingCommands, generation == current else { return }
    heartbeatTask = Task { await self.heartbeatLoop(generation: current, connection: connection) }
    let subscription = CommandNotificationSubscription(
      channelName: notifications.channelName, eventName: notifications.eventName)
    notificationTask = Task {
      await self.notificationLoop(
        subscription: subscription, generation: current, connection: connection)
    }
  }
  public func stop() async {
    if let stopTask {
      await stopTask.value
      return
    }
    let draining = Task { await self.stopRuntime() }
    stopTask = draining
    await draining.value
    stopTask = nil
  }
  private func stopRuntime() async {
    acceptingCommands = false
    state.status = "stopping"
    await publish()
    await stopNotifications()
    // Keep heartbeats alive while an existing command drains; its Clerk
    // session must remain available until the completion report has been sent.
    if connection == nil {
      running = false
      generation += 1
    }
    // A delayed registration owns its late-connection cleanup. Wait for that
    // request before allowing application termination to discard its result.
    _ = try? await registrationTask?.task.value
    // Let an already claimed command finish and report before stopping its
    // host. A stopped generation cannot claim or dispatch another action.
    let draining = drainTask
    await draining?.value
    drainTask = nil
    pendingRefresh = false
    commandRecoveryAttempt = 0
    running = false
    generation += 1
    heartbeatTask?.cancel()
    heartbeatTask = nil
    if let connection {
      do {
        let response = try await api.authenticatedRequest(
          connection.stop, body: connection.body(.object([:])), timeout: 5,
          tokenProvider: tokenProvider)
        if response.status != 401 && !(200..<300).contains(response.status) {
          throw DesktopFailure("network_error", "Unable to stop host (HTTP \(response.status))")
        }
      } catch { state.errors.append(error.localizedDescription) }
    }
    connection = nil
    state.status = "offline"
    state.hostId = nil
    state.retryAt = nil
    await executor.stop()
    await publish()
  }
  private func delay(_ attempt: Int) -> Double { min(60, 2 * pow(2, Double(min(attempt - 1, 5)))) }
  private func recover(_ error: Error, attempt: Int) async {
    state.status = "recovering"
    state.lastError = error.localizedDescription
    state.recoveryAttempt = attempt
    state.retryAt = Date().addingTimeInterval(delay(attempt))
    state.errors.insert(
      "\(ISO8601DateFormatter().string(from: Date())) \(error.localizedDescription)", at: 0)
    state.errors = Array(state.errors.prefix(50))
    await publish()
  }
  private func heartbeatLoop(generation current: Int, connection: Connection) async {
    var attempt = 0
    var wait: Double = 2
    while running && generation == current {
      do {
        try await Task.sleep(for: .seconds(wait))
        try Task.checkCancellation()
        guard running, generation == current else { return }
        let response = try await request(
          connection.heartbeat, connection: connection, body: body(), timeout: 10,
          generation: current)
        guard running, generation == current else { return }
        if await rejectAuthority(response) { return }
        guard (200..<300).contains(response.status) else {
          throw DesktopFailure("network_error", "Heartbeat failed (HTTP \(response.status))")
        }
        let heartbeat = try response.decode(ComputerUseHostHeartbeat.self)
        state.lastHeartbeat = Date()
        if acceptingCommands { state.status = "online" }
        state.lastError = nil
        state.retryAt = nil
        state.recoveryAttempt = 0
        attempt = 0
        wait = 15
        if heartbeat.hasPendingCommands {
          requestCommandRefresh(generation: current, connection: connection)
        }
        await publish()
      } catch is CancellationError { return } catch {
        guard running, generation == current else { return }
        if await rejectAuthentication(error) { return }
        attempt += 1
        wait = delay(attempt)
        await recover(error, attempt: attempt)
      }
    }
  }
  private func rejectAuthentication(_ error: Error) async -> Bool {
    guard let failure = error as? DesktopFailure, failure.code == "unauthenticated" else {
      return false
    }
    running = false
    acceptingCommands = false
    await stopNotifications()
    state.status = "error"
    state.lastError = failure.message
    await publish()
    return true
  }
  private func rejectAuthority(_ response: APIResponse) async -> Bool {
    guard [401, 403, 409, 426].contains(response.status) else { return false }
    if response.status == 426 {
      // Close admission without invalidating completion reports for claimed work.
      acceptingCommands = false
      await stopNotifications()
      recordUpgradeRequirement(response)
      await publish()
      return true
    }
    running = false
    acceptingCommands = false
    await stopNotifications()
    state.status = "error"
    state.lastError =
      response.status == 426
      ? "This version of Okou must be updated."
      : "Computer Use authority is no longer valid. Go offline and reconnect."
    await publish()
    return true
  }
  private func recordUpgradeRequirement(_ response: APIResponse) {
    state.updateRequired = true
    state.minimumSupportedVersion =
      (try? response.decode(DesktopUpgradeRequired.self))?.minimumSupportedVersion
    state.lastError = "This version of Okou must be updated."
  }
  private func stopNotifications() async {
    notificationStops += 1
    defer { notificationStops -= 1 }
    commandRetryTask?.cancel()
    commandRetryTask = nil
    notificationTask?.cancel()
    let task = notificationTask
    notificationTask = nil
    await notifications.stop()
    await task?.value
  }
  private func notificationLoop(
    subscription: CommandNotificationSubscription, generation current: Int, connection: Connection
  ) async {
    do {
      let api = api
      let provider = tokenProvider
      let events = try await notifications.start(
        subscription: subscription,
        tokenProvider: {
          let response = try await api.authenticatedRequest(
            ApiRoutes.platformRealtimeToken, body: .object([:]), timeout: 10,
            tokenProvider: { forceRefresh in
              let token = try await provider(forceRefresh)
              try await self.checkGeneration(current)
              return token
            })
          try await self.checkGeneration(current)
          guard (200..<300).contains(response.status) else {
            throw DesktopFailure(
              "network_error", "Realtime authentication failed (HTTP \(response.status))")
          }
          return response.body
        })
      for await event in events {
        guard !Task.isCancelled, running, acceptingCommands, generation == current else { return }
        switch event {
        case .refresh:
          requestCommandRefresh(generation: current, connection: connection)
        case .unavailable(let message):
          state.errors.insert(message, at: 0)
          state.errors = Array(state.errors.prefix(50))
          await publish()
        }
      }
    } catch is CancellationError {
    } catch {
      guard running, acceptingCommands, generation == current else { return }
      state.errors.insert(error.localizedDescription, at: 0)
      state.errors = Array(state.errors.prefix(50))
      await publish()
    }
  }
  private func requestCommandRefresh(generation current: Int, connection: Connection) {
    guard running, acceptingCommands, generation == current else { return }
    pendingRefresh = true
    guard drainTask == nil, commandRetryTask == nil else { return }
    drainTask = Task { await self.drainCommands(generation: current, connection: connection) }
  }
  private func drainCommands(generation current: Int, connection: Connection) async {
    defer { if generation == current { drainTask = nil } }
    while running && acceptingCommands && generation == current {
      do {
        pendingRefresh = false
        let claimStarted = ContinuousClock.now
        let response = try await request(
          connection.nextCommand, connection: connection,
          body: .object(["supportedCapabilities": .strings(CommandExecutor.capabilities)]),
          timeout: 5, generation: current)
        if await rejectAuthority(response) { return }
        guard (200..<300).contains(response.status) else {
          throw DesktopFailure("network_error", "Command claim failed (HTTP \(response.status))")
        }
        switch try response.decode(ComputerUseCommandClaim.self) {
        case .command(let command):
          // A late successful claim still owns a completion report,
          // even when logout/stop retired its local execution grant.
          var result: JSONValue
          if running && acceptingCommands && generation == current {
            state.commands.insert(
              CommandLog(
                id: command.id, kind: command.kind.rawValue, payload: .object(command.payload),
                startedAt: Date()), at: 0)
            state.commands = Array(state.commands.prefix(100))
            state.lastCommand = Date()
            await publish()
            result = await executor.execute(command, claimStarted: claimStarted)
            if let index = state.commands.firstIndex(where: { $0.id == command.id }) {
              state.commands[index].response = result
              state.commands[index].completedAt = Date()
            }
            state.lastCommand = Date()
            await publish()
          } else {
            result =
              DesktopFailure(
                "command_timeout", "Host stopped before dispatch; no action was started"
              ).response
          }
          try await complete(id: command.id, connection: connection, result: result)
        case .idle:
          commandRecoveryAttempt = 0
          // No await between checking the sticky flag and retiring this task:
          // a later actor callback observes nil and starts the next drain.
          if !pendingRefresh { return }
        }
        guard running, acceptingCommands, generation == current else { return }
        commandRecoveryAttempt = 0
      } catch is CancellationError { return } catch {
        guard running, acceptingCommands, generation == current else {
          state.errors.insert(error.localizedDescription, at: 0)
          state.errors = Array(state.errors.prefix(50))
          await publish()
          return
        }
        if await rejectAuthentication(error) { return }
        commandRecoveryAttempt += 1
        await recover(error, attempt: commandRecoveryAttempt)
        pendingRefresh = true
        let wait = delay(commandRecoveryAttempt)
        commandRetryTask = Task {
          do { try await Task.sleep(for: .seconds(wait)) } catch { return }
          guard !Task.isCancelled, self.running, self.acceptingCommands, self.generation == current
          else { return }
          self.commandRetryTask = nil
          self.requestCommandRefresh(generation: current, connection: connection)
        }
        return
      }
    }
  }
  private func complete(id: String, connection: Connection, result: JSONValue) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    var lastError: Error = DesktopFailure(
      "network_error", "Command completion could not be reported")
    for attempt in 0..<2 {
      let remaining = ContinuousClock.now.duration(to: deadline).seconds
      guard remaining > 0 else { break }
      do {
        let response = try await api.authenticatedRequest(
          connection.complete(commandId: id), body: connection.body(result),
          timeout: remaining, tokenProvider: tokenProvider)
        if (200..<300).contains(response.status) { return }
        if response.status == 409,
          (try? response.decode(ApiError.self))?.error.code == ApiConstants.apiErrorCodeConflict
        {
          return
        }
        if await rejectAuthority(response) {
          throw DesktopFailure(
            "result_unconfirmed",
            "Command may have executed, but its result could not be confirmed by the server")
        }
        lastError = DesktopFailure("network_error", "Completion failed (HTTP \(response.status))")
      } catch {
        if await rejectAuthentication(error) {
          throw DesktopFailure(
            "result_unconfirmed",
            "Command may have executed, but its result could not be confirmed by the server")
        }
        lastError = error
      }
      if attempt == 0 && ContinuousClock.now.duration(to: deadline).seconds > 2 {
        try await Task.sleep(for: .seconds(2))
      }
    }
    throw lastError
  }
}
