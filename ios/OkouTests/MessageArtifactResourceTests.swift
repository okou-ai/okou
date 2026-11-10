import CCState
import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import UIKit
import XCTest

@testable import Okou

@MainActor
final class MessageArtifactResourceTests: XCTestCase {
  func testConcurrentCardsShareTheirCoverAndCancellingOneWaiterKeepsTheOtherAlive() async throws {
    let entered = expectation(description: "Shared cover authorization started")
    let (gate, release) = AsyncStream<Void>.makeStream()
    let fixture = try await ArtifactReadFixture.make(
      owner: self,
      beforeResolve: { _ in
        entered.fulfill()
        for await _ in gate { break }
      })
    let artifact = fixture.artifact()
    let first = Task { try await fixture.viewer.card(artifact, thumbnail: true) }
    let second = Task { try await fixture.viewer.card(artifact, thumbnail: true) }
    addTeardownBlock {
      release.finish()
      first.cancel()
      second.cancel()
      _ = await first.result
      _ = await second.result
    }
    await fulfillment(of: [entered], timeout: 3)
    first.cancel()
    release.finish()

    let cancelled = await first.result
    XCTAssertThrowsError(try cancelled.get()) { XCTAssertTrue($0 is CancellationError) }
    let card = try await second.value
    XCTAssertNotNil(card.thumbnail.flatMap(UIImage.init(data:)))
    let remounted = try await fixture.viewer.card(artifact, thumbnail: true)
    XCTAssertEqual(remounted.thumbnail, card.thumbnail)
    XCTAssertEqual(fixture.state.value.withLock { $0.references.count }, 1)
    XCTAssertEqual(fixture.state.value.withLock { $0.transfers }, 1)
    XCTAssertEqual(fixture.state.value.withLock { $0.catalogs }, 1)

    fixture.viewer.open(card.artifact, thumbnail: card.thumbnail)
    XCTAssertEqual(fixture.viewer.preview?.thumbnail, card.thumbnail)
    fixture.viewer.dismiss()
  }

  func testPreviewWaiterCancellationDoesNotCancelTheOriginalRead() async throws {
    let entered = expectation(description: "Preview authorization started")
    let (gate, release) = AsyncStream<Void>.makeStream()
    let fixture = try await ArtifactReadFixture.make(
      owner: self,
      beforeResolve: { _ in
        entered.fulfill()
        for await _ in gate { break }
      })
    fixture.viewer.open(fixture.artifact())
    let preview = try XCTUnwrap(fixture.viewer.preview)
    let original = try preview.store.get(preview.content)
    let waiter = Task { try await original.value }
    addTeardownBlock {
      release.finish()
      waiter.cancel()
      _ = await waiter.result
    }
    await fulfillment(of: [entered], timeout: 3)
    waiter.cancel()
    release.finish()
    let content = try await original.value
    let file = try XCTUnwrap(content.file)
    XCTAssertNotNil(UIImage(data: try Data(contentsOf: file.url)))
    _ = await waiter.result
    let remounted = try await preview.store.get(preview.content).value
    XCTAssertEqual(remounted.file?.url, file.url)
  }

