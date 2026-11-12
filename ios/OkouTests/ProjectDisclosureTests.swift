import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ProjectDisclosureTests: XCTestCase {
  func testClicksDuringRestoreWinAndClosePersistsThemForTheReplacementOwner() async throws {
    let fixture = try environment()
    let http = ChatHTTPFixture { _ in throw URLError(.unsupportedURL) }
    let scope = ChatCacheScope(apiBaseURL: http.baseURL, userID: "user", workspaceID: "workspace")
    let key = fixture.legacyKey(
      apiURL: scope.apiBaseURL, userID: scope.userID, workspaceID: scope.workspaceID)
    fixture.defaults.set(["clicked": true, "untouched": true], forKey: key)
    let seed = storage(fixture, scope: scope)
    _ = try await seed.load().value
    await seed.close().value
    let disk = storage(fixture, scope: scope)
    let store = projectStore(http, storage: disk)
    var restoring: Task<Void, Never>?
    try fixture.holdingWriteLock {
      restoring = Task.immediate { await store.restore() }
      store.toggle("clicked")
      store.toggle("clicked")
    }
    await restoring?.value
    XCTAssertFalse(store.isExpanded("clicked"))
    XCTAssertTrue(store.isExpanded("untouched"))
    store.expand("last-click")
    store.close()
    let replacement = projectStore(http, storage: storage(fixture, scope: scope))
    await replacement.restore()
    XCTAssertFalse(replacement.isExpanded("clicked"))
    XCTAssertTrue(replacement.isExpanded("untouched"))
    XCTAssertTrue(replacement.isExpanded("last-click"))
  }

  func testClosingDuringRestoreRejectsOldPublicationAndTheReplacementRestoresItsState() async throws
  {
    let fixture = try environment()
    let http = ChatHTTPFixture { _ in throw URLError(.unsupportedURL) }
    let scope = ChatCacheScope(apiBaseURL: http.baseURL, userID: "user", workspaceID: "workspace")
    let seed = storage(fixture, scope: scope)
    try await seed.setExpanded(true, projectID: "keep").value
    await seed.close().value
    let departing = projectStore(http, storage: storage(fixture, scope: scope))
    let replacement = projectStore(http, storage: storage(fixture, scope: scope))
    var previousRead: Task<Void, Never>?
    var currentRead: Task<Void, Never>?
    try fixture.holdingWriteLock {
      previousRead = Task.immediate { await departing.restore() }
      departing.close()
      currentRead = Task.immediate { await replacement.restore() }
    }
    await previousRead?.value
    await currentRead?.value
    XCTAssertFalse(departing.isExpanded("keep"))
    XCTAssertTrue(replacement.isExpanded("keep"))
  }

  func testReadFailureKeepsPreferencesThenConfirmedListAndDeletionRetireThem() async throws {
    let fixture = try environment()
    let phase = Mutex(0)
    let projectID = "30000000-0000-4000-8000-000000000071"
    let http = ChatHTTPFixture { request in
      if request.httpMethod == "DELETE", request.url?.path == "/api/projects/\(projectID)" {
        phase.withLock { $0 = 2 }
        return ChatHTTPResponse(status: 204, body: "")
      }
      guard request.url?.path == "/api/projects", request.httpMethod == "GET" else {
        throw URLError(.unsupportedURL)
      }
      let current = phase.withLock { $0 }
      if current == 0 { return ChatHTTPResponse(status: 503, body: "{}") }
      let project =
        current == 1
        ? #"{"id":"\#(projectID)","name":"Project","createdAt":"2026-11-09T01:00:00Z","updatedAt":"2026-11-09T01:00:00Z"}"#
        : ""
      return ChatHTTPResponse(body: "{\"projects\":[\(project)]}")
    }
    let scope = ChatCacheScope(apiBaseURL: http.baseURL, userID: "user", workspaceID: "workspace")
    let key = fixture.legacyKey(
      apiURL: scope.apiBaseURL, userID: scope.userID, workspaceID: scope.workspaceID)
    fixture.defaults.set([projectID: true, "removed": true], forKey: key)
    let disk = storage(fixture, scope: scope)
    let store = projectStore(http, storage: disk)
    await store.restore()
    await store.activate()
    let afterFailure = try await disk.load().value
    XCTAssertEqual(afterFailure, [projectID, "removed"])
    phase.withLock { $0 = 1 }
    await store.refresh()
    let confirmed = try await disk.load().value
    XCTAssertEqual(confirmed, [projectID])
    let deleted = await store.delete(projectID)
    XCTAssertTrue(deleted)
    let remaining = try await disk.load().value
    XCTAssertTrue(remaining.isEmpty)
  }

  func testChatCacheRebuildDoesNotResetProjectDisclosure() async throws {
    let fixture = try environment()
    let scope = ChatCacheScope(
      apiBaseURL: URL(string: "https://preferences.invalid")!, userID: "user",
      workspaceID: "workspace")
    let disk = storage(fixture, scope: scope)
    try await disk.setExpanded(true, projectID: "keep").value
    await disk.close().value
    let cacheDirectory = CacheTestDirectory(owner: self)
    let cache = cacheDirectory.cache(scope: scope)
    try await cache.saveProjects([])
    await cache.close()
    let files = try FileManager.default.contentsOfDirectory(
      at: cacheDirectory.url.appending(path: "ChatCache"), includingPropertiesForKeys: nil)
    let database = try XCTUnwrap(files.first { $0.pathExtension == "sqlite" })
    try Data("not a SQLite database".utf8).write(to: database)
    let repaired = cacheDirectory.cache(scope: scope)
    let rebuilt = try await repaired.loadProjects()
    XCTAssertNil(rebuilt)
    let reopened = storage(fixture, scope: scope)
    let retained = try await reopened.load().value
    XCTAssertEqual(retained, ["keep"])
  }

  private func environment() throws -> PreferenceStorageFixture {
    let fixture = try PreferenceStorageFixture()
    addTeardownBlock { @MainActor in try fixture.close() }
    return fixture
  }

  private func storage(_ fixture: PreferenceStorageFixture, scope: ChatCacheScope)
    -> ProjectDisclosureStorage
  {
    let owner = ProjectDisclosureStorage(
      scope: scope, directory: fixture.directory, legacySuiteName: fixture.suiteName)
    addTeardownBlock { await owner.close().value }
    return owner
  }

  private func projectStore(_ http: ChatHTTPFixture, storage: ProjectDisclosureStorage)
    -> ChatProjectStore
  {
    let resources = WorkspaceResources(client: http.client, sleep: { _ in })
    let store = ChatProjectStore(
      client: http.client, resources: resources, sync: ChatSync(client: http.client),
      disclosure: storage, didFail: { _ in }, didChangeMembership: {})
    addTeardownBlock { @MainActor in
      store.close()
      resources.close()
    }
    return store
  }
}
