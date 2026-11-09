import XCTest

@testable import OkouCore

private final class HeartbeatClock: @unchecked Sendable {
  private let lock = NSLock()
  private var continuous = ContinuousClock.now
  private var awake = SuspendingClock.now

  func now() -> ContinuousClock.Instant { lock.withLock { continuous } }
  func awakeNow() -> SuspendingClock.Instant { lock.withLock { awake } }
  func advance(_ duration: Duration, awake awakeDuration: Duration) {
    lock.withLock {
      continuous = continuous.advanced(by: duration)
      awake = awake.advanced(by: awakeDuration)
    }
  }
}

@MainActor
final class HostRequestDiagnosticsTests: XCTestCase {
  func testRetriesUploadBoundedCorrelatedHistoryAtInfoLevel() throws {
    let collector = try SentryHTTPCollector()
    addTeardownBlock { try await collector.close() }
    var diagnostics = HostRequestDiagnostics()
    for _ in 1...12 {
      diagnostics.failed(
        error: DesktopFailure("network_error", "private-error-description"),
        requests: [], retryDelay: 60)
    }
    diagnostics.finish(outcome: .recovered)

    let events = try collector.events()
    XCTAssertEqual(events.count, 2)
    XCTAssertEqual(events.compactMap { $0["level"].string }, ["info", "info"])
    let recovered = try XCTUnwrap(
      events.first { $0["tags"]["heartbeatOutcome"].string == "recovered" })
    let summary = recovered["contexts"]["heartbeat"]
    XCTAssertEqual(summary["failedAttempts"].number, 12)
    XCTAssertEqual(summary["firstFailure"]["attempt"].number, 1)
    XCTAssertEqual(
      summary["recentFailures"].array?.compactMap { $0["attempt"].number }, (3...12).map(Double.init))
    XCTAssertEqual(summary["omittedFailures"].number, 1)
    XCTAssertFalse(recovered.formatted.contains("private-error-description"))
  }

  func testAwakeFailureEscalatesOnceAtNinetySecondsAndResetsAfterRecovery() throws {
    let collector = try SentryHTTPCollector()
    addTeardownBlock { try await collector.close() }
    let clock = HeartbeatClock()
    var diagnostics = HostRequestDiagnostics(now: { clock.now() }, awakeNow: { clock.awakeNow() })
    let error = URLError(.networkConnectionLost)
    let operation = APIRequestTraceSnapshot(
      requests: [], authentication: [], phase: .httpRequest, deadline: .authenticatedRequest,
      timing: APIRequestTiming(duration: .seconds(10), awakeDuration: .seconds(10)))
    diagnostics.failed(error: error, requests: [], retryDelay: 2, operation: operation)
    clock.advance(.seconds(79), awake: .seconds(79))
    diagnostics.failed(error: error, requests: [], retryDelay: 60)
    XCTAssertEqual(try collector.events().compactMap { $0["level"].string }, ["info"])

    clock.advance(.seconds(1), awake: .seconds(1))
    diagnostics.failed(error: error, requests: [], retryDelay: 60)
    clock.advance(.seconds(60), awake: .seconds(60))
    diagnostics.failed(error: error, requests: [], retryDelay: 60)
    diagnostics.finish(outcome: .recovered)
    let events = try collector.events()
    XCTAssertEqual(events.count, 3)
    let failure = try XCTUnwrap(events.first { $0["level"].string == "error" })
    XCTAssertEqual(failure["contexts"]["heartbeat"]["failedAttempts"].number, 3)
    XCTAssertEqual(failure["contexts"]["heartbeat"]["awakeElapsedMs"].number, 90_000)
    XCTAssertEqual(Set(events.compactMap { $0["tags"]["heartbeatEpisodeId"].string }).count, 1)

    diagnostics.failed(error: error, requests: [], retryDelay: 2)
    clock.advance(.seconds(90), awake: .seconds(90))
    diagnostics.failed(error: error, requests: [], retryDelay: 60)
    let episodes = try collector.events()
    XCTAssertEqual(episodes.filter { $0["level"].string == "error" }.count, 2)
    XCTAssertEqual(Set(episodes.compactMap { $0["tags"]["heartbeatEpisodeId"].string }).count, 2)
  }

  func testSleepInterruptedFailureAndRecoveryRemainInfo() throws {
    let collector = try SentryHTTPCollector()
    addTeardownBlock { try await collector.close() }
    let clock = HeartbeatClock()
    var diagnostics = HostRequestDiagnostics(now: { clock.now() }, awakeNow: { clock.awakeNow() })
    let operation = APIRequestTraceSnapshot(
      requests: [], authentication: [], phase: .httpRequest, deadline: .authenticatedRequest,
      timing: APIRequestTiming(duration: .seconds(32), awakeDuration: .milliseconds(451)))
    diagnostics.failed(
      error: DesktopFailure("network_error", "private-timeout"), requests: [], retryDelay: 2,
      operation: operation)
    clock.advance(.seconds(3602), awake: .seconds(2))
    diagnostics.finish(outcome: .recovered)

    let events = try collector.events()
    XCTAssertEqual(events.compactMap { $0["level"].string }, ["info", "info"])
    let recovered = try XCTUnwrap(
      events.first { $0["tags"]["heartbeatOutcome"].string == "recovered" })
    let context = recovered["contexts"]["heartbeat"]
    XCTAssertEqual(context["durationMs"].number, 3_634_000)
    XCTAssertEqual(try XCTUnwrap(context["awakeElapsedMs"].number), 2451, accuracy: 0.001)
    XCTAssertEqual(try XCTUnwrap(context["systemSuspendedMs"].number), 3_631_549, accuracy: 0.001)
  }