  func testRetiringPreviewCancelsOriginalPreviewAndShareAuthorization() async throws {
    for download in [false, true] {
      for retirement in ["replace", "dismiss", "deactivate", "close"] {
        let entered = expectation(description: "Original authorization started")
        let cancelled = expectation(description: "Original HTTP was cancelled")
        let (gate, release) = AsyncStream<Void>.makeStream()
        let blocks = Mutex(!download)
        let fixture = try await ArtifactReadFixture.make(
          owner: self, contentType: "text/html",
          beforeResolve: { _ in
            if blocks.withLock({ $0 }) {
              await withTaskCancellationHandler {
                entered.fulfill()
                for await _ in gate { break }
              } onCancel: {
                cancelled.fulfill()
              }
            }
          })
        fixture.viewer.open(fixture.artifact())
        let preview = try XCTUnwrap(fixture.viewer.preview)
        let content = try preview.store.get(preview.content)
        if download {
          _ = try await content.value
          blocks.withLock { $0 = true }
          fixture.viewer.downloadForSharing()
        }
        let pending =
          download
          ? Task { _ = try await preview.store.get(preview.download).value }
          : Task { _ = try await content.value }
        addTeardownBlock {
          release.finish()
          pending.cancel()
          _ = await pending.result
        }
        await fulfillment(of: [entered], timeout: 3)
        blocks.withLock { $0 = false }
        switch retirement {
        case "replace": fixture.viewer.open(fixture.artifact("image00002.png"))
        case "dismiss": fixture.viewer.dismiss()
        case "deactivate": fixture.viewer.deactivate()
        default: fixture.viewer.close()
        }
        await fulfillment(of: [cancelled], timeout: 3)
        release.finish()
        let result = await pending.result
        XCTAssertThrowsError(try result.get(), "\(retirement), download=\(download)")
        XCTAssertThrowsError(try preview.store.get(preview.content))
        XCTAssertThrowsError(try preview.store.get(preview.download))
        XCTAssertThrowsError(try preview.downloadForSharing())
        XCTAssertNil(fixture.viewer.sharing)
        if retirement != "close" {
          if retirement != "replace" { fixture.viewer.open(fixture.artifact()) }
          let current = try XCTUnwrap(fixture.viewer.preview)
          let reopened = try await current.store.get(current.content).value
          XCTAssertNotNil(reopened.contentURL)
        } else {
          fixture.viewer.open(fixture.artifact())
          XCTAssertNil(fixture.viewer.preview)
        }
      }
    }
  }

  func testShareRetryIsIndependentOfTheSuccessfulHTMLPreview() async throws {
    let fixture = try await ArtifactReadFixture.make(owner: self, contentType: "text/html")
    fixture.viewer.open(fixture.artifact())
    let preview = try XCTUnwrap(fixture.viewer.preview)
    let content = try await preview.store.get(preview.content).value
    let url = try XCTUnwrap(content.contentURL)
    fixture.state.value.withLock { $0.statuses["image00001.png"] = [503] }
    fixture.viewer.downloadForSharing()
    let failed = await (try preview.store.get(preview.download)).result
    XCTAssertThrowsError(try failed.get()) { error in
      XCTAssertEqual((error as? APIClientError)?.statusCode, 503)
    }
    fixture.viewer.downloadForSharing()
    let downloaded = try await preview.store.get(preview.download).value
    let file = try XCTUnwrap(downloaded)
    XCTAssertNotNil(UIImage(data: try Data(contentsOf: file.url)))
    let retained = try await preview.store.get(preview.content).value
    XCTAssertEqual(retained.contentURL, url)
  }

  func testMarkdownImageGroupSurvivesExplicitPreviewRetry() async throws {
    let fixture = try await ArtifactReadFixture.make(owner: self)
    let markup = "![First](/artifacts/image00001.png)\n\n![Second](/artifacts/image00002.png)"
    fixture.viewer.open(fixture.artifact(), imageSources: [markup])
    fixture.viewer.retry()
    let preview = try XCTUnwrap(fixture.viewer.preview)
    let content = try await preview.store.get(preview.content).value
    XCTAssertTrue(fixture.viewer.canNavigateImage(1, resolution: content.resolution))
    fixture.viewer.navigateImage(1, resolution: content.resolution)
    let next = try XCTUnwrap(fixture.viewer.preview)
    let nextContent = try await next.store.get(next.content).value
    XCTAssertEqual(nextContent.artifact.id, fixture.artifact("image00002.png").id)
    XCTAssertTrue(fixture.viewer.canNavigateImage(-1, resolution: nextContent.resolution))
  }

