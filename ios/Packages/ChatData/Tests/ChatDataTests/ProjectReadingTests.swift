import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

@MainActor
final class ProjectReadingTests: XCTestCase {
  func testProjectMembershipSurvivesHTTPSynchronizationAndReopenedCache() async throws {
    let thread = "30000000-0000-4000-8000-000000000001"
    let agent = "30000000-0000-4000-8000-000000000002"
    let project = "30000000-0000-4000-8000-000000000071"
    let leave = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(thread)","agentId":"\(agent)","title":"Planning","createdAt":"2026-11-02T00:00:00Z","updatedAt":"2026-11-02T00:00:00Z","sortAt":"2026-11-02T00:00:00Z"}],"latestEventId":"30000000-0000-4000-8000-000000000011","latestSeqId":1}
            """)
      case "/api/chat-threads/events":
        let leaving = leave.withLock { $0 }
        let sequence = leaving ? 3 : 2
        let membership = leaving ? "null" : "\"\(project)\""
        return ChatHTTPResponse(
          body: """
            {"events":[{"id":"30000000-0000-4000-8000-00000000001\(sequence)","seqId":\(sequence),"kind":"project_updated","chatThreadId":"\(thread)","agentId":"\(agent)","projectId":\(membership),"createdAt":"2026-11-02T01:00:00Z"}],"hasMore":false}
            """)
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "project-reader", workspaceID: "project-workspace")
    let service = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let members = try await service.threads()
    XCTAssertEqual(members.first?.projectId, project)
    XCTAssertEqual(members.first?.agentID, agent)
    XCTAssertEqual(members.first?.sortAt, ISO8601DateFormatter().date(from: "2026-11-02T00:00:00Z"))
    let restarted = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let cached = await restarted.cachedThreads()
    XCTAssertEqual(cached?.first?.projectId, project)
    leave.withLock { $0 = true }
    let unassigned = try await restarted.threads()
    XCTAssertNil(unassigned.first?.projectId)
    XCTAssertEqual(unassigned.first?.agentID, agent)
  }
}
