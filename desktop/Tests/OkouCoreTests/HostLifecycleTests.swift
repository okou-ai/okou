import Foundation
import XCTest

@testable import OkouCore

private func registeredHostResponse(generation: Int = 1) -> JSONValue {
  .object([
    "hostId": .string("00000000-0000-0000-0000-000000000001"),
    "connectionGeneration": .number(Double(generation)),
    "commandNotifications": .object([
      "channelName": .string(
        "computer-use-host:user_test:org_test:00000000-0000-0000-0000-000000000001:\(generation)"),
      "eventName": .string("commandsChanged"),
    ]),
  ])
}

private actor NotificationBoundary: CommandNotifications {
  private let attachedOnStart: Bool
  private let onStart: @Sendable () -> Void
  private var continuation: AsyncStream<CommandNotificationEvent>.Continuation?
  private var tokenProvider: (@Sendable () async throws -> JSONValue)?

  init(attachedOnStart: Bool = true, onStart: @escaping @Sendable () -> Void = {}) {
    self.attachedOnStart = attachedOnStart
    self.onStart = onStart
  }

  func start(
    subscription: CommandNotificationSubscription,
    tokenProvider: @escaping @Sendable () async throws -> JSONValue
  ) async throws -> AsyncStream<CommandNotificationEvent> {
    try Task.checkCancellation()
    let stream = AsyncStream<CommandNotificationEvent>.makeStream()
    continuation = stream.continuation
    self.tokenProvider = tokenProvider
    onStart()
    if attachedOnStart { continuation?.yield(.refresh) }
    return stream.stream
  }
  func refresh() { continuation?.yield(.refresh) }
  func renew() async throws -> JSONValue {
    guard let tokenProvider else { throw CancellationError() }
    return try await tokenProvider()
  }
  func tokenCallback() -> (@Sendable () async throws -> JSONValue)? { tokenProvider }
  func stop() {
    continuation?.finish()
    continuation = nil
    tokenProvider = nil
  }
}

private final class RequestCount: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  func next() -> Int {
    lock.withLock {
      count += 1
      return count
    }
  }
  var value: Int { lock.withLock { count } }
}

private func commandResponse(_ id: String) -> JSONValue {
  .object([
    "status": .string("command"),
    "command": .object([
      "id": .string(id), "kind": .string("apps.list"), "payload": .object([:]),
      "claimedAt": .string(ISO8601DateFormatter().string(from: Date())),
      "timeoutMs": .number(30_000),
    ]),
  ])
}

private func notificationTestSession() -> URLSession {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [URLProtocolFixture.self]
  return URLSession(configuration: configuration)
}

private func notificationTestRuntime(
  session: URLSession, notifications: NotificationBoundary,
  tokenProvider: @escaping @Sendable (Bool) async throws -> String = { _ in "clerk-session" },
  onChange: @escaping @MainActor @Sendable (RuntimeState) -> Void = { _ in }
) -> HostRuntime {
  HostRuntime(
    api: APIClient(
      baseURL: URL(string: "https://api.example.test")!, version: "0.52.0", session: session),
    executor: CommandExecutor(
      helper: NativeProcess(executable: URL(fileURLWithPath: "/nonexistent/helper"))),
    installationId: UUID().uuidString, hostName: "Test Mac", version: "0.52.0",
    notifications: notifications, tokenProvider: tokenProvider, onChange: onChange)
}

private final class HTTPBoundary: @unchecked Sendable {
  private let lock = NSLock()
  private var handler: (@Sendable (URLProtocolFixture) -> Void)?
  func set(_ handler: @escaping @Sendable (URLProtocolFixture) -> Void) {
    lock.withLock { self.handler = handler }
  }
  func serve(_ connection: URLProtocolFixture) { lock.withLock { handler }?(connection) }
}

private final class URLProtocolFixture: URLProtocol, @unchecked Sendable {
  static let boundary = HTTPBoundary()
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() { Self.boundary.serve(self) }
  override func stopLoading() {}
  func reply(_ body: JSONValue, status: Int = 200) {
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONEncoder().encode(body))
    client?.urlProtocolDidFinishLoading(self)
  }
  var body: JSONValue {
    if let data = request.httpBody { return try! JSONDecoder().decode(JSONValue.self, from: data) }
    guard let stream = request.httpBodyStream else { return .null }
    stream.open()
    defer { stream.close() }
    var bytes = [UInt8](repeating: 0, count: 4096)
    var data = Data()
    while stream.hasBytesAvailable {
      let count = stream.read(&bytes, maxLength: bytes.count)
      if count <= 0 { break }
      data.append(contentsOf: bytes.prefix(count))
    }
    return try! JSONDecoder().decode(JSONValue.self, from: data)
  }
}