  func testImageDownloadFailureKeepsCrossMessagePagingAvailable() async throws {
    let fixture = try await ArtifactReadFixture.make(owner: self)
    fixture.state.value.withLock { $0.transferStatus = 404 }
    fixture.viewer.open(
      fixture.artifact(),
      imageSources: ["![First](/artifacts/image00001.png)", "![Second](/artifacts/image00002.png)"])
    let preview = try XCTUnwrap(fixture.viewer.preview)
    let failed = await (try preview.store.get(preview.content)).result
    XCTAssertThrowsError(try failed.get()) { error in
      XCTAssertEqual(MessageArtifactStore.cardStatus(for: error), "No longer available")
    }
    let resolution = try await preview.store.get(preview.resolution).value
    XCTAssertTrue(fixture.viewer.canNavigateImage(1, resolution: resolution))
    fixture.state.value.withLock { $0.transferStatus = 200 }
    fixture.viewer.navigateImage(1, resolution: resolution)
    let next = try XCTUnwrap(fixture.viewer.preview)
    let content = try await next.store.get(next.content).value
    XCTAssertEqual(content.artifact.id, fixture.artifact("image00002.png").id)
    let file = try XCTUnwrap(content.file)
    XCTAssertNotNil(UIImage(data: try Data(contentsOf: file.url)))
    XCTAssertTrue(fixture.viewer.canNavigateImage(-1, resolution: content.resolution))
  }

  func testFailedCardStaysFailedUntilItsOwnRetryWithoutReloadingOtherCards() async throws {
    let fixture = try await ArtifactReadFixture.make(owner: self)
    let artifact = fixture.artifact()
    fixture.state.value.withLock { $0.statuses["image00001.png"] = [503] }
    let failed = await Task { try await fixture.viewer.card(artifact, thumbnail: true) }.result
    XCTAssertThrowsError(try failed.get()) { error in
      XCTAssertEqual((error as? APIClientError)?.statusCode, 503)
    }
    let repeated = await Task { try await fixture.viewer.card(artifact, thumbnail: true) }.result
    XCTAssertThrowsError(try repeated.get()) { error in
      XCTAssertEqual((error as? APIClientError)?.statusCode, 503)
    }
    let other = fixture.artifact("image00002.png")
    let available = try await fixture.viewer.card(other, thumbnail: true)
    XCTAssertNotNil(available.thumbnail)
    fixture.viewer.reads.retry(fixture.viewer.reads.card(artifact, thumbnail: true))
    let recovered = try await fixture.viewer.card(artifact, thumbnail: true)
    XCTAssertNotNil(recovered.thumbnail)
    _ = try await fixture.viewer.card(other, thumbnail: true)
    XCTAssertEqual(
      fixture.state.value.withLock { $0.references.filter { $0 == "image00001.png" }.count }, 2)
    XCTAssertEqual(
      fixture.state.value.withLock { $0.references.filter { $0 == "image00002.png" }.count }, 1)
    XCTAssertEqual(fixture.state.value.withLock { $0.catalogs }, 1)
  }

  func testMetadataOnlyReadCannotSatisfyACoverRequest() async throws {
    let fixture = try await ArtifactReadFixture.make(owner: self)
    let artifact = fixture.artifact()
    let header = try await fixture.viewer.card(artifact, thumbnail: false)
    XCTAssertEqual(header.artifact.filename, "From catalog.png")
    XCTAssertNil(header.thumbnail)
    let cover = try await fixture.viewer.card(artifact, thumbnail: true)
    XCTAssertNotNil(cover.thumbnail.flatMap(UIImage.init(data:)))
    XCTAssertEqual(fixture.state.value.withLock { $0.catalogs }, 1)
    XCTAssertEqual(fixture.state.value.withLock { $0.transfers }, 1)
  }

