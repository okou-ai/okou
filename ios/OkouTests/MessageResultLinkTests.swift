import ChatData
import ChatDomain
import Foundation
import XCTest

@testable import Okou

final class MessageResultLinkTests: XCTestCase {
  private let webURL = URL(string: "https://app.okou.ai")!
  private let apiURL = URL(string: "https://api.okou.ai")!

  private func resolve(_ value: String) -> ChatArtifact? {
    ChatArtifactReference.parse(value, webURL: webURL, apiURL: apiURL)
  }

  func testALinkedSiteBecomesOneResultWithItsOwnText() throws {
    let content = try AttributedString(
      markdown: "See [the deck](https://deck.okou.app/) and again [here](https://deck.okou.app/).")
    let links = MessageArtifactBody.links(content, resolve: resolve)
    XCTAssertEqual(links.map(\.label), ["the deck"])
    XCTAssertEqual(links.first?.resource.kind, .html)
  }

  func testOrdinaryLinksStayText() throws {
    let content = try AttributedString(markdown: "Read [the docs](https://developer.apple.com/).")
    XCTAssertTrue(MessageArtifactBody.links(content, resolve: resolve).isEmpty)
  }

  func testEmphasizedAutolinkOpensThePageAndReadsBold() throws {
    let content = try AttributedString(
      markdown: "Pages: **https://okou-404-options.sites.vm0.io/**（A / B / C）"
    ).repairingEmphasizedAutolinks()
    XCTAssertEqual(
      String(content.characters), "Pages: https://okou-404-options.sites.vm0.io/（A / B / C）")
    let link = try XCTUnwrap(content.runs.first(where: { $0.link != nil }))
    XCTAssertEqual(link.link?.absoluteString, "https://okou-404-options.sites.vm0.io/")
    XCTAssertEqual(link.inlinePresentationIntent?.contains(.stronglyEmphasized), true)
    XCTAssertEqual(MessageArtifactBody.links(content, resolve: resolve).count, 1)
  }

  func testBareAddressEndsBeforeTheChineseThatFollowsIt() throws {
    let content = try AttributedString(markdown: "打开 https://deck.okou.app/，然后看第二页")
      .repairingEmphasizedAutolinks()
    XCTAssertEqual(String(content.characters), "打开 https://deck.okou.app/，然后看第二页")
    let links = content.runs.compactMap(\.link)
    XCTAssertEqual(links.map(\.absoluteString), ["https://deck.okou.app/"])
  }

  @MainActor
  func testAGoneResultSaysSoInAFewWordsAndAPassingFailureDoesNot() {
    XCTAssertEqual(
      MessageArtifactStore.cardStatus(for: APIClientError.http(status: 404, message: "")),
      "No longer available")
    XCTAssertEqual(
      MessageArtifactStore.cardStatus(for: APIClientError.downloadFailed(status: 410)),
      "No longer available")
    XCTAssertEqual(
      MessageArtifactStore.cardStatus(for: APIClientError.http(status: 403, message: "")),
      "No access")
    XCTAssertNil(MessageArtifactStore.cardStatus(for: URLError(.notConnectedToInternet)))
    XCTAssertNil(
      MessageArtifactStore.cardStatus(for: APIClientError.http(status: 503, message: "")))
  }

  func testAutolinkWithoutEmphasisIsUntouched() throws {
    let content = try AttributedString(markdown: "Open https://okou-404-options.sites.vm0.io/ now.")
    XCTAssertEqual(content.repairingEmphasizedAutolinks(), content)
  }
}
