import XCTest

@testable import OkouCore

@MainActor
final class HeartbeatDiagnosticsTests: XCTestCase {
  func testLongOutageUploadsFirstAndRecentFailuresWithAnAccurateOmissionCount() throws {
    let collector = try SentryHTTPCollector()
    addTeardownBlock { try await collector.close() }
    var diagnostics = HeartbeatDiagnostics()
    for _ in 1...12 {
      diagnostics.failed(
        error: DesktopFailure("network_error", "private-error-description"),
        requests: [], retryDelay: 60)
    }
    diagnostics.finish(outcome: .recovered)

    let events = try collector.events()
    XCTAssertEqual(events.count, 2)
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
}