  func testSupplementaryMetadataFailureCannotBypassContentAuthorization() async throws {
    let fixture = try await ArtifactReadFixture.make(owner: self)
    fixture.state.value.withLock {
      $0.catalogStatus = 503
      $0.statuses["image00001.png"] = [403]
    }
    let artifact = fixture.artifact()
    let rejected = await Task { try await fixture.viewer.card(artifact, thumbnail: true) }.result
    XCTAssertThrowsError(try rejected.get()) { error in
      XCTAssertEqual((error as? APIClientError)?.statusCode, 403)
    }
    XCTAssertEqual(fixture.state.value.withLock { $0.transfers }, 0)

    fixture.viewer.reads.retry(fixture.viewer.reads.card(artifact, thumbnail: true))
    let authorized = try await fixture.viewer.card(artifact, thumbnail: true)
    XCTAssertNotNil(authorized.thumbnail)
    let catalog = await (try fixture.viewer.reads.store.get(fixture.viewer.reads.catalog)).result
    XCTAssertThrowsError(try catalog.get()) { error in
      XCTAssertEqual((error as? APIClientError)?.statusCode, 503)
    }
    XCTAssertEqual(fixture.state.value.withLock { $0.catalogs }, 1)
    XCTAssertEqual(fixture.state.value.withLock { $0.references.count }, 2)
  }

  func testMetadataRefreshKeepsTheExistingCoverAndDownloadedPreviewFile() async throws {
    let fixture = try await ArtifactReadFixture.make(owner: self)
    let artifact = fixture.artifact()
    let card = try await fixture.viewer.card(artifact, thumbnail: true)
    fixture.viewer.open(card.artifact, thumbnail: card.thumbnail)
    let preview = try XCTUnwrap(fixture.viewer.preview)
    let content = try await preview.store.get(preview.content).value
    let originalFile = try XCTUnwrap(content.file)
    let references = fixture.state.value.withLock { $0.references }
    let transfers = fixture.state.value.withLock { $0.transfers }

    fixture.state.value.withLock { $0.name = "Updated details.png" }
    fixture.viewer.refreshDetails()
    _ = try await fixture.viewer.reads.store.get(fixture.viewer.reads.catalog).value
    let retained = try await preview.store.get(preview.content).value
    XCTAssertEqual(fixture.viewer.reads.metadata(retained.artifact).filename, "Updated details.png")
    XCTAssertEqual(retained.file?.url, originalFile.url)
    let existing = try await fixture.viewer.card(artifact, thumbnail: true)
    XCTAssertEqual(existing.thumbnail, card.thumbnail)
    XCTAssertEqual(fixture.state.value.withLock { $0.references }, references)
    XCTAssertEqual(fixture.state.value.withLock { $0.transfers }, transfers)
    XCTAssertEqual(fixture.state.value.withLock { $0.catalogs }, 2)
  }

  func testDeactivationCancelsTheOriginalCardAndReentryUsesFreshMetadata() async throws {
    let entered = expectation(description: "Old card authorization started")
    let cancelled = expectation(description: "Original authorization was cancelled")
    let (gate, release) = AsyncStream<Void>.makeStream()
    let first = Mutex(true)
    let fixture = try await ArtifactReadFixture.make(
      owner: self,
      beforeResolve: { _ in
        let holds = first.withLock { value in
          let old = value
          value = false
          return old
        }
        if holds {
          await withTaskCancellationHandler {
            entered.fulfill()
            for await _ in gate { break }
          } onCancel: {
            cancelled.fulfill()
          }
        }
      })
    let artifact = fixture.artifact()
    let old = Task { try await fixture.viewer.card(artifact, thumbnail: true) }
    addTeardownBlock {
      release.finish()
      old.cancel()
      _ = await old.result
    }
    await fulfillment(of: [entered], timeout: 3)
    fixture.viewer.deactivate()
    await fulfillment(of: [cancelled], timeout: 3)
    release.finish()
    let retired = await old.result
    XCTAssertThrowsError(try retired.get())

    fixture.state.value.withLock { $0.name = "New visit.png" }
    let current = try await fixture.viewer.card(artifact, thumbnail: true)
    XCTAssertEqual(current.artifact.filename, "New visit.png")
    XCTAssertNotNil(current.thumbnail)
    XCTAssertEqual(fixture.state.value.withLock { $0.catalogs }, 2)
  }

