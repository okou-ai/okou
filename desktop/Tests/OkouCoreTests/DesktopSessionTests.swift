import Foundation
import XCTest

@testable import OkouCore

@MainActor
private final class SessionBoundary: DesktopSessionSource {
  var snapshot: DesktopSessionSnapshot
  var tokenRead: (@MainActor (Bool) async throws -> String?)?
  var refreshClient: (@MainActor () async throws -> Void)?
  private var continuation: AsyncStream<DesktopSessionSnapshot>.Continuation?

  init(_ snapshot: DesktopSessionSnapshot = signedInSnapshot()) { self.snapshot = snapshot }
  func updates() -> AsyncStream<DesktopSessionSnapshot> {
    let stream = AsyncStream<DesktopSessionSnapshot>.makeStream()
    continuation = stream.continuation
    continuation?.yield(snapshot)
    return stream.stream
  }
  func change(_ value: DesktopSessionSnapshot) {
    snapshot = value
    continuation?.yield(value)
  }
  func token(forceRefresh: Bool) async throws -> String? {
    if let tokenRead { return try await tokenRead(forceRefresh) }
    guard snapshot.active, let identity = snapshot.identity else { return nil }
    return identity.organizationId == "org_b" ? "token-b" : "token-a"
  }
  func refresh() async throws { try await refreshClient?() }
  func stop() {
    continuation?.finish()
    continuation = nil
  }
}

private func signedInSnapshot(
  org: String = "org_a", name: String? = "Workspace A", active: Bool = true
) -> DesktopSessionSnapshot {
  DesktopSessionSnapshot(
    loaded: true, active: active,
    identity: DesktopSessionIdentity(userId: "user_a", sessionId: "session_a", organizationId: org),
    email: "member@example.test", organizationName: name)
}

private final class SessionHTTPBoundary: @unchecked Sendable {
  private let lock = NSLock()
  private var requests: [URLRequest] = []
  private var handler: (@Sendable (SessionURLProtocol) -> Void)?
  func set(_ handler: @escaping @Sendable (SessionURLProtocol) -> Void) {
    lock.withLock {
      self.handler = handler
      requests = []
    }
  }
  func serve(_ connection: SessionURLProtocol) {
    let handler = lock.withLock {
      requests.append(connection.request)
      return self.handler
    }
    handler?(connection)
  }
  func count(_ path: String) -> Int {
    lock.withLock { requests.filter { $0.url?.path == path }.count }
  }
  var captured: [URLRequest] { lock.withLock { requests } }
}

private final class SessionURLProtocol: URLProtocol, @unchecked Sendable {
  static let boundary = SessionHTTPBoundary()
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() { Self.boundary.serve(self) }
  override func stopLoading() {}
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
  func reply(_ body: JSONValue, status: Int = 200) {
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONEncoder().encode(body))
    client?.urlProtocolDidFinishLoading(self)
  }
}

private func replySessionRequest(_ connection: SessionURLProtocol) {
  let org =
    connection.request.value(forHTTPHeaderField: "Authorization") == "Bearer token-b"
    ? "org_b" : "org_a"
  switch connection.request.url!.path {
  case "/api/auth/me":
    connection.reply(
      .object([
        "userId": .string("user_a"), "sessionId": .string("session_a"), "orgId": .string(org),
        "email": .string("member@example.test"),
      ]))
  case "/api/org":
    connection.reply(.object(["id": .string(org), "name": .string("Loaded workspace")]))
  case "/api/feature-switches":
    connection.reply(
      .object([
        "effectiveSwitches": .object(["_debug": .bool(org == "org_a")])
      ]))
  default: XCTFail("Unexpected HTTP request: \(connection.request.url!.path)")
  }
}

@MainActor
private final class SessionView {
  var state = DesktopSessionState()
  var conditions: [(String, (DesktopSessionState) -> Bool, XCTestExpectation)] = []
  private var delivered: Set<String> = []
  func apply(_ state: DesktopSessionState) {
    self.state = state
    for (id, condition, expectation) in conditions where !delivered.contains(id) {
      if condition(state) {
        delivered.insert(id)
        expectation.fulfill()
      }
    }
  }
}

