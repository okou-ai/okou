import ChatData
import ChatDataTestSupport
import Foundation
import XCTest

extension ChatHTTPFixture {
  convenience init(
    clientVersion: String = "1.2.3", file: StaticString = #filePath,
    line: UInt = #line, handler: @escaping Handler
  ) {
    self.init(
      clientVersion: clientVersion,
      onUnhandledRequest: { XCTFail($0, file: file, line: line) }, handler: handler)
  }

  var client: APIClient {
    // The returned client owns its HTTP route and session for its complete lifetime.
    APIClient(baseURL: baseURL, clientVersion: clientVersion, session: session) { [self] in
      withExtendedLifetime(self) { "local-test-session" }
    }
  }
}

extension PermissionHTTPFixture {
  convenience init(
    message: String? = nil, initial: State = State(),
    file: StaticString = #filePath, line: UInt = #line,
    beforeRequest: @escaping @Sendable (URLRequest) async -> Void = { _ in }
  ) {
    self.init(
      message: message, initial: initial,
      onUnhandledRequest: { XCTFail($0, file: file, line: line) }, beforeRequest: beforeRequest)
  }
}
