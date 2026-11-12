import Foundation
import XCTest

@testable import OkouCore

/// Only the initial cached token may reach HTTP before the forced-refresh tests cancel.
private final class CachedTokenProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}
  override func startLoading() {
    guard request.value(forHTTPHeaderField: "Authorization") == "Bearer cached-session" else {
      XCTFail("A late token must not submit an authenticated request after cancellation")
      client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
      return
    }
    let response = HTTPURLResponse(
      url: request.url!, statusCode: 401, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data("{}".utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
}

private actor TokenResponseGate {
  private var continuation: CheckedContinuation<String, Error>?

  func read(ready: XCTestExpectation) async throws -> String {
    try await withCheckedThrowingContinuation {
      continuation = $0
      ready.fulfill()
    }
  }

  func finish(_ result: Result<String, Error>) {
    continuation?.resume(with: result)
    continuation = nil
  }
}

private final class PendingHTTPProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {}
  override func stopLoading() {}
}

final class APIClientTokenWaitTests: XCTestCase, @unchecked Sendable {
  func testLookupDeadlineReturnsBeforeSharedTokenFailure() async {
    await assertCancelledTokenWait(refresh: false, callerCancels: false, tokenFails: true)
  }

  func testRefreshDeadlineReturnsBeforeSharedTokenSuccess() async {
    await assertCancelledTokenWait(refresh: true, callerCancels: false, tokenFails: false)
  }

  func testLookupDeadlineIsAttributedWithoutDiagnostics() async {
    await assertCancelledTokenWait(
      refresh: false, callerCancels: false, tokenFails: false, diagnostics: false)
  }

  func testRefreshDeadlineIsAttributedWithoutDiagnostics() async {
    await assertCancelledTokenWait(
      refresh: true, callerCancels: false, tokenFails: true, diagnostics: false)
  }

  func testHTTPDeadlineIsAttributedWithoutDiagnostics() async {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PendingHTTPProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let api = APIClient(
      baseURL: URL(string: "https://api.example.test")!, version: "0.56.3", session: session)
    do {
      _ = try await api.authenticatedRequest(
        ApiRoutes.computerUseHostCommandNext(hostId: "host"), timeout: 0.15,
        tokenProvider: { _ in "session" })
      XCTFail("The pending HTTP request must expire")
    } catch {
      XCTAssertEqual((error as? DesktopFailure)?.code, "network_error")
      XCTAssertEqual(error.localizedDescription,
        "Desktop API request timed out (POST /api/computer-use/hosts/host/commands/next)")
    }
  }

  func testCallerCancellationReturnsBeforeSharedTokenSuccess() async {
    await assertCancelledTokenWait(refresh: false, callerCancels: true, tokenFails: false)
  }

  func testRefreshCallerCancellationReturnsBeforeSharedTokenFailure() async {
    await assertCancelledTokenWait(refresh: true, callerCancels: true, tokenFails: true)
  }

  private func assertCancelledTokenWait(
    refresh: Bool, callerCancels: Bool, tokenFails: Bool, diagnostics: Bool = true
  ) async
  {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CachedTokenProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let api = APIClient(
      baseURL: URL(string: "https://api.example.test")!, version: "0.55.6", session: session)
    let trace = APIRequestTrace()
    let gate = TokenResponseGate()
    let sdkReady = expectation(description: "The SDK owns a shared token request")
    let waiting = expectation(description: "The API is waiting for that token")
    let returned = expectation(
      description: "The API returns while the shared token remains pending")
    let providerFinished = expectation(description: "The cancelled provider drains its late result")

    // Clerk's ordinary token lookup shares an unstructured task. Cancelling one
    // token caller must not cancel the underlying task for its other consumers.
    let sdkTask = Task {
      let result: Result<String, Error>
      do { result = .success(try await gate.read(ready: sdkReady)) } catch {
        result = .failure(error)
      }
      try Task.checkCancellation()
      return try result.get()
    }
    let call = Task {
      do {
        _ = try await api.authenticatedRequest(
          ApiRoutes.computerUseHostHeartbeat(hostId: "host"), body: .object([:]),
          timeout: callerCancels ? 30 : 1, trace: diagnostics ? trace : nil,
          tokenProvider: { force in
            if refresh && !force { return "cached-session" }
            waiting.fulfill()
            defer { providerFinished.fulfill() }
            return try await sdkTask.value
          })
        XCTFail("The API must stop waiting for the token")
      } catch {
        if callerCancels {
          XCTAssertTrue(error is CancellationError)
        } else {
          XCTAssertEqual((error as? DesktopFailure)?.code, "network_error")
          let operation = refresh ? "refresh" : "lookup"
          XCTAssertEqual(error.localizedDescription,
            "Desktop session token \(operation) timed out (POST /api/computer-use/hosts/host/heartbeat)")
        }
      }
      returned.fulfill()
    }
    await fulfillment(of: [sdkReady, waiting], timeout: 1)
    if callerCancels { call.cancel() }
    await fulfillment(of: [returned], timeout: 2)
    let before = await trace.snapshot()
    if diagnostics {
      XCTAssertEqual(before.phase, refresh ? .tokenRefresh : .tokenLookup)
      XCTAssertEqual(before.deadline, callerCancels ? nil : .authenticatedRequest)
      XCTAssertEqual(before.requests.map(\.status), refresh ? [401] : [])
      XCTAssertEqual(before.authentication.last?.errorType, "CancellationError")
    }

    // An independent consumer still observes the SDK's actual result. Release
    // and await every owned task even when an earlier assertion failed.
    await gate.finish(
      tokenFails ? .failure(URLError(.secureConnectionFailed)) : .success("late-session"))
    let sharedResult = await sdkTask.result
    switch sharedResult {
    case .success(let token):
      XCTAssertFalse(tokenFails)
      XCTAssertEqual(token, "late-session")
    case .failure(let error):
      XCTAssertTrue(tokenFails)
      XCTAssertEqual((error as? URLError)?.code, .secureConnectionFailed)
    }
    await call.value
    await fulfillment(of: [providerFinished], timeout: 1)
    let after = await trace.snapshot()
    XCTAssertEqual(after.authentication.count, before.authentication.count)
    XCTAssertEqual(after.authentication.last?.errorType, before.authentication.last?.errorType)
    XCTAssertEqual(after.timing?.duration, before.timing?.duration)
    XCTAssertEqual(after.requests.count, before.requests.count)
  }

  func testTokenFailureBeforeDeadlinePreservesTransportError() async {
    let api = APIClient(baseURL: URL(string: "https://api.example.test")!, version: "0.55.6")
    let trace = APIRequestTrace()
    do {
      _ = try await api.authenticatedRequest(
        ApiRoutes.computerUseHostHeartbeat(hostId: "host"), timeout: 30, trace: trace,
        tokenProvider: { _ in throw URLError(.secureConnectionFailed) })
      XCTFail("The SDK error must reach the caller")
    } catch {
      XCTAssertEqual((error as? URLError)?.code, .secureConnectionFailed)
    }
    let snapshot = await trace.snapshot()
    XCTAssertNil(snapshot.deadline)
    XCTAssertEqual(snapshot.authentication.first?.urlErrorCode, -1200)
  }
}