private func sessionTestAPI() -> (APIClient, URLSession) {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [SessionURLProtocol.self]
  let session = URLSession(configuration: configuration)
  return (
    APIClient(
      baseURL: URL(string: "https://api.example.test")!, version: "0.52.2", session: session),
    session
  )
}

final class DesktopSessionTests: XCTestCase, @unchecked Sendable {
  @MainActor
  func testProfileAndTokenEventsKeepVerifiedScopeWithoutRepeatedConfigurationReads() async throws {
    SessionURLProtocol.boundary.set(replySessionRequest)
    let source = SessionBoundary(signedInSnapshot(name: nil))
    let view = SessionView()
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api, stopHost: { XCTFail("A profile refresh must retain the host") },
      onChange: view.apply)
    await coordinator.start()
    XCTAssertTrue(view.state.signedIn)
    XCTAssertEqual(view.state.organizationName, "Loaded workspace")
    XCTAssertTrue(view.state.developerToolsAvailable)
    let renamed = expectation(description: "SDK profile change is displayed")
    view.conditions = [("renamed", { $0.organizationName == "Renamed workspace" }, renamed)]
    for _ in 0..<100 { source.change(source.snapshot) }
    source.change(signedInSnapshot(name: "Renamed workspace"))
    await fulfillment(of: [renamed], timeout: 1)
    XCTAssertEqual(SessionURLProtocol.boundary.count("/api/auth/me"), 1)
    XCTAssertEqual(SessionURLProtocol.boundary.count("/api/org"), 1)
    XCTAssertEqual(SessionURLProtocol.boundary.count("/api/feature-switches"), 1)
    let currentToken = try await coordinator.token(forceRefresh: false)
    XCTAssertEqual(currentToken, "token-a")
    await coordinator.synchronize()
    XCTAssertEqual(SessionURLProtocol.boundary.count("/api/auth/me"), 2)
    XCTAssertEqual(SessionURLProtocol.boundary.count("/api/feature-switches"), 2)
    XCTAssertTrue(SessionURLProtocol.boundary.captured.allSatisfy { $0.httpMethod == "GET" })
    await coordinator.stop()
  }

  @MainActor
  func testForegroundRequestsShareAnInFlightSynchronization() async throws {
    let claimed = expectation(description: "Identity check reaches the server")
    let pending = PendingSessionResponse()
    SessionURLProtocol.boundary.set { connection in
      if connection.request.url!.path == "/api/auth/me" {
        pending.hold(connection)
        claimed.fulfill()
      } else {
        replySessionRequest(connection)
      }
    }
    let source = SessionBoundary()
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api, stopHost: {}, onChange: { _ in })
    let start = Task { await coordinator.start() }
    await fulfillment(of: [claimed], timeout: 1)
    let foregroundStarted = expectation(description: "Foreground synchronization joins")
    let wakeStarted = expectation(description: "Wake synchronization joins")
    let foreground = Task {
      foregroundStarted.fulfill()
      await coordinator.synchronize()
    }
    let wake = Task {
      wakeStarted.fulfill()
      await coordinator.synchronize()
    }
    await fulfillment(of: [foregroundStarted, wakeStarted], timeout: 1)
    pending.reply()
    await start.value
    await foreground.value
    await wake.value
    XCTAssertEqual(SessionURLProtocol.boundary.count("/api/auth/me"), 1)
    XCTAssertEqual(SessionURLProtocol.boundary.count("/api/feature-switches"), 1)
    await coordinator.stop()
  }

  @MainActor
  func testIdentityChangeDuringTokenLookupCannotSubmitTheOldScope() async throws {
    SessionURLProtocol.boundary.set(replySessionRequest)
    let source = SessionBoundary()
    source.tokenRead = { _ in
      if source.snapshot.identity?.organizationId == "org_a" {
        source.change(signedInSnapshot(org: "org_b", name: "Workspace B"))
        return "token-a"
      }
      return "token-b"
    }
    let view = SessionView()
    let verified = expectation(description: "New workspace is verified")
    view.conditions = [("verified", { $0.identity?.organizationId == "org_b" }, verified)]
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api, stopHost: {}, onChange: view.apply)
    await coordinator.start()
    await fulfillment(of: [verified], timeout: 1)
    XCTAssertFalse(view.state.developerToolsAvailable)
    XCTAssertTrue(
      SessionURLProtocol.boundary.captured.allSatisfy {
        $0.value(forHTTPHeaderField: "Authorization") == "Bearer token-b"
      })
    let currentToken = try await coordinator.token(forceRefresh: false)
    XCTAssertEqual(currentToken, "token-b")
    await coordinator.stop()
  }

  @MainActor
  func testFailedConfigurationRecoveryRetainsIdentityAndDisablesDeveloperTools() async throws {
    let recovered = expectation(description: "Configuration recovers through bounded retry")
    let count = SessionRequestCount()
    SessionURLProtocol.boundary.set { connection in
      if connection.request.url!.path == "/api/feature-switches", count.next() == 1 {
        connection.reply(.object([:]), status: 503)
      } else {
        replySessionRequest(connection)
      }
    }
    let source = SessionBoundary()
    let view = SessionView()
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api, stopHost: { XCTFail("A provider failure is not a sign-out") },
      onChange: view.apply)
    await coordinator.start()
    XCTAssertTrue(view.state.signedIn)
    XCTAssertFalse(view.state.developerToolsAvailable)
    XCTAssertNotNil(view.state.error)
    view.conditions = [
      ("recovered", { $0.developerToolsAvailable && $0.error == nil }, recovered)
    ]
    await fulfillment(of: [recovered], timeout: 4)
    XCTAssertEqual(SessionURLProtocol.boundary.count("/api/feature-switches"), 2)
    await coordinator.stop()
  }

  @MainActor
  func testRejectedAuthenticationRefreshesOnceAndCannotKeepAHostGrant() async throws {
    SessionURLProtocol.boundary.set { connection in
      connection.reply(.object([:]), status: 401)
    }
    let source = SessionBoundary()
    var forcedRefreshes = 0
    source.tokenRead = { force in
      if force { forcedRefreshes += 1 }
      return "token-a"
    }
    let view = SessionView()
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api, stopHost: {}, onChange: view.apply)
    await coordinator.start()
    XCTAssertEqual(forcedRefreshes, 1)
    XCTAssertEqual(SessionURLProtocol.boundary.count("/api/auth/me"), 2)
    XCTAssertFalse(view.state.signedIn)
    do {
      _ = try await coordinator.token(forceRefresh: false)
      XCTFail("An unverified identity cannot authenticate host requests")
    } catch {
      XCTAssertEqual((error as? DesktopFailure)?.code, "unauthenticated")
    }
    await coordinator.stop()
  }

  @MainActor
  func testRemoteRejectionRefreshesTheSDKAndPublishesSignedOut() async throws {
    SessionURLProtocol.boundary.set(replySessionRequest)
    let source = SessionBoundary()
    let view = SessionView()
    let retired = expectation(description: "Remote sign-out closes the host")
    let signedOut = expectation(description: "Account UI reflects remote rejection")
    var stopping = false
    view.conditions = [
      ("signedout", { !$0.preparing && !$0.signedIn && stopping }, signedOut)
    ]
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api,
      stopHost: {
        if !stopping {
          stopping = true
          retired.fulfill()
        }
      },
      onChange: view.apply)
    await coordinator.start()
    source.refreshClient = {
      source.change(DesktopSessionSnapshot(loaded: true, active: false, identity: nil))
    }
    coordinator.authorityRejected(.authentication)
    await fulfillment(of: [retired, signedOut], timeout: 1)
    XCTAssertFalse(view.state.developerToolsAvailable)
    await coordinator.stop()
  }

  @MainActor
  func testPendingSessionCannotBecomeOnlineUntilItIsActive() async throws {
    SessionURLProtocol.boundary.set(replySessionRequest)
    let source = SessionBoundary(signedInSnapshot(active: false))
    let view = SessionView()
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api, stopHost: {}, onChange: view.apply)
    await coordinator.start()
    XCTAssertFalse(view.state.signedIn)
    XCTAssertEqual(SessionURLProtocol.boundary.count("/api/auth/me"), 0)
    source.change(signedInSnapshot())
    await coordinator.synchronize()
    XCTAssertTrue(view.state.signedIn)
    XCTAssertEqual(SessionURLProtocol.boundary.count("/api/auth/me"), 1)
    await coordinator.stop()
  }

  @MainActor
  func testLocalSignOutDrainsClaimedWorkWithTheOriginalSession() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let helper = directory.appendingPathComponent("helper")
    let release = directory.appendingPathComponent("release")
    let script = """
      #!/usr/bin/env python3
      import json,sys,time,os
      for line in sys.stdin:
        request=json.loads(line)
        if request['kind']=='permissions.state':
          result={'accessibility':True,'screenRecording':True}
        elif request['kind']=='apps.list':
          while not os.path.exists(\(String(reflecting: release.path))): time.sleep(0.01)
          result={'apps':[]}
        else: result={}
        print(json.dumps({'id':request['id'],'status':'succeeded','result':result}),flush=True)
      """
    try script.write(to: helper, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helper.path)
    let running = expectation(description: "Claimed command is executing")
    let stopping = expectation(description: "Sign-out closes command admission")
    let heartbeat = expectation(description: "Draining retains the original session heartbeat")
    let completed = expectation(description: "Completion is reported before SDK sign-out")
    let action = expectation(description: "SDK mutation occurs after drain")
    let claims = SessionRequestCount()
    let beats = SessionRequestCount()
    let completionReported = SessionCompletionFlag()
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let timestamp = formatter.string(from: Date())
    SessionURLProtocol.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/register") {
        connection.reply(
          .object([
            "hostId": .string("00000000-0000-0000-0000-000000000001"),
            "connectionGeneration": .number(1),
            "commandNotifications": .object([
              "channelName": .string("commands_a"), "eventName": .string("commandsChanged"),
            ]),
          ]))
      } else if path.hasSuffix("/next") {
        if claims.next() == 1 {
          connection.reply(
            .object([
              "status": .string("command"),
              "command": .object([
                "id": .string("00000000-0000-0000-0000-000000000002"), "kind": .string("apps.list"),
                "payload": .object([:]), "timeoutMs": .number(30_000),
                "claimedAt": .string(timestamp), "createdAt": .string(timestamp),
              ]),
            ]))
        } else {
          connection.reply(.object(["status": .string("idle")]))
        }
      } else if path.hasSuffix("/heartbeat") {
        XCTAssertEqual(
          connection.request.value(forHTTPHeaderField: "Authorization"), "Bearer token-a")
        connection.reply(.object(["hasPendingCommands": .bool(false)]))
        if beats.next() == 1 { heartbeat.fulfill() }
      } else if path.hasSuffix("/complete") {
        XCTAssertEqual(
          connection.request.value(forHTTPHeaderField: "Authorization"), "Bearer token-a")
        XCTAssertEqual(connection.body["status"].string, "succeeded")
        completionReported.finish()
        connection.reply(.object([:]))
        completed.fulfill()
      } else if path.hasSuffix("/stop") {
        connection.reply(.object([:]))
      } else {
        replySessionRequest(connection)
      }
    }
    let source = SessionBoundary()
    let view = SessionView()
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let holder = SessionHostHolder()
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api, stopHost: { await holder.host?.stop() }, onChange: view.apply)
    let hostView = SessionHostView(running: running, stopping: stopping)
    let runtime = HostRuntime(
      api: api, executor: CommandExecutor(helper: NativeProcess(executable: helper)),
      installationId: UUID().uuidString, hostName: "Test Mac", version: "0.52.2",
      notifications: SessionNotificationBoundary(),
      tokenProvider: { try await coordinator.token(forceRefresh: $0) },
      onChange: hostView.apply)
    holder.host = runtime
    await coordinator.start()
    await runtime.start()
    await fulfillment(of: [running], timeout: 2)
    let transition = Task {
      try await coordinator.transition {
        XCTAssertTrue(completionReported.value)
        source.change(DesktopSessionSnapshot(loaded: true, active: false, identity: nil))
        action.fulfill()
      }
    }
    await fulfillment(of: [stopping, heartbeat], timeout: 4)
    XCTAssertTrue(view.state.signedIn)
    try Data().write(to: release)
    await fulfillment(of: [completed, action], timeout: 3, enforceOrder: true)
    try await transition.value
    XCTAssertFalse(view.state.signedIn)
    XCTAssertEqual(claims.current, 1)
    await coordinator.stop()
  }

  @MainActor
  func testManualOfflineAndConnectionRejectionSurviveLaterSynchronizations() async throws {
    SessionURLProtocol.boundary.set(replySessionRequest)
    let source = SessionBoundary()
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api, stopHost: {}, onChange: { _ in })
    await coordinator.start()
    coordinator.setOnlineIntent(false)
    source.change(signedInSnapshot(name: "Renamed workspace"))
    await coordinator.synchronize()
    XCTAssertTrue(coordinator.state.signedIn)
    XCTAssertFalse(coordinator.wantsOnline)
    coordinator.setOnlineIntent(true)
    coordinator.authorityRejected(.connectionInvalid)
    await coordinator.synchronize()
    XCTAssertTrue(coordinator.state.signedIn)
    XCTAssertFalse(coordinator.wantsOnline)
    await coordinator.stop()
  }

  @MainActor
  func testFailedWorkspaceMutationKeepsThePreviousAccountOffline() async throws {
    SessionURLProtocol.boundary.set(replySessionRequest)
    let source = SessionBoundary()
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api, stopHost: {}, onChange: { _ in })
    await coordinator.start()
    do {
      try await coordinator.transition {
        throw DesktopFailure("network_error", "Workspace activation failed")
      }
      XCTFail("The failed SDK operation must reach the caller")
    } catch {
      XCTAssertEqual((error as? DesktopFailure)?.code, "network_error")
    }
    XCTAssertEqual(coordinator.state.identity?.organizationId, "org_a")
    XCTAssertFalse(coordinator.wantsOnline)
    await coordinator.stop()
  }

  @MainActor
  func testMismatchedServerIdentityRetiresThePreviouslyVerifiedGrant() async throws {
    let calls = SessionRequestCount()
    SessionURLProtocol.boundary.set { connection in
      if connection.request.url!.path == "/api/auth/me", calls.next() > 1 {
        connection.reply(
          .object([
            "userId": .string("user_a"), "sessionId": .string("session_a"),
            "orgId": .string("org_b"), "email": .string("member@example.test"),
          ]))
      } else {
        replySessionRequest(connection)
      }
    }
    let source = SessionBoundary()
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api, stopHost: {}, onChange: { _ in })
    await coordinator.start()
    XCTAssertTrue(coordinator.state.signedIn)
    await coordinator.synchronize()
    XCTAssertFalse(coordinator.state.signedIn)
    do {
      _ = try await coordinator.token(forceRefresh: false)
      XCTFail("A mismatched server identity must not retain command authority")
    } catch {
      XCTAssertEqual((error as? DesktopFailure)?.code, "unauthenticated")
    }
    await coordinator.stop()
  }

  @MainActor
  func testForbiddenFeatureSwitchReadKeepsTheAccountAndHostAuthentication() async throws {
    SessionURLProtocol.boundary.set { connection in
      if connection.request.url!.path == "/api/feature-switches" {
        connection.reply(.object([:]), status: 403)
      } else {
        replySessionRequest(connection)
      }
    }
    let source = SessionBoundary()
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api,
      stopHost: { XCTFail("A debug configuration denial is not sign-out") },
      onChange: { _ in })
    await coordinator.start()
    XCTAssertTrue(coordinator.state.signedIn)
    XCTAssertTrue(coordinator.state.canAuthenticateHost)
    XCTAssertFalse(coordinator.state.developerToolsAvailable)
    let token = try await coordinator.token(forceRefresh: false)
    XCTAssertEqual(token, "token-a")
    await coordinator.stop()
  }

  @MainActor
  func testForbiddenIdentityReadShowsTheSDKAccountWithoutGrantingHostAccess() async throws {
    SessionURLProtocol.boundary.set { connection in
      connection.reply(.object([:]), status: 403)
    }
    let source = SessionBoundary()
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api, stopHost: {}, onChange: { _ in })
    await coordinator.start()
    XCTAssertTrue(coordinator.state.signedIn)
    XCTAssertFalse(coordinator.state.canAuthenticateHost)
    XCTAssertFalse(coordinator.wantsOnline)
    do {
      _ = try await coordinator.token(forceRefresh: false)
      XCTFail("The displayed SDK account does not grant host access")
    } catch {
      XCTAssertEqual((error as? DesktopFailure)?.code, "unauthenticated")
    }
    await coordinator.stop()
  }

  @MainActor
  func testShutdownFinishesSDKObservationAndRetiresTheTokenProvider() async throws {
    SessionURLProtocol.boundary.set(replySessionRequest)
    let source = SessionBoundary()
    let (api, session) = sessionTestAPI()
    defer { session.invalidateAndCancel() }
    let coordinator = DesktopSessionCoordinator(
      source: source, api: api, stopHost: {}, onChange: { _ in })
    await coordinator.start()
    await coordinator.stop()
    source.change(signedInSnapshot(org: "org_b", name: "Workspace B"))
    await coordinator.synchronize()
    XCTAssertEqual(SessionURLProtocol.boundary.count("/api/auth/me"), 1)
    do {
      _ = try await coordinator.token(forceRefresh: false)
      XCTFail("A retired callback cannot obtain authentication")
    } catch {
      XCTAssertEqual((error as? DesktopFailure)?.code, "unauthenticated")
    }
  }
}