  func testRecoveryStillReportsAnAwakeOutageThatCrossedTheThresholdBetweenAttempts() throws {
    let collector = try SentryHTTPCollector()
    addTeardownBlock { try await collector.close() }
    let clock = HeartbeatClock()
    var diagnostics = HostRequestDiagnostics(now: { clock.now() }, awakeNow: { clock.awakeNow() })
    diagnostics.failed(error: URLError(.timedOut), requests: [], retryDelay: 60)
    clock.advance(.seconds(91), awake: .seconds(91))
    diagnostics.finish(outcome: .recovered)

    let events = try collector.events()
    XCTAssertEqual(events.count, 3)
    let failure = try XCTUnwrap(events.first { $0["level"].string == "error" })
    XCTAssertEqual(failure["contexts"]["heartbeat"]["awakeElapsedMs"].number, 91_000)
    let recovered = try XCTUnwrap(
      events.first { $0["tags"]["heartbeatOutcome"].string == "recovered" })
    XCTAssertEqual(recovered["level"].string, "info")
    XCTAssertEqual(failure["tags"]["heartbeatEpisodeId"], recovered["tags"]["heartbeatEpisodeId"])
  }

  func testTransientHTTPFailuresAreInfoAndUnexpectedResponsesEscalateImmediately() throws {
    let collector = try SentryHTTPCollector()
    addTeardownBlock { try await collector.close() }
    var diagnostics = HostRequestDiagnostics()
    for status in [500, 503, 400] {
      let response = HTTPURLResponse(
        url: URL(string: "https://api.example.test/heartbeat")!, statusCode: status,
        httpVersion: "HTTP/1.1", headerFields: nil)!
      let request = APIRequestDiagnostic(
        requestId: UUID().uuidString, sessionId: UUID().uuidString, startedAt: Date(),
        timing: APIRequestTiming(duration: .milliseconds(300), awakeDuration: .milliseconds(300)),
        response: response)
      diagnostics.failed(
        error: DesktopFailure("network_error", "private-response"), requests: [request], retryDelay: 2)
    }
    diagnostics.finish(outcome: .recovered)

    let events = try collector.events()
    XCTAssertEqual(events.count, 3)
    let first = try XCTUnwrap(events.first {
      $0["tags"]["heartbeatOutcome"].string == "failed" && $0["level"].string == "info"
    })
    XCTAssertEqual(
      first["contexts"]["heartbeat"]["firstFailure"]["requests"].array?.last?["status"].number, 500)
    let failure = try XCTUnwrap(events.first { $0["level"].string == "error" })
    let recent = failure["contexts"]["heartbeat"]["recentFailures"].array
    XCTAssertEqual(recent?.last?["requests"].array?.last?["status"].number, 400)
    XCTAssertFalse(failure.formatted.contains("private-response"))
  }

  func testUnknownFailuresRemainErrorsEvenWithoutHTTP() throws {
    let collector = try SentryHTTPCollector()
    addTeardownBlock { try await collector.close() }
    var diagnostics = HostRequestDiagnostics()
    diagnostics.failed(
      error: DesktopFailure("invalid_response", "private-decoder-error"), requests: [], retryDelay: 2)
    diagnostics.finish(outcome: .stopped)

    let events = try collector.events()
    XCTAssertEqual(events.count, 2)
    let failure = try XCTUnwrap(events.first { $0["tags"]["heartbeatOutcome"].string == "failed" })
    XCTAssertEqual(failure["level"].string, "error")
    XCTAssertFalse(failure.formatted.contains("private-decoder-error"))
  }
  func testQueueWaitDiagnosticsPreserveTheActualRouteAndCorrelateRecovery() throws {
    let collector = try SentryHTTPCollector()
    addTeardownBlock { try await collector.close() }
    var diagnostics = HostRequestDiagnostics(request: .queueWait)
    diagnostics.failed(error: URLError(.networkConnectionLost), requests: [], retryDelay: 2)
    diagnostics.finish(outcome: .recovered)
    let events = try collector.events()
    XCTAssertEqual(events.count, 2)
    let recovered = try XCTUnwrap(events.first { $0["tags"]["hostRequestOutcome"].string == "recovered" })
    XCTAssertEqual(recovered["contexts"]["hostRequest"]["pathTemplate"].string,
      "/api/computer-use/hosts/:hostId/commands/wait")
    XCTAssertEqual(Set(events.compactMap { $0["tags"]["hostRequestEpisodeId"].string }).count, 1)
  }

}
