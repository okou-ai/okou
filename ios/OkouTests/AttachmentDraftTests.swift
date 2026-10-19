import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class AttachmentDraftTests: XCTestCase {
  func testUploadRetryAndUncertainMessageRetryPreserveFileAndMessageIdentity() async throws {
    let fixture = AttachmentFlowFixture(failUpload: true, failSend: true)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let source = try makeFile()
    defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
    conversation.attachmentDraft.importFiles([source])
    try await eventually {
      conversation.attachmentDraft.items.contains {
        if case .failed = $0.state { true } else { false }
      }
    }
    await conversation.send()
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })
    let item = try XCTUnwrap(conversation.attachmentDraft.items.first)
    XCTAssertNotEqual(item.file.url, source)
    XCTAssertTrue(FileManager.default.fileExists(atPath: item.file.url.path))
    conversation.attachmentDraft.retry(item.id)
    try await eventually { conversation.attachmentDraft.isReady }
    await conversation.send()
    let pending = try XCTUnwrap(conversation.pending.first)
    XCTAssertTrue(pending.needsRetry)
    XCTAssertEqual(pending.attachments.first?.id, AttachmentFlowFixture.fileID)
    XCTAssertFalse(FileManager.default.fileExists(atPath: item.file.url.path))
    await conversation.retry(pending)
    let messages = try fixture.state.value.withLock {
      try $0.messages.map {
        try JSONDecoder().decode(AttachmentFlowFixture.Message.self, from: $0)
      }
    }
    XCTAssertEqual(messages.count, 2)
    XCTAssertEqual(messages.map(\.clientEventId), [pending.id, pending.id])
    XCTAssertTrue(messages.allSatisfy { !$0.hasTextContent })
    XCTAssertTrue(
      messages.allSatisfy { $0.userMessage.parts.first?.fileId == AttachmentFlowFixture.fileID })
    XCTAssertTrue(conversation.pending.isEmpty)
    XCTAssertTrue(conversation.messages.first?.text.contains("notes.txt") == true)
    XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
  }

  func testNewChatCanSendOnlyFilesAndRemoveDraftFilesWithoutDeletingOriginals() async throws {
    let fixture = AttachmentFlowFixture()
    let store = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { store.close() }
    let source = try makeFile()
    defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
    store.newAttachmentDraft.importFiles([source])
    try await eventually {
      !store.newAttachmentDraft.items.isEmpty && store.newAttachmentDraft.isReady
    }
    let first = try XCTUnwrap(store.newAttachmentDraft.items.first)
    store.newAttachmentDraft.remove(first.id)
    XCTAssertFalse(FileManager.default.fileExists(atPath: first.file.url.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
    store.newAttachmentDraft.importFiles([source])
    try await eventually {
      !store.newAttachmentDraft.items.isEmpty && store.newAttachmentDraft.isReady
    }
    await store.sendNewChat()
    XCTAssertEqual(store.selectedThreadID, AttachmentFlowFixture.threadID)
    XCTAssertFalse(store.newAttachmentDraft.hasAttachments)
    XCTAssertFalse(store.selectedConversation?.attachmentDraft.hasAttachments ?? true)
    let messages = try fixture.state.value.withLock {
      try $0.messages.map {
        try JSONDecoder().decode(AttachmentFlowFixture.Message.self, from: $0)
      }
    }
    XCTAssertEqual(messages.count, 1)
    XCTAssertFalse(messages.first?.hasTextContent ?? true)
    XCTAssertEqual(messages.first?.userMessage.parts.first?.fileId, AttachmentFlowFixture.fileID)
  }

  func testClosingWorkspaceCancelsInFlightUploadAndCleansItsPrivateCopy() async throws {
    let started = expectation(description: "Upload reached storage")
    let (stream, continuation) = AsyncStream<Void>.makeStream()
    defer { continuation.finish() }
    let fixture = AttachmentFlowFixture(storage: {
      started.fulfill()
      for await _ in stream { break }
    })
    let store = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { store.close() }
    let source = try makeFile()
    defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
    store.newChatDraft = "Read this"
    store.newAttachmentDraft.importFiles([source])
    await fulfillment(of: [started], timeout: 3)
    let copy = try XCTUnwrap(store.newAttachmentDraft.items.first?.file.url)
    await store.sendNewChat()
    XCTAssertNil(store.selectedThreadID)
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })
    store.close()
    XCTAssertFalse(FileManager.default.fileExists(atPath: copy.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
  }

  private func makeFile() throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("notes.txt")
    try Data("notes".utf8).write(to: file)
    return file
  }

  func testFailedNewChatCreationCannotSendAttachmentsIntoAChatOpenedWhileWaiting() async throws {
    let creating = expectation(description: "New chat creation started")
    let (stream, continuation) = AsyncStream<Void>.makeStream()
    defer { continuation.finish() }
    let calls = Mutex(0)
    let fixture = AttachmentFlowFixture(creation: {
      let count = calls.withLock {
        $0 += 1
        return $0
      }
      if count == 1 { return true }
      creating.fulfill()
      for await _ in stream { break }
      return false
    })
    let store = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { store.close() }
    await store.createChat()
    store.startNewChat()
    let source = try makeFile()
    defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
    store.newAttachmentDraft.importFiles([source])
    try await eventually {
      !store.newAttachmentDraft.items.isEmpty && store.newAttachmentDraft.isReady
    }
    let operation = Task { await store.sendNewChat() }
    await fulfillment(of: [creating], timeout: 3)
    store.selectChat(AttachmentFlowFixture.threadID)
    continuation.yield()
    await operation.value
    XCTAssertEqual(store.selectedThreadID, AttachmentFlowFixture.threadID)
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })
    XCTAssertTrue(store.newAttachmentDraft.hasAttachments)
    XCTAssertTrue(store.newAttachmentDraft.isReady)
  }
}

