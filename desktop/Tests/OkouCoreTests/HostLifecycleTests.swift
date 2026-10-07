import Foundation
import XCTest

@testable import OkouCore

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

private final class PendingClaim: @unchecked Sendable {
  private let lock = NSLock()
  private var connection: URLProtocolFixture?
  func hold(_ value: URLProtocolFixture) { lock.withLock { connection = value } }
  func reply(_ value: JSONValue) { lock.withLock { connection }!.reply(value) }
}

private final class StateTransitions: @unchecked Sendable {
  private let lock = NSLock()
  private var seen: Set<String> = []
  func notify(_ key: String, expectation: XCTestExpectation) {
    if lock.withLock({ seen.insert(key).inserted }) { expectation.fulfill() }
  }
}

final class HostLifecycleTests: XCTestCase, @unchecked Sendable {
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
      if path.hasSuffix("/hosts/start") {
        connection.reply(
          .object(["hostToken": .string("host-token"), "hostId": .string("host-1")]))
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
      hostName: "Test Mac", version: "0.49.71", tokenProvider: { "clerk-session" },
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
  func testStopReportsLateClaimWithoutDispatchAndUsesIndependentHostToken() async throws {
    let next = expectation(description: "Server received a claim request")
    let stopping = expectation(description: "UI reports admission closed")
    let complete = expectation(description: "Late claim was completed")
    let stopped = expectation(description: "Host stopped after completion")
    let claim = PendingClaim()
    let installation = UUID().uuidString.lowercased()
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/hosts/start") {
        XCTAssertEqual(
          connection.request.value(forHTTPHeaderField: "Authorization"), "Bearer clerk-session")
        XCTAssertEqual(connection.request.value(forHTTPHeaderField: "X-Client-Type"), "Desktop")
        XCTAssertEqual(connection.body["installationId"].string, installation)
        connection.reply(
          .object(["hostToken": .string("independent-host-token"), "hostId": .string("host-1")]))
      } else {
        XCTAssertEqual(
          connection.request.value(forHTTPHeaderField: "Authorization"),
          "Bearer independent-host-token")
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
      tokenProvider: { "clerk-session" },
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
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolFixture.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    URLProtocolFixture.boundary.set { connection in
      let path = connection.request.url!.path
      if path.hasSuffix("/hosts/start") {
        connection.reply(
          .object(["hostToken": .string("host-token"), "hostId": .string("host-1")]))
      } else if path.hasSuffix("/next") {
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
      } else if path.hasSuffix("/complete") {
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
      tokenProvider: { "clerk-session" }, onChange: { _ in })
    await runtime.start()
    await fulfillment(of: [reported], timeout: 3)
    await runtime.stop()
  }
}