  func testClosingCancelsTheOriginalMetadataReadBeforeAnyContentAccess() async throws {
    let entered = expectation(description: "Metadata HTTP started")
    let cancelled = expectation(description: "Original metadata HTTP was cancelled")
    let (gate, release) = AsyncStream<Void>.makeStream()
    let fixture = try await ArtifactReadFixture.make(
      owner: self,
      beforeCatalog: {
        await withTaskCancellationHandler {
          entered.fulfill()
          for await _ in gate { break }
        } onCancel: {
          cancelled.fulfill()
        }
      })
    let pending = Task { try await fixture.viewer.card(fixture.artifact(), thumbnail: true) }
    addTeardownBlock {
      release.finish()
      pending.cancel()
      _ = await pending.result
    }
    await fulfillment(of: [entered], timeout: 3)
    fixture.viewer.close()
    await fulfillment(of: [cancelled], timeout: 3)
    release.finish()
    let result = await pending.result
    XCTAssertThrowsError(try result.get())
    XCTAssertEqual(fixture.state.value.withLock { $0.references }, [])
    XCTAssertEqual(fixture.state.value.withLock { $0.transfers }, 0)
  }

  func testCoverWaitingForMetadataFollowsAnExplicitRefresh() async throws {
    let entered = expectation(description: "Initial metadata read started")
    let cancelled = expectation(description: "Superseded metadata read was cancelled")
    let (gate, release) = AsyncStream<Void>.makeStream()
    let first = Mutex(true)
    let fixture = try await ArtifactReadFixture.make(
      owner: self,
      beforeCatalog: {
        let holds = first.withLock { value in
          let old = value
          value = false
          return old
        }
        if holds {
          await withTaskCancellationHandler {
            entered.fulfill()
            for await _ in gate { break }
          } onCancel: {
            cancelled.fulfill()
          }
        }
      })
    let pending = Task { try await fixture.viewer.card(fixture.artifact(), thumbnail: true) }
    addTeardownBlock {
      release.finish()
      pending.cancel()
      _ = await pending.result
    }
    await fulfillment(of: [entered], timeout: 3)
    fixture.state.value.withLock { $0.name = "Refreshed metadata.png" }
    try fixture.viewer.reads.refreshCatalog()
    await fulfillment(of: [cancelled], timeout: 3)
    release.finish()
    let card = try await pending.value
    XCTAssertEqual(card.artifact.filename, "Refreshed metadata.png")
    XCTAssertNotNil(card.thumbnail)
    XCTAssertEqual(fixture.state.value.withLock { $0.catalogs }, 2)
    XCTAssertEqual(fixture.state.value.withLock { $0.references.count }, 1)
  }

  func testAuthenticationAndUpgradeMetadataFailuresStopCardAccess() async throws {
    for status in [401, 426] {
      let reports = Mutex<[Int]>([])
      let fixture = try await ArtifactReadFixture.make(
        owner: self,
        didFail: { error in
          reports.withLock { $0.append((error as? APIClientError)?.statusCode ?? 0) }
        })
      fixture.state.value.withLock { $0.catalogStatus = status }
      let result = await Task {
        try await fixture.viewer.card(fixture.artifact(), thumbnail: true)
      }.result
      XCTAssertThrowsError(try result.get()) { error in
        XCTAssertEqual((error as? APIClientError)?.statusCode, status)
      }
      XCTAssertEqual(reports.withLock { $0 }, [status])
      XCTAssertEqual(fixture.state.value.withLock { $0.references }, [])
      XCTAssertEqual(fixture.state.value.withLock { $0.transfers }, 0)
    }
  }

  func testOptionalDocumentCoverCannotSwallowAForceUpgradeResponse() async throws {
    let reports = Mutex<[Int]>([])
    let fixture = try await ArtifactReadFixture.make(
      owner: self, contentType: "application/pdf",
      didFail: { error in
        reports.withLock { $0.append((error as? APIClientError)?.statusCode ?? 0) }
      })
    fixture.state.value.withLock { $0.statuses["image00001.png"] = [200, 426] }
    let result = await Task {
      try await fixture.viewer.card(fixture.artifact(), thumbnail: true)
    }.result
    XCTAssertThrowsError(try result.get()) { error in
      XCTAssertEqual((error as? APIClientError)?.statusCode, 426)
    }
    XCTAssertEqual(reports.withLock { $0 }, [426])
    XCTAssertEqual(fixture.state.value.withLock { $0.transfers }, 0)
  }
}

