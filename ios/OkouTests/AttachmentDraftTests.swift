import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import UIKit
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
    XCTAssertEqual(conversation.messages.first?.text, "")
    XCTAssertEqual(conversation.messages.first?.attachments.first?.filename, "notes.txt")
    XCTAssertEqual(conversation.messages.first?.attachments.first?.id, AttachmentFlowFixture.fileID)
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

  func testNewImageChatStaysSelectedWhenAnOlderListRefreshFinishesAfterSending() async throws {
    let oldListReady = expectation(description: "The pre-creation list is awaiting indicators")
    let freshListReady = expectation(description: "The replacement list is awaiting indicators")
    let (oldList, releaseOldList) = AsyncStream<Void>.makeStream()
    let (freshList, releaseFreshList) = AsyncStream<Void>.makeStream()
    defer {
      releaseOldList.finish()
      releaseFreshList.finish()
    }
    let reads = Mutex((snapshots: 0, indicators: 0))
    let deleted = Mutex(false)
    let image = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 60)).pngData { context in
      UIColor.systemTeal.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 80, height: 60))
    }
    let fixture = AttachmentFlowFixture(
      attachment: ChatAttachment(
        id: AttachmentFlowFixture.fileID, filename: "Screenshot.png", contentType: "image/png",
        size: image.count, url: "artifact://\(AttachmentFlowFixture.fileID)"),
      threadList: { request in
        switch request.url?.path {
        case "/api/chat-threads/snapshot":
          let first = reads.withLock {
            $0.snapshots += 1
            return $0.snapshots == 1
          }
          let threads =
            first || deleted.withLock { $0 }
            ? ""
            : """
            {"id":"\(AttachmentFlowFixture.threadID)","agentId":"\(AttachmentFlowFixture.agentID)","title":"Screenshot conversation","sortAt":"2026-10-19T10:00:00Z","createdAt":"2026-10-19T10:00:00Z","updatedAt":"2026-10-19T10:00:00Z"}
            """
          return ChatHTTPResponse(
            body:
              "{\"chatThreads\":[\(threads)],\"latestEventId\":null,\"latestSeqId\":null}")
        case "/api/chat-threads/events":
          return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
        case "/api/indicators":
          let count = reads.withLock {
            $0.indicators += 1
            return $0.indicators
          }
          if count == 1 {
            oldListReady.fulfill()
            for await _ in oldList { break }
          } else if count == 2 {
            freshListReady.fulfill()
            for await _ in freshList { break }
          }
          return ChatHTTPResponse(body: "{\"agents\":{},\"unreadAt\":{},\"threads\":{}}")
        default: throw URLError(.unsupportedURL)
        }
      })
    let store = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { store.close() }
    let source = try makeFile(filename: "Screenshot.png", content: image)
    defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
    store.newAttachmentDraft.importFiles([source])
    try await eventually {
      store.newAttachmentDraft.hasAttachments && store.newAttachmentDraft.isReady
    }
    let refresh = Task { await store.refresh([.threadList]) }
    await fulfillment(of: [oldListReady], timeout: 3)

    await store.sendNewChat()
    let conversation = try XCTUnwrap(store.selectedConversation)
    releaseOldList.yield(())
    await fulfillment(of: [freshListReady], timeout: 3)

    XCTAssertEqual(store.selectedThreadID, AttachmentFlowFixture.threadID)
    XCTAssertTrue(store.selectedConversation === conversation)
    XCTAssertEqual(conversation.messages.first?.attachments.first?.contentType, "image/png")
    releaseFreshList.yield(())
    await refresh.value
    XCTAssertEqual(store.selectedThreadID, AttachmentFlowFixture.threadID)
    XCTAssertEqual(store.selectedConversation?.thread.title, "Screenshot conversation")

    deleted.withLock { $0 = true }
    await store.list.refresh(waitForCurrent: true)
    XCTAssertNil(store.selectedThreadID)
    XCTAssertNil(store.selectedConversation)
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

  func testFirstSendBeforeAgentNavigationCannotRestoreTheOldAgentDraftAfterward() async throws {
    let fixture = AttachmentFlowFixture()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: fixture.http.baseURL,
        userID: "user", workspaceID: "org"), directory: directory)
    var old = ChatDraftDocument()
    old.replaceText("Previously saved Agent draft")
    fixture.state.value.withLock {
      $0.agentDrafts["/api/agents/\(AttachmentFlowFixture.agentID)/draft"] = ComposerDraft(
        document: old)
    }
    let store = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, draftStorage: storage)
    defer { store.close() }
    store.setForeground(true)
    XCTAssertNil(store.selectedAgentID)
    store.newChatDraft = "First message before navigation finishes"
    await store.sendNewChat()
    await store.newComposer.synchronize()
    XCTAssertEqual(store.selectedThreadID, AttachmentFlowFixture.threadID)
    XCTAssertEqual(store.newChatDraft, "")
    XCTAssertEqual(fixture.state.value.withLock { $0.messages.count }, 1)
    store.startNewChat()
    XCTAssertEqual(store.newChatDraft, "")
  }

  func testUncertainSendSurvivesRestartWithOriginalIdentityAndNoAutomaticResend() async throws {
    for acceptedBeforeFailure in [false, true] {
      let fixture = AttachmentFlowFixture(
        failSend: true, acceptBeforeFailure: acceptedBeforeFailure)
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: directory) }
      let storage = ChatDraftStorage(
        scope: ChatCacheScope(
          apiBaseURL: fixture.http.baseURL,
          userID: "user", workspaceID: "org"), directory: directory)
      let first = fixture.conversation(storage: storage)
      await first.composer.synchronize()
      first.draft = "Keep this delivery identity"
      let source = try makeFile()
      defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
      first.attachmentDraft.importFiles([source])
      try await eventually { first.attachmentDraft.hasAttachments && first.attachmentDraft.isReady }
      await first.send()
      let original = try XCTUnwrap(first.pending.first)
      XCTAssertTrue(original.needsRetry)
      first.close()
      let reopened = fixture.conversation(storage: storage)
      XCTAssertEqual(reopened.draft, "")
      XCTAssertEqual(reopened.pending.first?.id, original.id)
      await reopened.composer.synchronize()
      await reopened.refresh()
      XCTAssertEqual(fixture.state.value.withLock { $0.messages.count }, 1)
      if acceptedBeforeFailure {
        XCTAssertTrue(reopened.pending.isEmpty)
      } else {
        let retry = try XCTUnwrap(reopened.pending.first)
        await reopened.retry(retry)
        XCTAssertTrue(reopened.pending.isEmpty)
        let sent = try fixture.state.value.withLock {
          try $0.messages.map {
            try JSONDecoder().decode(AttachmentFlowFixture.Message.self, from: $0)
          }
        }
        XCTAssertEqual(sent.map(\.clientEventId), [original.id, original.id])
        XCTAssertEqual(sent.last?.userMessage.parts.last?.fileId, AttachmentFlowFixture.fileID)
      }
      XCTAssertEqual(fixture.state.value.withLock { $0.draft }, ComposerDraft())
      reopened.close()
    }
  }

  func testWorkspaceRestoresSeparateAgentAndExistingThreadDraftsAcrossSwitchesAndRestart()
    async throws
  {
    let fixture = AttachmentFlowFixture()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: fixture.http.baseURL,
        userID: "user", workspaceID: "org"), directory: directory)
    let store = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, draftStorage: storage)
    store.selectedAgentID = AttachmentFlowFixture.agentID
    store.newChatDraft = "Agent draft"
    let source = try makeFile()
    defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
    store.newAttachmentDraft.importFiles([source])
    try await eventually {
      store.newAttachmentDraft.hasAttachments && store.newAttachmentDraft.isReady
    }
    store.startNewChat()
    XCTAssertEqual(store.newChatDraft, "Agent draft")
    XCTAssertTrue(store.newAttachmentDraft.hasAttachments)
    let result = await store.createChat(agentID: AttachmentFlowFixture.agentID)
    let created = try XCTUnwrap(result)
    let conversation = try XCTUnwrap(store.selectedConversation)
    conversation.draft = "Thread draft"
    store.startNewChat()
    XCTAssertEqual(store.newChatDraft, "Agent draft")
    store.selectChat(created.id)
    XCTAssertEqual(store.selectedConversation?.draft, "Thread draft")
    store.close()
    let reopened = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, draftStorage: storage)
    defer { reopened.close() }
    XCTAssertEqual(reopened.selectedAgentID, AttachmentFlowFixture.agentID)
    XCTAssertEqual(reopened.newChatDraft, "Agent draft")
    XCTAssertTrue(reopened.newAttachmentDraft.hasAttachments)
    _ = await reopened.createChat(agentID: AttachmentFlowFixture.agentID)
    XCTAssertEqual(reopened.selectedConversation?.draft, "Thread draft")
    reopened.selectedAgentID = "other-agent"
    XCTAssertEqual(reopened.newChatDraft, "")
    XCTAssertFalse(reopened.newAttachmentDraft.hasAttachments)
    reopened.selectedAgentID = AttachmentFlowFixture.agentID
    XCTAssertEqual(reopened.newChatDraft, "Agent draft")
    reopened.newComposer.clear()
  }

  private func makeFile(filename: String = "notes.txt", content: Data = Data("notes".utf8)) throws
    -> URL
  {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent(filename)
    try content.write(to: file)
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

final class AttachmentFlowFixture: Sendable {
  static let fileID = "42000000-0000-4000-8000-000000000001"
  static let agentID = "42000000-0000-4000-8000-000000000002"
  static let threadID = "42000000-0000-4000-8000-000000000003"
  struct State: Sendable {
    var uploads = 0
    var preparations: [Data] = []
    var messages: [Data] = []
    var accepted: Data?
    var draft = ComposerDraft()
    var agentDrafts: [String: ComposerDraft] = [:]
  }
  let state = AttachmentFlowState()
  let http: ChatHTTPFixture

  init(
    failUpload: Bool = false, failSend: Bool = false, acceptBeforeFailure: Bool = false,
    storage: @escaping @Sendable () async -> Void = {},
    creation: @escaping @Sendable () async -> Bool = { true },
    draftRead: @escaping @Sendable () async -> Void = {},
    workflows: (@Sendable (URLRequest) async throws -> ChatHTTPResponse)? = nil,
    attachment: ChatAttachment? = nil,
    threadList: ChatHTTPFixture.Handler? = nil
  ) {
    let state = self.state
    http = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      let file =
        attachment
        ?? ChatAttachment(
          id: Self.fileID, filename: "notes.txt", contentType: "text/plain", size: 5,
          url: "artifact://\(Self.fileID)")
      let metadata = String(decoding: try JSONEncoder().encode(file), as: UTF8.self)
      if path.hasPrefix("/api/agents/") && path.hasSuffix("/draft") {
        if request.httpMethod == "PATCH" {
          let draft = try JSONDecoder().decode(ComposerDraft.self, from: chatRequestBody(request))
          state.value.withLock { $0.agentDrafts[path] = draft }
          return ChatHTTPResponse(status: 204, body: "")
        }
        let draft = state.value.withLock { $0.agentDrafts[path] ?? ComposerDraft() }
        return ChatHTTPResponse(
          body: String(decoding: try JSONEncoder().encode(draft), as: UTF8.self))
      }
      switch path {
      case "/api/chat-threads/snapshot", "/api/chat-threads/events", "/api/indicators":
        if let threadList { return try await threadList(request) }
        switch path {
        case "/api/chat-threads/snapshot":
          return ChatHTTPResponse(
            body: #"{"chatThreads":[],"latestEventId":null,"latestSeqId":null}"#)
        case "/api/chat-threads/events":
          return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
        default:
          return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
        }
      case "/api/workflows/for-composer":
        guard let workflows else { throw URLError(.unsupportedURL) }
        return try await workflows(request)
      case "/api/web/file-url": return ChatHTTPResponse(body: "{}")
      case "/api/chat-threads/\(Self.threadID)/draft":
        await draftRead()
        return ChatHTTPResponse(
          body: String(
            decoding: try JSONEncoder().encode(state.value.withLock { $0.draft }), as: UTF8.self))
      case "/api/uploads/prepare":
        state.value.withLock { $0.preparations.append(chatRequestBody(request)) }
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
      case "/api/user-preferences": return ChatHTTPResponse(body: #"{"pinnedAgentIds":[]}"#)
      case "/api/feature-switches": return ChatHTTPResponse(body: #"{"effectiveSwitches":{}}"#)
      case "/api/user-model-preference": return ChatHTTPResponse(body: "{}")
      case "/api/run-models", "/api/model-catalog":
        return ChatHTTPResponse(body: "{\"models\":[],\"routes\":[]}")
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
          let message = try JSONDecoder().decode(PersistedMessage.self, from: accepted)
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
        if request.httpMethod == "PATCH" {
          let draft = try JSONDecoder().decode(ComposerDraft.self, from: chatRequestBody(request))
          state.value.withLock { $0.draft = draft }
          return ChatHTTPResponse(status: 204, body: "")
        }
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      case "/api/chat/events":
        let failed = state.value.withLock {
          $0.messages.append(chatRequestBody(request))
          if failSend && $0.messages.count == 1 {
            if acceptBeforeFailure { $0.accepted = chatRequestBody(request) }
            return true
          }
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

  @MainActor func conversation(
    storage: ChatDraftStorage? = nil, workflowSource: ComposerWorkflowSource? = nil
  ) -> ConversationStore {
    let sync = ChatSync(client: http.client)
    return ConversationStore(
      thread: ChatThread(
        id: Self.threadID, agentID: Self.agentID, title: "Attachments",
        createdAt: .now, updatedAt: .now, sortAt: .now),
      sync: sync, commands: ChatCommands(client: http.client, sync: sync), webURL: http.baseURL,
      messageMarkdown: MessageMarkdownCache(baseURL: http.baseURL),
      isVisible: { false }, didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {},
      workflowSource: workflowSource,
      draftRepository: storage.map { _ in ChatDraftRepository(client: http.client) },
      draftStorage: storage)
  }

  private struct PersistedMessage: Decodable {
    let clientEventId: String
    let userMessage: ChatDraftDocument
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
        let text: String?
        let fileId: String?
        let filenameSnapshot: String?
        let contentType: String?
      }
    }
  }
}

final class AttachmentFlowState: Sendable {
  let value = Mutex(AttachmentFlowFixture.State())
}
