import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

@MainActor
final class ProjectIncrementalSyncTests: XCTestCase {
  func testPagedProjectChangesResumeFromThePersistedFrontierAfterReopening() async throws {
    let cursors = Mutex<[Int]>([])
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/projects/snapshot":
        return projectBaseline()
      case "/api/projects/events":
        let cursor = projectCursor(request)
        cursors.withLock { $0.append(cursor) }
        switch cursor {
        case 1: return projectPage([projectEvent(2, name: "Renamed")], more: true)
        case 2: return projectPage([projectEvent(3, kind: "created", project: 2, name: "Other")])
        case 3: return projectPage([projectEvent(4, kind: "deleted", name: nil)])
        case 4: return projectPage([])
        default: throw URLError(.badServerResponse)
        }
      default: throw URLError(.unsupportedURL)
      }
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = projectScope(fixture)
    let first = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let loaded = try await first.projectList()
    XCTAssertEqual(loaded.map(\.name), ["Renamed", "Other"])

    let reopened = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let changed = try await reopened.projectList()
    XCTAssertEqual(changed.map(\.name), ["Other"])
    let unchanged = try await reopened.projectList()
    XCTAssertEqual(unchanged, changed)
    XCTAssertEqual(cursors.withLock { $0 }, [1, 2, 3, 4])
    let other = ChatSync(
      client: fixture.client,
      cache: directory.cache(
        scope: ChatCacheScope(
          apiBaseURL: fixture.baseURL, userID: "another-reader", workspaceID: "scope")))
    let isolated = try await other.projectList()
    XCTAssertEqual(isolated.map(\.name), ["Renamed", "Other"])
  }

  func testProjectArchiveRenameAndRestoreSurviveReopeningWithoutReordering() async throws {
    let phase = Mutex(0)
    let archivedAt = "2026-11-13T01:00:00Z"
    let renamedAt = "2026-11-13T02:00:00Z"
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/projects/snapshot": return projectBaseline()
      case "/api/projects/events":
        switch (projectCursor(request), phase.withLock({ $0 })) {
        case (1, 1):
          return projectPage([projectEvent(2, kind: "archived", name: "Launch")])
        case (2, 2):
          return projectPage([projectEvent(3, name: "Release", createdAt: renamedAt)])
        case (3, 3):
          return projectPage([
            projectEvent(
              4, kind: "restored", name: "Release", createdAt: "2026-11-13T03:00:00Z")
          ])
        default: return projectPage([])
        }
      default: throw URLError(.unsupportedURL)
      }
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = projectScope(fixture)
    let cache = directory.cache(scope: scope)
    let sync = ChatSync(client: fixture.client, cache: cache)
    let initialProjects = try await sync.projectList()
    let initial = try XCTUnwrap(initialProjects.first)
    // Legacy snapshots omit archivedAt and remain active.
    XCTAssertNil(initial.archivedAt)
    phase.withLock { $0 = 1 }
    let archivedProjects = try await sync.projectList()
    let archived = try XCTUnwrap(archivedProjects.first)
    XCTAssertEqual(archived.archivedAt, ISO8601DateFormatter().date(from: archivedAt))
    XCTAssertEqual(archived.createdAt, initial.createdAt)
    XCTAssertEqual(archived.updatedAt, initial.updatedAt)
    await cache.close()

    let reopenedCache = directory.cache(scope: scope)
    let reopened = ChatSync(client: fixture.client, cache: reopenedCache)
    let retained = try await reopened.projectList()
    XCTAssertEqual(retained, [archived])
    phase.withLock { $0 = 2 }
    let renamedProjects = try await reopened.projectList()
    let renamed = try XCTUnwrap(renamedProjects.first)
    XCTAssertEqual(renamed.name, "Release")
    XCTAssertEqual(renamed.archivedAt, archived.archivedAt)
    XCTAssertEqual(renamed.updatedAt, ISO8601DateFormatter().date(from: renamedAt))
    await reopenedCache.close()

    let restoredCache = directory.cache(scope: scope)
    let restoring = ChatSync(client: fixture.client, cache: restoredCache)
    phase.withLock { $0 = 3 }
    let restoredProjects = try await restoring.projectList()
    let restored = try XCTUnwrap(restoredProjects.first)
    XCTAssertNil(restored.archivedAt)
    XCTAssertEqual(restored.id, initial.id)
    XCTAssertEqual(restored.name, renamed.name)
    XCTAssertEqual(restored.createdAt, initial.createdAt)
    XCTAssertEqual(restored.updatedAt, renamed.updatedAt)
    await restoredCache.close()
    let last = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let saved = try await last.projectList()
    XCTAssertEqual(saved, [restored])
  }

  func testSnapshotArchiveUsesCredentialFreeTransportAndChecksItsFrontier() async throws {
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/projects/snapshot":
        let url = request.url!.deletingLastPathComponent().appendingPathComponent("archive.json")
        return ChatHTTPResponse(
          body: """
            {"url":"\(url.absoluteString)","latestEventId":"\(projectID(1))","latestSeqId":1}
            """)
      case "/api/projects/archive.json":
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: "X-Client-Session-Id"))
        return projectBaseline(archivedAt: "2026-11-13T00:30:00Z")
      case "/api/projects/events":
        XCTAssertEqual(projectCursor(request), 1)
        return projectPage([projectEvent(2, name: "Archive catch-up")])
      default: throw URLError(.unsupportedURL)
      }
    }
    let result = try await ChatSync(client: fixture.client).projectList()
    XCTAssertEqual(result.first?.name, "Archive catch-up")
    XCTAssertEqual(
      result.first?.archivedAt, ISO8601DateFormatter().date(from: "2026-11-13T00:30:00Z"))
  }

  func testExpiredPersistedCursorRebuildsOnceAndKeepsLaterChanges() async throws {
    let expired = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/projects/snapshot":
        return projectBaseline(sequence: expired.withLock { $0 } ? 5 : 1)
      case "/api/projects/events":
        let cursor = projectCursor(request)
        if expired.withLock({ $0 }), cursor == 1 {
          return ChatHTTPResponse(status: 410, body: #"{"error":{"message":"Snapshot required"}}"#)
        }
        return projectPage(cursor == 5 ? [projectEvent(6, name: "Recovered")] : [])
      default: throw URLError(.unsupportedURL)
      }
    }
    let directory = CacheTestDirectory(owner: self)
    let sync = ChatSync(
      client: fixture.client, cache: directory.cache(scope: projectScope(fixture)))
    let initial = try await sync.projectList()
    XCTAssertEqual(initial.first?.name, "Launch")
    expired.withLock { $0 = true }
    let recovered = try await sync.projectList()
    XCTAssertEqual(recovered.first?.name, "Recovered")
  }

  func testAPartialTailFailureDoesNotAdvanceTheDurableCursor() async throws {
    let phase = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/projects/snapshot": return projectBaseline()
      case "/api/projects/events":
        let cursor = projectCursor(request)
        if phase.withLock({ $0 }) == 0 { return projectPage([]) }
        if cursor == 1 { return projectPage([projectEvent(2, name: "Renamed")], more: true) }
        if cursor == 2, phase.withLock({ $0 }) == 1 {
          return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Try again"}}"#)
        }
        return projectPage([projectEvent(3, kind: "created", project: 2, name: "Other")])
      default: throw URLError(.unsupportedURL)
      }
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = projectScope(fixture)
    let first = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    _ = try await first.projectList()
    phase.withLock { $0 = 1 }
    do {
      _ = try await first.projectList()
      XCTFail("A failed page must remain a failed read")
    } catch let error as APIClientError { XCTAssertEqual(error.statusCode, 503) }
    phase.withLock { $0 = 2 }
    let reopened = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let recovered = try await reopened.projectList()
    XCTAssertEqual(recovered.map(\.name), ["Renamed", "Other"])
  }

  func testAnOlderConcurrentReadCannotRollBackANewerProjectFrontier() async throws {
    let reads = Mutex(0)
    let gate = ProjectEventResponseGate()
    let started = expectation(description: "The older event response is held")
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/projects/snapshot": return projectBaseline()
      case "/api/projects/events":
        let number = reads.withLock {
          $0 += 1
          return $0
        }
        if number == 1 { return projectPage([]) }
        if number == 2 {
          started.fulfill()
          await gate.wait()
          return projectPage([projectEvent(2, name: "Older")])
        }
        return projectPage(
          projectCursor(request) == 1
            ? [projectEvent(2, name: "Older"), projectEvent(3, name: "Newest")] : [])
      default: throw URLError(.unsupportedURL)
      }
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = projectScope(fixture)
    let first = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    _ = try await first.projectList()
    let older = Task { try await first.projectList() }
    addTeardownBlock {
      older.cancel()
      gate.open()
      _ = await older.result
    }
    await fulfillment(of: [started], timeout: 3)
    let second = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let newer = try await second.projectList()
    XCTAssertEqual(newer.first?.name, "Newest")
    gate.open()
    let oldResult = try await older.value
    XCTAssertEqual(oldResult.first?.name, "Newest")
    let retained = try await first.projectList()
    XCTAssertEqual(retained.first?.name, "Newest")
  }

  func testCancellationLeavesTheSavedFrontierAvailableToTheNextOwner() async throws {
    let hold = Mutex(false)
    let gate = ProjectEventResponseGate()
    let started = expectation(description: "The request reached the event endpoint")
    let returned = expectation(description: "The held HTTP handler returned")
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/projects/snapshot": return projectBaseline()
      case "/api/projects/events":
        if hold.withLock({ $0 }) {
          started.fulfill()
          await gate.wait()
          returned.fulfill()
        }
        XCTAssertEqual(projectCursor(request), 1)
        return projectPage([])
      default: throw URLError(.unsupportedURL)
      }
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = projectScope(fixture)
    let sync = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    _ = try await sync.projectList()
    hold.withLock { $0 = true }
    let reading = Task { try await sync.projectList() }
    addTeardownBlock {
      reading.cancel()
      gate.open()
      _ = await reading.result
    }
    await fulfillment(of: [started], timeout: 3)
    reading.cancel()
    gate.open()
    await fulfillment(of: [returned], timeout: 3)
    do {
      _ = try await reading.value
      XCTFail("A cancelled read must not publish")
    } catch {
      XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
    }
    hold.withLock { $0 = false }
    let reopened = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let result = try await reopened.projectList()
    XCTAssertEqual(result.first?.name, "Launch")
  }

  func testInvalidEventTailsAndRepeatedSnapshotExpiryRemainErrors() async throws {
    for page in [
      projectPage([], more: true),
      projectPage([projectEvent(1, name: "Out of order")]),
      projectPage([projectEvent(2, project: 2, name: "Missing baseline")]),
      projectPage([projectEvent(2, kind: "archived", project: 2, name: "Missing baseline")]),
      projectPage([projectEvent(2, kind: "restored", project: 2, name: "Missing baseline")]),
      ChatHTTPResponse(status: 410, body: #"{"error":{"message":"Expired"}}"#),
      ChatHTTPResponse(status: 426, body: #"{"error":{"message":"Upgrade required"}}"#),
    ] {
      let fixture = ChatHTTPFixture { request in
        switch request.url?.path {
        case "/api/projects/snapshot": return projectBaseline()
        case "/api/projects/events": return page
        default: throw URLError(.unsupportedURL)
        }
      }
      do {
        _ = try await ChatSync(client: fixture.client).projectList()
        XCTFail("An invalid or unavailable stream must not become an empty Project list")
      } catch {
        if page.status == 426 {
          XCTAssertEqual((error as? APIClientError)?.statusCode, 426)
        } else {
          guard let contract = error as? ChatError, case .invalidContract(_) = contract else {
            return XCTFail("Expected the Project stream contract error, got \(error)")
          }
        }
      }
    }
  }
}

private func projectID(_ value: Int) -> String {
  String(format: "30000000-0000-4000-8000-%012d", value)
}

private func projectScope(_ fixture: ChatHTTPFixture) -> ChatCacheScope {
  ChatCacheScope(apiBaseURL: fixture.baseURL, userID: "project-reader", workspaceID: "scope")
}

private func projectCursor(_ request: URLRequest) -> Int {
  let value = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
    .queryItems?.first { $0.name == "sinceSeqId" }?.value
  return value.flatMap(Int.init) ?? -1
}

private func projectBaseline(sequence: Int = 1, archivedAt: String? = nil) -> ChatHTTPResponse {
  let archived = archivedAt.map { ",\"archivedAt\":\"\($0)\"" } ?? ""
  return ChatHTTPResponse(
    body: """
      {"projects":[{"id":"\(projectID(101))","name":"Launch",
      "createdAt":"2026-11-13T00:00:00Z","updatedAt":"2026-11-13T00:00:00Z"\(archived)}],
      "latestEventId":"\(projectID(sequence))","latestSeqId":\(sequence)}
      """)
}

private func projectEvent(
  _ sequence: Int, kind: String = "renamed", project: Int = 1, name: String?,
  createdAt: String = "2026-11-13T01:00:00Z"
) -> String {
  let encodedName = name.map { "\"\($0)\"" } ?? "null"
  return """
    {"id":"\(projectID(sequence))","seqId":\(sequence),"projectId":"\(projectID(100 + project))",
    "kind":"\(kind)","name":\(encodedName),"createdAt":"\(createdAt)"}
    """
}

private func projectPage(_ events: [String], more: Bool = false) -> ChatHTTPResponse {
  ChatHTTPResponse(body: "{\"events\":[\(events.joined(separator: ","))],\"hasMore\":\(more)}")
}

private final class ProjectEventResponseGate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation

  init() {
    let pair = AsyncStream<Void>.makeStream()
    stream = pair.stream
    continuation = pair.continuation
  }

  func wait() async { for await _ in stream { return } }
  func open() { continuation.finish() }
}