private final class PendingSessionResponse: @unchecked Sendable {
  private let lock = NSLock()
  private var connection: SessionURLProtocol?
  func hold(_ connection: SessionURLProtocol) { lock.withLock { self.connection = connection } }
  func reply() { replySessionRequest(lock.withLock { connection }!) }
}

private final class SessionRequestCount: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  func next() -> Int {
    lock.withLock {
      value += 1
      return value
    }
  }
  var current: Int { lock.withLock { value } }
}

private actor SessionNotificationBoundary: CommandNotifications {
  private var continuation: AsyncStream<CommandNotificationEvent>.Continuation?
  func start(
    subscription: CommandNotificationSubscription,
    tokenProvider: @escaping @Sendable () async throws -> JSONValue
  ) async throws -> AsyncStream<CommandNotificationEvent> {
    let stream = AsyncStream<CommandNotificationEvent>.makeStream()
    continuation = stream.continuation
    continuation?.yield(.refresh)
    return stream.stream
  }
  func stop() {
    continuation?.finish()
    continuation = nil
  }
}

private final class SessionCompletionFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var completed = false
  func finish() { lock.withLock { completed = true } }
  var value: Bool { lock.withLock { completed } }
}

@MainActor
private final class SessionHostHolder { var host: HostRuntime? }

@MainActor
private final class SessionHostView {
  private let running: XCTestExpectation
  private let stopping: XCTestExpectation
  private var delivered: Set<String> = []
  init(running: XCTestExpectation, stopping: XCTestExpectation) {
    self.running = running
    self.stopping = stopping
  }
  func apply(_ state: RuntimeState) {
    if state.busy, delivered.insert("running").inserted { running.fulfill() }
    if state.status == "stopping", delivered.insert("stopping").inserted { stopping.fulfill() }
  }
}
