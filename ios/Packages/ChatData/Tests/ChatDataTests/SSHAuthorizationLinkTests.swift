import ChatData
import XCTest

final class SSHAuthorizationLinkTests: XCTestCase {
  func testSSHReviewLinksRetainTheirExactTrustedDestination() throws {
    let origin = try XCTUnwrap(URL(string: "https://app.example.invalid"))
    let id = UUID().uuidString.lowercased()
    let thread = UUID().uuidString.lowercased()
    let url = "https://app.example.invalid/ssh/authorize/\(id)"
    let action = try XCTUnwrap(
      ChatSSHAuthorizationAction.parse(url, webURL: origin, threadID: thread))
    XCTAssertEqual(action.originalURL.absoluteString, url)
    XCTAssertEqual(action.id, id)
    XCTAssertEqual(action.threadID, thread)
  }

  func testForeignAndDecoratedLinksRemainOrdinaryLinks() throws {
    let origin = try XCTUnwrap(URL(string: "https://app.example.invalid"))
    let path = "/ssh/authorize/\(UUID().uuidString.lowercased())"
    let thread = UUID().uuidString
    for value in [
      "https://foreign.invalid" + path, "http://app.example.invalid" + path,
      "https://app.example.invalid:444" + path, "https://user@app.example.invalid" + path,
      path + "?callbackPrompt=anything", path + "#fragment", path + "/extra",
    ] {
      XCTAssertNil(ChatSSHAuthorizationAction.parse(value, webURL: origin, threadID: thread))
    }
  }
}
