import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@MainActor
final class StructuredMessageTests: XCTestCase {
  func testStructuredHistorySurvivesHTTPDecodingAndAnOfflineCacheReopen() async throws {
    let thread = "40000000-0000-4000-8000-000000000001"
    let workflow = "40000000-0000-4000-8000-000000000002"
    let documents = [
      #"[{"type":"text","text":"Please review this."},{"type":"source","kind":"slack","href":"https://example.slack.com/archives/C1/p1"}]"#,
      """
      [{"type":"automation","workflowName":"Morning brief","workflowId":"\(workflow)","automationBrief":"A matching email arrived."}]
      """,
      #"[{"type":"source","kind":"mcp","clientId":"research-client","clientName":"Research client"},{"type":"text","text":"Research this."}]"#,
      #"[{"type":"feedback","quote":"Keep this quoted passage.","note":[{"type":"text","text":"Please revise it."}],"source":{"type":"mail","id":"private-mail-id","status":"draft"}}]"#,
      #"[{"type":"template","titleSnapshot":"Saved style","template":{"type":"illustration","selection":{"illustrationStyleId":"saved-style"}}}]"#,
      #"[{"type":"file","fileId":"original-image","filenameSnapshot":"marked.jpg","contentType":"image/jpeg","annotatedFileId":"marked-image"}]"#,
    ]
    let rows = documents.enumerated().map { index, parts in
      let id = String(format: "50000000-0000-4000-8000-%012d", index + 1)
      let type = index == 1 ? "input.automation" : "input.prompt"
      return """
        {"id":"\(id)","chatThreadId":"\(thread)","seqId":\(index + 1),"createdAt":"2026-10-20T00:00:00Z","eventType":"\(type)","payload":{"userMessage":{"version":1,"parts":\(parts)}}}
        """
    }
    let online = Mutex(true)
    let fixture = ChatHTTPFixture { request in
      guard online.withLock({ $0 }) else { throw URLError(.notConnectedToInternet) }
      switch request.url?.path {
      case "/api/chat-threads/\(thread)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body: #"{"error":{"code":"CHAT_EVENT_SNAPSHOT_NOT_FOUND","message":"No snapshot"}}"#)
      case "/api/chat-threads/\(thread)/event-rows":
        let after =
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "sinceSeqId" }?.value.flatMap(Int.init) ?? 0
        return ChatHTTPResponse(
          body: """
            {"rows":[\(rows.dropFirst(after).joined(separator: ","))],"cursor":{"lastEventId":"50000000-0000-4000-8000-000000000006","lastSeqId":6},"hasMore":false}
            """)
      case "/api/chat-threads/\(thread)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "reader", workspaceID: "workspace")
    let cache = ChatCache(scope: scope, directory: directory)
    let history = try await ChatSync(client: fixture.client, cache: cache).history(threadID: thread)
    XCTAssertEqual(history.messages.count, 6)
    XCTAssertEqual(history.messages[0].userMessage?.annotation?.kind, "slack")
    XCTAssertEqual(
      history.messages[0].userMessage?.annotation?.href, "https://example.slack.com/archives/C1/p1")
    XCTAssertEqual(history.messages[1].text, "A matching email arrived.")
    XCTAssertEqual(history.messages[1].userMessage?.annotation?.workflowId, workflow)
    XCTAssertEqual(history.messages[2].userMessage?.annotation?.clientName, "Research client")
    XCTAssertEqual(history.messages[3].userMessage?.bodyParts.first?.source?.status, "draft")
    XCTAssertTrue(history.messages[3].copyText.contains("Please revise it."))
    XCTAssertFalse(history.messages[3].copyText.contains("private-mail-id"))
    XCTAssertEqual(history.messages[4].copyText, "Saved style")
    XCTAssertEqual(history.messages[5].attachments.first?.id, "original-image")
    XCTAssertEqual(history.messages[5].attachments.first?.downloadID, "marked-image")

    online.withLock { $0 = false }
    let reopened = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let cached = await reopened.cachedHistory(threadID: thread)
    XCTAssertEqual(cached?.messages, history.messages)
  }

  func testAnnotatedImageDownloadsTheConfirmedDerivativeThroughItsFileAuthority() async throws {
    let server = try ChatFileHTTPServer { _ in .init(body: Data("rendered image".utf8)) }
    let origin = try await server.start()
    defer { server.stop() }
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.url?.path, "/api/web/file-url")
      XCTAssertEqual(
        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value,
        "confirmed-image")
      return ChatHTTPResponse(
        body: "{\"url\":\"\(origin)/image\",\"downloadUrl\":\"\(origin)/image\"}")
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    let file = try await commands.downloadAttachment(
      ChatMessageAttachment(
        id: "original-image", filename: "marked.png", contentType: "image/png",
        renderedFileID: "confirmed-image"))
    let downloaded = try XCTUnwrap(file)
    XCTAssertEqual(try Data(contentsOf: downloaded.url), Data("rendered image".utf8))
  }
}