private final class PendingResponse: @unchecked Sendable {
  private let lock = NSLock()
  private var connection: URLProtocolFixture?
  func hold(_ value: URLProtocolFixture) { lock.withLock { connection = value } }
  func reply(_ value: JSONValue) { lock.withLock { connection }!.reply(value) }
}

private final class CompletionFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var completed = false
  func finish() { lock.withLock { completed = true } }
  var value: Bool { lock.withLock { completed } }
}

private actor SessionTokens {
  private var first = true
  func next() -> String {
    defer { first = false }
    return first ? "clerk-session" : "refreshed-clerk-session"
  }
}

private final class StateTransitions: @unchecked Sendable {
  private let lock = NSLock()
  private var seen: Set<String> = []
  func notify(_ key: String, expectation: XCTestExpectation) {
    if lock.withLock({ seen.insert(key).inserted }) { expectation.fulfill() }
  }
}

final class HostLifecycleTests: XCTestCase, @unchecked Sendable {
  func testIdleHostWaitsForAnotherNotificationAndKeepsHeartbeatOperational() async throws {
    let first = expectation(description: "Initial subscription checks the queue")
    let unexpected = expectation(description: "Idle host must not poll")
    unexpected.isInverted = true
    let resumed = expectation(description: "Reconnect notification checks the queue")
    let heartbeat = expectation(description: "Idle heartbeat remains operational")
    let claims = RequestCount()
    let beats = RequestCount()
    let allowRefresh = CompletionFlag()
    let notifications = NotificationBoundary()
    let session = notificationTestSession()
    defer { session.invalidateAndCancel() }
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/register") {
        connection.reply(registeredHostResponse())
      } else if path.hasSuffix("/next") {
        if claims.next() == 1 {
          first.fulfill()
        } else if allowRefresh.value {
          resumed.fulfill()
        } else {
          unexpected.fulfill()
        }
        connection.reply(.object(["status": .string("idle")]))
      } else if path.hasSuffix("/heartbeat") {
        if beats.next() == 1 { heartbeat.fulfill() }
        connection.reply(.object(["hasPendingCommands": .bool(false)]))
      } else {
        connection.reply(.object([:]))
      }
    }
    let runtime = notificationTestRuntime(session: session, notifications: notifications)
    await runtime.start()
    await fulfillment(of: [first], timeout: 3)
    await fulfillment(of: [unexpected], timeout: 5.2)
    await fulfillment(of: [heartbeat], timeout: 1)
    XCTAssertEqual(claims.value, 1)
    allowRefresh.finish()
    await notifications.refresh()
    await fulfillment(of: [resumed], timeout: 1)
    await runtime.stop()
  }

  func testOneNotificationDrainsMultipleCommandsAndCoalescesNotificationsDuringReporting()
    async throws
  {
    let reporting = expectation(description: "First command waits for its completion response")
    let secondReported = expectation(description: "Second queued command is reported")
    let idle = expectation(description: "Queue is drained")
    let firstReport = PendingResponse()
    let claims = RequestCount()
    let notifications = NotificationBoundary()
    let session = notificationTestSession()
    defer { session.invalidateAndCancel() }
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/register") {
        connection.reply(registeredHostResponse())
      } else if path.hasSuffix("/next") {
        switch claims.next() {
        case 1: connection.reply(commandResponse("first"))
        case 2: connection.reply(commandResponse("second"))
        default:
          connection.reply(.object(["status": .string("idle")]))
          idle.fulfill()
        }
      } else if path.hasSuffix("/first/complete") {
        firstReport.hold(connection)
        reporting.fulfill()
      } else if path.hasSuffix("/second/complete") {
        connection.reply(.object([:]))
        secondReported.fulfill()
      } else if path.hasSuffix("/heartbeat") {
        connection.reply(.object(["hasPendingCommands": .bool(false)]))
      } else {
        connection.reply(.object([:]))
      }
    }
    let runtime = notificationTestRuntime(session: session, notifications: notifications)
    await runtime.start()
    await fulfillment(of: [reporting], timeout: 3)
    for _ in 0..<20 { await notifications.refresh() }
    XCTAssertEqual(claims.value, 1, "Notifications must not create a concurrent drain")
    firstReport.reply(.object([:]))
    await fulfillment(of: [secondReported, idle], timeout: 3, enforceOrder: true)
    await runtime.stop()
  }

  func testNotificationDuringIdleResponseTriggersAnotherClaim() async throws {
    let first = expectation(description: "First claim is pending")
    let second = expectation(description: "Notification near idle is not lost")
    let pending = PendingResponse()
    let claims = RequestCount()
    let notifications = NotificationBoundary()
    let session = notificationTestSession()
    defer { session.invalidateAndCancel() }
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/register") {
        connection.reply(registeredHostResponse())
      } else if path.hasSuffix("/next") {
        if claims.next() == 1 {
          pending.hold(connection)
          first.fulfill()
        } else {
          connection.reply(.object(["status": .string("idle")]))
          second.fulfill()
        }
      } else if path.hasSuffix("/heartbeat") {
        connection.reply(.object(["hasPendingCommands": .bool(false)]))
      } else {
        connection.reply(.object([:]))
      }
    }
    let runtime = notificationTestRuntime(session: session, notifications: notifications)
    await runtime.start()
    await fulfillment(of: [first], timeout: 3)
    await notifications.refresh()
    pending.reply(.object(["status": .string("idle")]))
    await fulfillment(of: [second], timeout: 1)
    await runtime.stop()
  }

  func testHeartbeatRecoversPendingCommandsWithoutAnAttachedNotificationChannel() async throws {
    let reported = expectation(description: "Heartbeat recovers the missed wakeup")
    let claims = RequestCount()
    let notifications = NotificationBoundary(attachedOnStart: false)
    let session = notificationTestSession()
    defer { session.invalidateAndCancel() }
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/register") {
        connection.reply(registeredHostResponse())
      } else if path.hasSuffix("/heartbeat") {
        XCTAssertEqual(claims.value, 0, "Startup must wait for attachment or a pending-work hint")
        connection.reply(.object(["hasPendingCommands": .bool(true)]))
      } else if path.hasSuffix("/next") {
        connection.reply(
          claims.next() == 1 ? commandResponse("missed") : .object(["status": .string("idle")]))
      } else if path.hasSuffix("/complete") {
        connection.reply(.object([:]))
        reported.fulfill()
      } else {
        connection.reply(.object([:]))
      }
    }
    let runtime = notificationTestRuntime(session: session, notifications: notifications)
    await runtime.start()
    await fulfillment(of: [reported], timeout: 4)
    await runtime.stop()
  }

  func testFailedClaimRetriesWithoutAnotherNotification() async throws {
    let retried = expectation(description: "Failed refresh retains its retry")
    let claims = RequestCount()
    let notifications = NotificationBoundary()
    let session = notificationTestSession()
    defer { session.invalidateAndCancel() }
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/register") {
        connection.reply(registeredHostResponse())
      } else if path.hasSuffix("/next") {
        if claims.next() == 1 {
          connection.reply(.object([:]), status: 503)
        } else {
          connection.reply(.object(["status": .string("idle")]))
          retried.fulfill()
        }
      } else if path.hasSuffix("/heartbeat") {
        connection.reply(.object(["hasPendingCommands": .bool(false)]))
      } else {
        connection.reply(.object([:]))
      }
    }
    let runtime = notificationTestRuntime(session: session, notifications: notifications)
    await runtime.start()
    await fulfillment(of: [retried], timeout: 4)
    XCTAssertEqual(claims.value, 2)
    await runtime.stop()
  }

  func testRealtimeRenewalUsesTheSharedEndpointAndCurrentSessionToken() async throws {
    let started = expectation(description: "Notification adapter is ready")
    let rotated = CompletionFlag()
    let requests = RequestCount()
    let notifications = NotificationBoundary(attachedOnStart: false, onStart: { started.fulfill() })
    let session = notificationTestSession()
    defer { session.invalidateAndCancel() }
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/register") {
        connection.reply(registeredHostResponse())
      } else if path == "/api/realtime/token" {
        XCTAssertEqual(connection.body, .object([:]))
        XCTAssertEqual(
          connection.request.value(forHTTPHeaderField: "Authorization"),
          rotated.value ? "Bearer renewed-session" : "Bearer first-session")
        connection.reply(.object(["nonce": .string("request-\(requests.next())")]))
      } else {
        connection.reply(.object([:]))
      }
    }
    let runtime = notificationTestRuntime(
      session: session, notifications: notifications,
      tokenProvider: { _ in rotated.value ? "renewed-session" : "first-session" })
    await runtime.start()
    await fulfillment(of: [started], timeout: 1)
    let first = try await notifications.renew()
    XCTAssertEqual(first["nonce"].string, "request-1")
    rotated.finish()
    let second = try await notifications.renew()
    XCTAssertEqual(second["nonce"].string, "request-2")
    await runtime.stop()
    XCTAssertEqual(requests.value, 2)
  }

  func testRetiredNotificationCallbackCannotMintTokensForAReplacementConnection() async throws {
    let firstStarted = expectation(description: "First notification source is ready")
    let replacementStarted = expectation(description: "Replacement notification source is ready")
    let starts = RequestCount()
    let registrations = RequestCount()
    let tokenRequests = RequestCount()
    let notifications = NotificationBoundary(
      attachedOnStart: false,
      onStart: {
        if starts.next() == 1 { firstStarted.fulfill() } else { replacementStarted.fulfill() }
      })
    let session = notificationTestSession()
    defer { session.invalidateAndCancel() }
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/register") {
        connection.reply(registeredHostResponse(generation: registrations.next()))
      } else if path == "/api/realtime/token" {
        connection.reply(.object(["nonce": .string("request-\(tokenRequests.next())")]))
      } else {
        connection.reply(.object([:]))
      }
    }
    let runtime = notificationTestRuntime(session: session, notifications: notifications)
    await runtime.start()
    await fulfillment(of: [firstStarted], timeout: 1)
    // Capture what a late SDK auth callback owns before retiring this connection.
    guard let retired = await notifications.tokenCallback() else {
      XCTFail("Notification source must own its token callback")
      await runtime.stop()
      return
    }
    await runtime.stop()
    await runtime.start()
    await fulfillment(of: [replacementStarted], timeout: 1)
    do {
      _ = try await retired()
      XCTFail("A retired callback must not obtain credentials")
    } catch is CancellationError {
    } catch {
      XCTFail("Expected lifecycle cancellation, received \(error)")
    }
    XCTAssertEqual(tokenRequests.value, 0)
    _ = try await notifications.renew()
    XCTAssertEqual(tokenRequests.value, 1)
    await runtime.stop()
  }

  func testStopWaitsForDelayedRegistrationAndStopsItsConnection() async throws {
    let received = expectation(description: "Server received registration")
    let stopping = expectation(description: "Admission is closed")
    let retired = expectation(description: "Late registration connection is stopped")
    let returned = expectation(description: "Stop returned after cleanup")
    let pending = PendingResponse()
    let finished = CompletionFlag()
    let transitions = StateTransitions()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolFixture.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/hosts/register") {
        pending.hold(connection)
        received.fulfill()
      } else if path.hasSuffix("/stop") {
        XCTAssertFalse(finished.value)
        XCTAssertEqual(
          connection.request.value(forHTTPHeaderField: "Authorization"), "Bearer clerk-session")
        retired.fulfill()
        connection.reply(.object([:]))
      } else {
        XCTFail("A stopped registration must not begin polling or heartbeats: \(path)")
        connection.reply(.object([:]))
      }
    }
    let runtime = HostRuntime(
      api: APIClient(
        baseURL: URL(string: "https://api.example.test")!, version: "0.49.72", session: session),
      executor: CommandExecutor(
        helper: NativeProcess(executable: URL(fileURLWithPath: "/nonexistent/helper"))),
      installationId: UUID().uuidString, hostName: "Test Mac", version: "0.49.72",
      notifications: NotificationBoundary(),
      tokenProvider: { _ in "clerk-session" },
      onChange: { state in
        if state.status == "stopping" { transitions.notify("stopping", expectation: stopping) }
      })
    let starting = Task { await runtime.start() }
    await fulfillment(of: [received], timeout: 3)
    let drain = Task {
      await runtime.stop()
      finished.finish()
      returned.fulfill()
    }
    await fulfillment(of: [stopping], timeout: 3)
    // Keep the server response pending long enough to observe an early return.
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertFalse(finished.value)
    pending.reply(
      registeredHostResponse())
    await fulfillment(of: [retired, returned], timeout: 3, enforceOrder: true)
    await starting.value
    await drain.value
  }

  func testUpgradeRejectionClosesAdmissionAndKeepsStopAuthenticated() async throws {
    let rejected = expectation(description: "Upgrade state is published")
    let stopped = expectation(description: "Rejected generation is stopped with its session")
    let transitions = StateTransitions()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolFixture.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      XCTAssertEqual(
        connection.request.value(forHTTPHeaderField: "Authorization"), "Bearer clerk-session")
      if path.hasSuffix("/hosts/register") {
        connection.reply(
          registeredHostResponse())
      } else if path.hasSuffix("/next") {
        connection.reply(.object(["minimumSupportedVersion": .string("0.51.0")]), status: 426)
      } else if path.hasSuffix("/stop") {
        stopped.fulfill()
        connection.reply(.object([:]))
      } else {
        XCTFail("Unexpected host request: \(path)")
      }
    }
    let runtime = HostRuntime(
      api: APIClient(
        baseURL: URL(string: "https://api.example.test")!, version: "0.50.1", session: session),
      executor: CommandExecutor(
        helper: NativeProcess(executable: URL(fileURLWithPath: "/nonexistent/helper"))),
      installationId: UUID().uuidString, hostName: "Test Mac", version: "0.50.1",
      notifications: NotificationBoundary(),
      tokenProvider: { _ in "clerk-session" },
      onChange: { state in
        if state.updateRequired {
          XCTAssertEqual(state.minimumSupportedVersion, "0.51.0")
          transitions.notify("rejected", expectation: rejected)
        }
      })
    await runtime.start()
    await fulfillment(of: [rejected], timeout: 3)
    await runtime.stop()
    await fulfillment(of: [stopped], timeout: 3)
  }

  func testAPIBoundsAnUnfinishedClaimRequest() async throws {
    let began = expectation(description: "Server received a claim")
    URLProtocolFixture.boundary.set { _ in began.fulfill() }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolFixture.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let api = APIClient(
      baseURL: URL(string: "https://api.example.test")!, version: "0.49.71", session: session)
    let started = ContinuousClock.now
    do {
      _ = try await api.request(
        "api/computer-use/host/commands/next", token: "host-token",
        body: .object([:]), timeout: 0.15)
      XCTFail("An unfinished claim must reach its total request deadline")
    } catch let error as DesktopFailure {
      XCTAssertEqual(error.code, "network_error")
      XCTAssertTrue(error.message.contains("timed out"))
    }
    await fulfillment(of: [began], timeout: 1)
    XCTAssertLessThan(started.duration(to: .now).seconds, 2)
  }
  func testStopKeepsHeartbeatAliveUntilRunningCommandIsReported() async throws {
    let transitions = StateTransitions()
    let began = expectation(description: "Command is visible in the UI")
    let stopping = expectation(description: "Admission is closed")
    let heartbeat = expectation(description: "Server receives a heartbeat while draining")
    let reported = expectation(description: "Running command completed successfully")
    let stopped = expectation(description: "Host authorization retired after reporting")
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let release = directory.appendingPathComponent("release")
    let marker = directory.appendingPathComponent("dispatched")
    let helper = directory.appendingPathComponent("helper")
    try """
    #!/usr/bin/python3
    import sys,json,time,pathlib
    for line in sys.stdin:
        r=json.loads(line)
        if r['kind']=='permissions.state':
            result={'accessibility':True,'screenRecording':True}
        else:
            pathlib.Path('\(marker.path)').write_text('once')
            while not pathlib.Path('\(release.path)').exists(): time.sleep(0.01)
            result={'apps':[{'name':'Test app'}]}
        print(json.dumps({'id':r['id'],'status':'succeeded','result':result}),flush=True)
    """.write(to: helper, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolFixture.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let timestamp = formatter.string(from: Date())
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/hosts/register") {
        connection.reply(
          registeredHostResponse())
      } else if path.hasSuffix("/next") {
        connection.reply(
          .object([
            "status": .string("command"),
            "command": .object([
              "id": .string("running"), "kind": .string("apps.list"), "payload": .object([:]),
              "timeoutMs": .number(60000),
              "createdAt": .string(timestamp), "claimedAt": .string(timestamp),
            ]),
          ]))
      } else if path.hasSuffix("/heartbeat") {
        XCTAssertEqual(try? String(contentsOf: marker, encoding: .utf8), "once")
        try! Data().write(to: release)
        connection.reply(.object([:]))
        heartbeat.fulfill()
      } else if path.hasSuffix("/complete") {
        XCTAssertEqual(connection.body["status"].string, "succeeded")
        XCTAssertEqual(connection.body["result"]["apps"].array?.first?["name"].string, "Test app")
        connection.reply(.object([:]))
        reported.fulfill()
      } else if path.hasSuffix("/stop") {
        connection.reply(.object([:]))
        stopped.fulfill()
      } else {
        XCTFail("Unexpected host request: \(path)")
      }
    }
    let runtime = HostRuntime(
      api: APIClient(
        baseURL: URL(string: "https://api.example.test")!, version: "0.49.71", session: session),
      executor: CommandExecutor(helper: NativeProcess(executable: helper)),
      installationId: UUID().uuidString,
      hostName: "Test Mac", version: "0.49.71", notifications: NotificationBoundary(),
      tokenProvider: { _ in "clerk-session" },
      onChange: { state in
        if state.busy && state.status == "online" {
          transitions.notify("began", expectation: began)
        }
        if state.status == "stopping" { transitions.notify("stopping", expectation: stopping) }
      })
    await runtime.start()
    await fulfillment(of: [began], timeout: 3)
    let drain = Task { await runtime.stop() }
    await fulfillment(of: [stopping], timeout: 3)
    let secondDrain = Task { await runtime.stop() }
    await fulfillment(of: [heartbeat, reported, stopped], timeout: 5, enforceOrder: true)
    await drain.value
    await secondDrain.value
  }
  func testUpgradeRejectionWhileDrainingDoesNotCancelCompletion() async throws {
    let transitions = StateTransitions()
    let began = expectation(description: "Command is visible in the UI")
    let stopping = expectation(description: "Admission is closed")
    let heartbeat = expectation(description: "Server receives a heartbeat while draining")
    let reported = expectation(description: "Running command completed successfully")
    let stopped = expectation(description: "Host authorization retired after reporting")
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let release = directory.appendingPathComponent("release")
    let marker = directory.appendingPathComponent("dispatched")
    let helper = directory.appendingPathComponent("helper")
    try """
    #!/usr/bin/python3
    import sys,json,time,pathlib
    for line in sys.stdin:
        r=json.loads(line)
        if r['kind']=='permissions.state':
            result={'accessibility':True,'screenRecording':True}
        else:
            pathlib.Path('\(marker.path)').write_text('once')
            while not pathlib.Path('\(release.path)').exists(): time.sleep(0.01)
            result={'apps':[{'name':'Test app'}]}
        print(json.dumps({'id':r['id'],'status':'succeeded','result':result}),flush=True)
    """.write(to: helper, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolFixture.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let timestamp = formatter.string(from: Date())
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/hosts/register") {
        connection.reply(
          registeredHostResponse())
      } else if path.hasSuffix("/next") {
        connection.reply(
          .object([
            "status": .string("command"),
            "command": .object([
              "id": .string("running"), "kind": .string("apps.list"), "payload": .object([:]),
              "timeoutMs": .number(60000),
              "createdAt": .string(timestamp), "claimedAt": .string(timestamp),
            ]),
          ]))
      } else if path.hasSuffix("/heartbeat") {
        XCTAssertEqual(try? String(contentsOf: marker, encoding: .utf8), "once")
        try! Data().write(to: release)
        connection.reply(.object(["minimumSupportedVersion": .string("0.51.0")]), status: 426)
        heartbeat.fulfill()
      } else if path.hasSuffix("/complete") {
        XCTAssertEqual(connection.body["status"].string, "succeeded")
        XCTAssertEqual(connection.body["result"]["apps"].array?.first?["name"].string, "Test app")
        connection.reply(.object([:]))
        reported.fulfill()
      } else if path.hasSuffix("/stop") {
        connection.reply(.object([:]))
        stopped.fulfill()
      } else {
        XCTFail("Unexpected host request: \(path)")
      }
    }
    let runtime = HostRuntime(
      api: APIClient(
        baseURL: URL(string: "https://api.example.test")!, version: "0.49.71", session: session),
      executor: CommandExecutor(helper: NativeProcess(executable: helper)),
      installationId: UUID().uuidString,
      hostName: "Test Mac", version: "0.49.71", notifications: NotificationBoundary(),
      tokenProvider: { _ in "clerk-session" },
      onChange: { state in
        if state.busy && state.status == "online" {
          transitions.notify("began", expectation: began)
        }
        if state.status == "stopping" { transitions.notify("stopping", expectation: stopping) }
      })
    await runtime.start()
    await fulfillment(of: [began], timeout: 3)
    let drain = Task { await runtime.stop() }
    await fulfillment(of: [stopping], timeout: 3)
    let secondDrain = Task { await runtime.stop() }
    await fulfillment(of: [heartbeat, reported, stopped], timeout: 5, enforceOrder: true)
    await drain.value
    await secondDrain.value
  }
  func testStopReportsLateClaimWithoutDispatchAndUsesCurrentSessionToken() async throws {
    let next = expectation(description: "Server received a claim request")
    let stopping = expectation(description: "UI reports admission closed")
    let complete = expectation(description: "Late claim was completed")
    let stopped = expectation(description: "Host stopped after completion")
    let claim = PendingResponse()
    let tokens = SessionTokens()
    let installation = UUID().uuidString.lowercased()
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/hosts/register") {
        XCTAssertEqual(
          connection.request.value(forHTTPHeaderField: "Authorization"), "Bearer clerk-session")
        XCTAssertEqual(connection.request.value(forHTTPHeaderField: "X-Client-Type"), "Desktop")
        XCTAssertEqual(connection.body["installationId"].string, installation)
        connection.reply(
          registeredHostResponse())
      } else {
        XCTAssertEqual(
          connection.request.value(forHTTPHeaderField: "Authorization"),
          "Bearer refreshed-clerk-session")
        if path.hasSuffix("/next") {
          claim.hold(connection)
          next.fulfill()
        } else if path.hasSuffix("/complete") {
          XCTAssertEqual(connection.body["status"].string, "failed")
          XCTAssertEqual(connection.body["error"]["code"].string, "command_timeout")
          XCTAssertTrue(
            connection.body["error"]["message"].string!.contains("no action was started"))
          connection.reply(.object([:]))
          complete.fulfill()
        } else if path.hasSuffix("/stop") {
          connection.reply(.object([:]))
          stopped.fulfill()
        } else {
          connection.reply(.object([:]))
        }
      }
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolFixture.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    // A missing helper proves that a retired claim never crosses the native boundary.
    let runtime = HostRuntime(
      api: APIClient(
        baseURL: URL(string: "https://api.example.test")!, version: "0.49.71", session: session),
      executor: CommandExecutor(
        helper: NativeProcess(executable: URL(fileURLWithPath: "/nonexistent/helper"))),
      installationId: installation, hostName: "Test Mac", version: "0.49.71",
      notifications: NotificationBoundary(),
      tokenProvider: { _ in await tokens.next() },
      onChange: { state in
        if state.status == "stopping" { stopping.fulfill() }
      })
    await runtime.start()
    await fulfillment(of: [next], timeout: 3)
    let drain = Task { await runtime.stop() }
    await fulfillment(of: [stopping], timeout: 3)
    claim.reply(
      .object([
        "status": .string("command"),
        "command": .object([
          "id": .string("command-1"), "kind": .string("app.open"),
          "payload": .object(["app": .string("com.apple.calculator")]),
        ]),
      ]))
    await fulfillment(of: [complete, stopped], timeout: 3, enforceOrder: true)
    await drain.value
  }

  func testExpiredServerClaimDoesNotStartNativeHelper() async throws {
    let reported = expectation(description: "Expired claim was reported")
    let idle = expectation(description: "Expired command queue was drained")
    let claims = RequestCount()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolFixture.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/hosts/register") {
        connection.reply(
          registeredHostResponse())
      } else if path.hasSuffix("/next") {
        if claims.next() == 1 {
          connection.reply(
            .object([
              "status": .string("command"),
              "command": .object([
                "id": .string("expired"), "kind": .string("apps.list"), "payload": .object([:]),
                "timeoutMs": .number(1000),
                "createdAt": .string("2026-10-07T00:00:00.000Z"),
                "claimedAt": .string("2026-10-07T00:00:02.000Z"),
              ]),
            ]))
        } else {
          connection.reply(.object(["status": .string("idle")]))
          idle.fulfill()
        }
      } else if path.hasSuffix("/expired/complete") {
        XCTAssertEqual(connection.body["status"].string, "failed")
        XCTAssertEqual(connection.body["error"]["code"].string, "command_timeout")
        connection.reply(.object([:]))
        reported.fulfill()
      } else {
        connection.reply(.object([:]))
      }
    }
    let runtime = HostRuntime(
      api: APIClient(
        baseURL: URL(string: "https://api.example.test")!, version: "0.49.71", session: session),
      executor: CommandExecutor(
        helper: NativeProcess(executable: URL(fileURLWithPath: "/nonexistent/helper"))),
      installationId: UUID().uuidString, hostName: "Test Mac", version: "0.49.71",
      notifications: NotificationBoundary(),
      tokenProvider: { _ in "clerk-session" }, onChange: { _ in })
    await runtime.start()
    await fulfillment(of: [reported, idle], timeout: 3)
    await runtime.stop()
  }
  func testAuthenticationRefreshesRejectedTokenBeforeReportingTheSameResult() async throws {
    let old = expectation(description: "Cached token rejected")
    let renewed = expectation(description: "SDK refresh used for the same result")
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolFixture.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let result: JSONValue = .object([
      "status": .string("succeeded"), "result": .object(["apps": .array([])]),
    ])
    URLProtocolFixture.boundary.set { connection in
      XCTAssertEqual(connection.body, result)
      if connection.request.value(forHTTPHeaderField: "Authorization") == "Bearer cached-session" {
        old.fulfill()
        connection.reply(.object([:]), status: 401)
      } else {
        XCTAssertEqual(
          connection.request.value(forHTTPHeaderField: "Authorization"), "Bearer fresh-session")
        renewed.fulfill()
        connection.reply(.object(["ok": .bool(true)]))
      }
    }
    let api = APIClient(
      baseURL: URL(string: "https://api.example.test")!, version: "0.50.0", session: session)
    let response = try await api.authenticatedRequest(
      "api/computer-use/hosts/host/commands/command/complete", body: result, timeout: 1,
      tokenProvider: { force in force ? "fresh-session" : "cached-session" })
    XCTAssertEqual(response.status, 200)
    await fulfillment(of: [old, renewed], timeout: 1, enforceOrder: true)
  }

  func testAuthenticationBudgetIncludesAnUnfinishedSDKRead() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolFixture.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    URLProtocolFixture.boundary.set { connection in
      XCTFail("An unfinished token lookup must not submit a request")
      connection.reply(.object([:]))
    }
    let api = APIClient(
      baseURL: URL(string: "https://api.example.test")!, version: "0.50.0", session: session)
    do {
      _ = try await api.authenticatedRequest(
        "api/computer-use/hosts/register", body: .object([:]), timeout: 0.05,
        tokenProvider: { _ in
          try await Task.sleep(for: .seconds(10))
          return "session"
        })
      XCTFail("SDK lookup must share the request deadline")
    } catch let error as DesktopFailure {
      XCTAssertEqual(error.code, "network_error")
    }
  }

  func testOldAPIDoesNotFallBackToHostTokenRegistration() async throws {
    let unavailable = expectation(description: "Unsupported protocol shown to user")
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolFixture.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    URLProtocolFixture.boundary.set { connection in
      XCTAssertTrue(connection.request.url!.path.hasSuffix("/hosts/register"))
      connection.reply(.object([:]), status: 404)
    }
    let runtime = HostRuntime(
      api: APIClient(
        baseURL: URL(string: "https://api.example.test")!, version: "0.50.0", session: session),
      executor: CommandExecutor(
        helper: NativeProcess(executable: URL(fileURLWithPath: "/nonexistent/helper"))),
      installationId: UUID().uuidString, hostName: "Mac", version: "0.50.0",
      notifications: NotificationBoundary(),
      tokenProvider: { _ in "clerk-session" },
      onChange: { state in if state.status == "error" { unavailable.fulfill() } })
    await runtime.start()
    await fulfillment(of: [unavailable], timeout: 1)
    await runtime.stop()
  }

}