@MainActor
private struct ArtifactReadFixture {

  let viewer: MessageArtifactStore
  let state: ArtifactReadState
  let contentType: String

  func artifact(_ id: String = "image00001.png") -> ChatArtifact {
    ChatArtifact(
      source: .reference(id, fragment: ""), filename: "Message.png", contentType: contentType)
  }

  static func make(
    owner: XCTestCase, contentType: String = "image/png",
    beforeCatalog: @escaping @Sendable () async -> Void = {},
    beforeResolve: @escaping @Sendable (URLRequest) async -> Void = { _ in },
    didFail: @escaping @MainActor (Error) -> Void = {
      XCTFail("Unexpected workspace failure: \($0)")
    }
  ) async throws -> ArtifactReadFixture {
    let state = ArtifactReadState()
    let bytes = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).pngData { context in
      UIColor.systemIndigo.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
    }
    let server = try ChatFileHTTPServer { _ in
      state.value.withLock { $0.transfers += 1 }
      let status = state.value.withLock { $0.transferStatus }
      return .init(status: status, headers: ["Content-Type": "image/png"], body: bytes)
    }
    owner.addTeardownBlock { await server.stop() }
    let origin = try await server.start()
    let http = ChatHTTPFixture { request in
      if request.url?.path == "/api/chat-threads/thread/artifacts" {
        let (status, name) = state.value.withLock { value in
          value.catalogs += 1
          return (value.catalogStatus, value.name)
        }
        await beforeCatalog()
        if status != 200 { return failure(status) }
        return ChatHTTPResponse(
          body: """
            {"runs":[{"runId":"run","files":[{"id":"image00001.png","url":"/artifacts/image00001.png","filename":"\(name)","contentType":"\(contentType)","size":100,"createdAt":"2026-11-09T00:00:00Z"}]}]}
            """)
      }
      guard request.url?.path.hasPrefix("/api/artifact-references/") == true,
        let id = request.url?.lastPathComponent
      else { throw URLError(.unsupportedURL) }
      let (status, name) = state.value.withLock { value in
        value.references.append(id)
        var statuses = value.statuses[id] ?? []
        let status = statuses.isEmpty ? 200 : statuses.removeFirst()
        value.statuses[id] = statuses
        return (status, value.name)
      }
      await beforeResolve(request)
      if status != 200 { return failure(status) }
      return ChatHTTPResponse(
        body: """
          {"url":"\(origin)/image","downloadUrl":"\(origin)/image","filename":"\(name)","contentType":"\(contentType)"}
          """)
    }
    let commands = ChatCommands(client: http.client, sync: ChatSync(client: http.client))
    let viewer = MessageArtifactStore(
      service: commands.artifacts, threadID: "thread", webURL: http.baseURL,
      markdown: MessageMarkdownCache(baseURL: http.baseURL), didFail: didFail)
    owner.addTeardownBlock { @MainActor in
      viewer.close()
      commands.artifacts.closeFileCache()
      http.session.invalidateAndCancel()
    }
    return ArtifactReadFixture(viewer: viewer, state: state, contentType: contentType)
  }

  private nonisolated static func failure(_ status: Int) -> ChatHTTPResponse {
    ChatHTTPResponse(status: status, body: "{\"error\":{\"message\":\"Fixture rejection\"}}")
  }
}

private final class ArtifactReadState: Sendable {
  struct Value: Sendable {
    var name = "From catalog.png"
    var catalogStatus = 200
    var transferStatus = 200
    var statuses: [String: [Int]] = [:]
    var catalogs = 0
    var references: [String] = []
    var transfers = 0
  }
  let value = Mutex(Value())
}