private final class AttachmentFlowFixture: Sendable {
  static let fileID = "42000000-0000-4000-8000-000000000001"
  static let agentID = "42000000-0000-4000-8000-000000000002"
  static let threadID = "42000000-0000-4000-8000-000000000003"
  struct State: Sendable {
    var uploads = 0
    var messages: [Data] = []
    var accepted: Data?
  }
  let state = AttachmentFlowState()
  let http: ChatHTTPFixture

  init(
    failUpload: Bool = false, failSend: Bool = false,
    storage: @escaping @Sendable () async -> Void = {},
    creation: @escaping @Sendable () async -> Bool = { true }
  ) {
    let state = self.state
    http = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      let metadata =
        "{\"id\":\"\(Self.fileID)\",\"filename\":\"notes.txt\",\"contentType\":\"text/plain\",\"size\":5,\"url\":\"artifact://\(Self.fileID)\"}"
      switch path {
      case "/api/uploads/prepare":
        let url = "https://\(request.url!.host!)/storage/object"
        return ChatHTTPResponse(
          body: String(metadata.dropLast()) + ",\"uploadUrl\":\"\(url)\",\"uploadHeaders\":{}}")
      case "/storage/object":
        await storage()
        let count = state.value.withLock {
          $0.uploads += 1
          return $0.uploads
        }
        return ChatHTTPResponse(status: failUpload && count == 1 ? 500 : 200, body: "")
      case "/api/uploads/complete": return ChatHTTPResponse(body: metadata)
      case "/api/agents":
        return ChatHTTPResponse(
          body:
            "[{\"agentId\":\"\(Self.agentID)\",\"displayName\":\"Okou\",\"isDefaultAgent\":true}]")
      case "/api/user-model-preference": return ChatHTTPResponse(body: "{}")
      case "/api/run-models", "/api/model-catalog": return ChatHTTPResponse(body: "{\"models\":[]}")
      case "/api/chat-threads":
        guard await creation() else {
          return ChatHTTPResponse(
            status: 503, body: "{\"error\":{\"message\":\"Creation failed\"}}")
        }
        return ChatHTTPResponse(
          status: 201, body: "{\"id\":\"\(Self.threadID)\",\"createdAt\":\"2026-10-19T10:00:00Z\"}")
      case let path where path.hasSuffix("/connector-selections"):
        return ChatHTTPResponse(body: "{\"selections\":[]}")
      case let path where path.hasSuffix("/metadata"):
        return ChatHTTPResponse(
          body:
            "{\"id\":\"\(Self.threadID)\",\"agentId\":\"\(Self.agentID)\",\"computerUseHostId\":null,\"cloudBrowserEnabled\":false}"
        )
      case let path where path.hasSuffix("/event-snapshot"):
        return ChatHTTPResponse(
          status: 404,
          body:
            "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
      case let path where path.hasSuffix("/event-rows"):
        if let accepted = state.value.withLock({ $0.accepted }) {
          let message = try JSONDecoder().decode(Message.self, from: accepted)
          let after =
            URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "sinceSeqId" }?.value.flatMap(Int.init) ?? 0
          if after >= 1 {
            return ChatHTTPResponse(
              body:
                "{\"rows\":[],\"cursor\":{\"lastEventId\":\"\(message.clientEventId)\",\"lastSeqId\":1},\"hasMore\":false}"
            )
          }
          let document = String(
            decoding: try JSONEncoder().encode(message.userMessage), as: UTF8.self)
          return ChatHTTPResponse(
            body:
              "{\"rows\":[{\"id\":\"\(message.clientEventId)\",\"chatThreadId\":\"\(Self.threadID)\",\"seqId\":1,\"eventType\":\"input.prompt\",\"createdAt\":\"2026-10-19T10:00:00Z\",\"payload\":{\"userMessage\":\(document)}}],\"cursor\":{\"lastEventId\":\"\(message.clientEventId)\",\"lastSeqId\":1},\"hasMore\":false}"
          )
        }
        return ChatHTTPResponse(
          body: "{\"rows\":[],\"cursor\":{\"lastEventId\":null,\"lastSeqId\":0},\"hasMore\":false}")
      case "/api/chat-threads/\(Self.threadID)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      case "/api/chat/events":
        let failed = state.value.withLock {
          $0.messages.append(chatRequestBody(request))
          if failSend && $0.messages.count == 1 { return true }
          $0.accepted = chatRequestBody(request)
          return false
        }
        return ChatHTTPResponse(
          status: failed ? 503 : 201,
          body: failed
            ? "{\"error\":{\"message\":\"Unknown delivery\"}}"
            : "{\"threadId\":\"\(Self.threadID)\"}")
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  @MainActor func conversation() -> ConversationStore {
    let sync = ChatSync(client: http.client)
    return ConversationStore(
      thread: ChatThread(
        id: Self.threadID, agentID: Self.agentID, title: "Attachments",
        createdAt: .now, updatedAt: .now, sortAt: .now),
      sync: sync, commands: ChatCommands(client: http.client, sync: sync), webURL: http.baseURL,
      messageMarkdown: MessageMarkdownCache(baseURL: http.baseURL),
      isVisible: { false }, didMarkRead: {}, didSend: {}, didFail: { _ in }, didSettle: {})
  }

  struct Message: Codable {
    let clientEventId: String
    let hasTextContent: Bool
    let userMessage: Document
    struct Document: Codable {
      let version: Int
      let parts: [Part]
      struct Part: Codable {
        let type: String
        let fileId: String?
        let filenameSnapshot: String?
        let contentType: String?
      }
    }
  }
}

private final class AttachmentFlowState: Sendable {
  let value = Mutex(AttachmentFlowFixture.State())
}
