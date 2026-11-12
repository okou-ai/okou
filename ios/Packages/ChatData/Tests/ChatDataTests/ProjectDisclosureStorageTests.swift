import ChatData
import ChatDataTestSupport
import Foundation
import XCTest

@MainActor
final class ProjectDisclosureStorageTests: XCTestCase {
  func testLegacyImportCommitsBeforeRemovalAndCannotResurrectCollapsedProjects() async throws {
    let fixture = try environment()
    let scope = scope()
    let key = fixture.legacyKey(
      apiURL: scope.apiBaseURL, userID: scope.userID, workspaceID: scope.workspaceID)
    fixture.defaults.set(["expanded": true, "collapsed": false], forKey: key)
    fixture.defaults.set(["foreign": true], forKey: key + "-other-workspace")
    let first = storage(fixture, scope: scope)
    let imported = try await first.load().value
    XCTAssertEqual(imported, ["expanded"])
    XCTAssertNil(fixture.defaults.object(forKey: key))
    XCTAssertNotNil(fixture.defaults.object(forKey: key + "-other-workspace"))
    try await first.setExpanded(false, projectID: "expanded").value
    await first.close().value
    // Simulate termination after commit but before defaults deletion, or an old
    // client writing its retired format. The marker protects the newer empty set.
    fixture.defaults.set(["expanded": true], forKey: key)
    let reopened = storage(fixture, scope: scope)
    let retained = try await reopened.load().value
    XCTAssertTrue(retained.isEmpty)
    XCTAssertNil(fixture.defaults.object(forKey: key))
  }

  func testOriginUserAndWorkspaceAreIndependentScopes() async throws {
    let fixture = try environment()
    let first = storage(fixture, scope: scope())
    try await first.setExpanded(true, projectID: "mine").value
    let scopes = [
      scope(origin: "https://other.invalid"), scope(user: "other-user"),
      scope(workspace: "other-workspace"),
    ]
    for scope in scopes {
      let other = storage(fixture, scope: scope)
      let empty = try await other.load().value
      XCTAssertTrue(empty.isEmpty)
      try await other.setExpanded(true, projectID: "theirs").value
    }
    let original = try await first.load().value
    XCTAssertEqual(original, ["mine"])
  }

  func testCancelledWaiterAndOwnerClosePreserveAcceptedWritesForTheNextReader() async throws {
    let fixture = try environment()
    let first = storage(fixture, scope: scope())
    let write = first.setExpanded(true, projectID: "last-click")
    write.cancel()
    let closing = first.close()
    let next = storage(fixture, scope: scope())
    let restored = try await next.load().value
    XCTAssertEqual(restored, ["last-click"])
    _ = try? await write.value
    await closing.value
    do {
      try await first.setExpanded(false, projectID: "last-click").value
      XCTFail("A closed owner must reject future writes")
    } catch ProjectDisclosureError.closed {}
    let unchanged = try await next.load().value
    XCTAssertEqual(unchanged, ["last-click"])
  }

  func testCompletedCommandsAndAuthoritativePruningSurviveReopening() async throws {
    let fixture = try environment()
    let first = storage(fixture, scope: scope())
    let writes = (0..<12).map { first.setExpanded($0 % 2 == 0, projectID: "toggled") }
    let keep = first.setExpanded(true, projectID: "keep")
    let remove = first.setExpanded(true, projectID: "removed")
    let prune = first.retainProjects(["keep", "toggled"])
    let close = first.close()
    let reopened = storage(fixture, scope: scope())
    let result = try await reopened.load().value
    XCTAssertEqual(result, ["keep"])
    for write in writes { try await write.value }
    try await keep.value
    try await remove.value
    try await prune.value
    await close.value
  }

  func testFailedImportRollsBackRowsAndMarkerThenRetriesFromThePreservedDefaults() async throws {
    let fixture = try environment()
    let scope = scope()
    let key = fixture.legacyKey(
      apiURL: scope.apiBaseURL, userID: scope.userID, workspaceID: scope.workspaceID)
    fixture.defaults.set("invalid legacy data", forKey: key)
    let owner = storage(fixture, scope: scope)
    do {
      _ = try await owner.load().value
      XCTFail("Invalid legacy data must not be erased")
    } catch ProjectDisclosureError.invalidLegacyPreferences {}
    try fixture.execute(
      """
      CREATE TRIGGER reject_import BEFORE INSERT ON expanded_projects
      WHEN NEW.project_id = 'rejected' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END
      """)
    fixture.defaults.set(["accepted": true, "rejected": true], forKey: key)
    do {
      _ = try await owner.load().value
      XCTFail("The failing transaction cannot complete migration")
    } catch {
      XCTAssertNotNil(fixture.defaults.object(forKey: key))
    }
    XCTAssertEqual(try fixture.integer("SELECT COUNT(*) FROM expanded_projects"), 0)
    XCTAssertEqual(try fixture.integer("SELECT COUNT(*) FROM disclosure_migrations"), 0)
    try fixture.execute("DROP TRIGGER reject_import")
    let recovered = try await owner.load().value
    XCTAssertEqual(recovered, ["accepted", "rejected"])
    XCTAssertNil(fixture.defaults.object(forKey: key))
  }

  func testUnsupportedSchemaIsPreservedRatherThanReset() async throws {
    let fixture = try environment()
    let first = storage(fixture, scope: scope())
    try await first.setExpanded(true, projectID: "keep").value
    await first.close().value
    try fixture.execute("PRAGMA user_version = 2")
    let next = storage(fixture, scope: scope())
    do {
      _ = try await next.load().value
      XCTFail("Unknown preference schemas must not be rebuilt as caches")
    } catch ProjectDisclosureError.unsupportedVersion {}
    XCTAssertEqual(try fixture.integer("SELECT COUNT(*) FROM expanded_projects"), 1)
    XCTAssertEqual(try fixture.integer("PRAGMA user_version"), 2)
  }

  func testFilesystemFailureKeepsTheSourceAndTheSameOwnerCanRetry() async throws {
    let fixture = try environment()
    let scope = scope()
    let key = fixture.legacyKey(
      apiURL: scope.apiBaseURL, userID: scope.userID, workspaceID: scope.workspaceID)
    fixture.defaults.set(["keep": true], forKey: key)
    try FileManager.default.createDirectory(
      at: fixture.directory, withIntermediateDirectories: true)
    let blocker = fixture.directory.appending(path: "ProjectDisclosure")
    try Data("occupied path".utf8).write(to: blocker)
    let owner = storage(fixture, scope: scope)
    do {
      _ = try await owner.load().value
      XCTFail("An unwritable destination must not complete migration")
    } catch {
      XCTAssertNotNil(fixture.defaults.object(forKey: key))
    }
    try FileManager.default.removeItem(at: blocker)
    let recovered = try await owner.load().value
    XCTAssertEqual(recovered, ["keep"])
    XCTAssertNil(fixture.defaults.object(forKey: key))
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

  private func scope(
    origin: String = "https://preferences.invalid", user: String = "user",
    workspace: String = "workspace"
  ) -> ChatCacheScope {
    ChatCacheScope(apiBaseURL: URL(string: origin)!, userID: user, workspaceID: workspace)
  }
}
