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
    try await waitForBusinessResult(watching: conversation.composer) {
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
    try await waitForBusinessResult(watching: conversation.composer) {
      conversation.attachmentDraft.isReady
    }
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

  func testNewImageChatStaysSelectedWhenAnOlderListRefreshFinishesAfterSending() async throws {
    let oldListReady = expectation(description: "The pre-creation list response is held")
    let freshListReady = expectation(description: "The replacement list response is held")
    let (oldList, releaseOldList) = AsyncStream<Void>.makeStream()
    let (freshList, releaseFreshList) = AsyncStream<Void>.makeStream()
    defer {
      releaseOldList.finish()
      releaseFreshList.finish()
    }
    let reads = Mutex(0)
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
          let count = reads.withLock {
            $0 += 1
            return $0
          }
          let threads =
            count == 1 || deleted.withLock { $0 }
            ? ""
            : """
            {"id":"\(AttachmentFlowFixture.threadID)","title":"Screenshot conversation","sortAt":"2026-10-19T10:00:00Z","createdAt":"2026-10-19T10:00:00Z","updatedAt":"2026-10-19T10:00:00Z"}
            """
          if count == 1 {
            oldListReady.fulfill()
            for await _ in oldList { break }
          } else if count == 2 {
            freshListReady.fulfill()
            for await _ in freshList { break }
          }
          return ChatHTTPResponse(
            body:
              "{\"chatThreads\":[\(threads)],\"latestEventId\":null,\"latestSeqId\":null}")
        case "/api/chat-threads/events":
          return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
        case "/api/indicators":
          return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
        default: throw URLError(.unsupportedURL)
        }
      })
    let store = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { store.close() }
    let source = try makeFile(filename: "Screenshot.png", content: image)
    defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
    store.newAttachmentDraft.importFiles([source])
    try await waitForBusinessResult(watching: store.newComposer) {
      store.newAttachmentDraft.hasAttachments && store.newAttachmentDraft.isReady
    }
    let refresh = Task { await store.refresh([.threadList]) }
    addTeardownBlock { @MainActor in
      store.close()
      refresh.cancel()
      releaseOldList.finish()
      releaseFreshList.finish()
      await refresh.value
    }
    await fulfillment(of: [oldListReady], timeout: 3)

    await store.sendNewChat()
    let conversation = try XCTUnwrap(store.selectedConversation)
    releaseOldList.yield(())
    await fulfillment(of: [freshListReady], timeout: 3)

    XCTAssertEqual(store.selectedThreadID, AttachmentFlowFixture.threadID)
    XCTAssertEqual(store.selectedConversation?.thread.id, conversation.thread.id)
    XCTAssertEqual(
      store.selectedConversation?.messages.first?.attachments.first?.contentType, "image/png")
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
      defer { first.close() }
      await first.composer.synchronize()
      first.draft = "\n  Keep this delivery identity\n\t"
      let source = try makeFile()
      defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
      first.attachmentDraft.importFiles([source])
      try await waitForBusinessResult(watching: first.composer) {
        first.attachmentDraft.hasAttachments && first.attachmentDraft.isReady
      }
      await first.send()
      let original = try XCTUnwrap(first.pending.first)
      XCTAssertTrue(original.needsRetry)
      XCTAssertEqual(original.message.copyText, "Keep this delivery identity")
      first.close()
      let reopened = fixture.conversation(storage: storage)
      defer { reopened.close() }
      XCTAssertEqual(reopened.draft, "")
      XCTAssertEqual(reopened.pending.first?.id, original.id)
      XCTAssertEqual(reopened.messages.first?.copyText, "Keep this delivery identity")
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

  func testWorkspaceRestoresSeparateWorkspaceAndThreadDraftsAcrossSwitchesAndRestart()
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
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    store.newChatDraft = "workspace draft"
    let source = try makeFile()
    defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
    store.newAttachmentDraft.importFiles([source])
    try await waitForBusinessResult(watching: store.newComposer) {
      store.newAttachmentDraft.hasAttachments && store.newAttachmentDraft.isReady
    }
    store.startNewChat()
    XCTAssertEqual(store.newChatDraft, "workspace draft")
    XCTAssertTrue(store.newAttachmentDraft.hasAttachments)
    let result = await store.createChat()
    let created = try XCTUnwrap(result)
    let conversation = try XCTUnwrap(store.selectedConversation)
    conversation.draft = "Thread draft"
    store.startNewChat()
    XCTAssertEqual(store.newChatDraft, "workspace draft")
    store.selectChat(created.id)
    XCTAssertEqual(store.selectedConversation?.draft, "Thread draft")
    store.close()
    let reopened = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, draftStorage: storage)
    defer { reopened.close() }
    await reopened.prepareWorkspaceComposer()
    XCTAssertEqual(reopened.newChatDraft, "workspace draft")
    XCTAssertTrue(reopened.newAttachmentDraft.hasAttachments)
    _ = await reopened.createChat()
    XCTAssertEqual(reopened.selectedConversation?.draft, "Thread draft")
    reopened.startNewChat()
    XCTAssertEqual(reopened.newChatDraft, "workspace draft")
    XCTAssertTrue(reopened.newAttachmentDraft.hasAttachments)
    reopened.newComposer.clear()
  }
}

@MainActor
final class NewChatAttachmentTests: XCTestCase {
  func testLocalImageSurvivesNewChatHandoffAndSubsequentSends() async throws {
    let creating = expectation(description: "New conversation is being created")
    let (responses, release) = AsyncStream<Void>.makeStream()
    defer { release.finish() }
    let bytes = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 60)).pngData { context in
      UIColor.systemTeal.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 80, height: 60))
    }
    let fixture = AttachmentFlowFixture(
      creation: {
        creating.fulfill()
        for await _ in responses { break }
        return true
      },
      attachment: ChatAttachment(
        id: AttachmentFlowFixture.fileID, filename: "Screenshot.png", contentType: "image/png",
        size: bytes.count, url: "artifact://\(AttachmentFlowFixture.fileID)"))
    let store = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { store.close() }
    let source = try makeFile(filename: "Screenshot.png", content: bytes)
    defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
    store.newAttachmentDraft.importFiles([source])
    try await waitForBusinessResult(watching: store.newComposer) {
      store.newAttachmentDraft.hasAttachments && store.newAttachmentDraft.isReady
    }
    let draftURL = try XCTUnwrap(store.newAttachmentDraft.items.first?.file.url)
    let sending = Task { await store.sendNewChat() }
    addTeardownBlock { @MainActor in
      store.close()
      sending.cancel()
      release.finish()
      await sending.value
    }
    await fulfillment(of: [creating], timeout: 3)
    let submission = try XCTUnwrap(store.newChatSubmission)
    let attachment = try XCTUnwrap(submission.message.message.attachments.first)
    let reads = submission.viewer.reads
    let read = reads.thumbnail(attachment)
    let thumbnail = try await reads.store.get(read.value).value.image
    XCTAssertNotNil(thumbnail)
    submission.viewer.open(attachment)
    let cachedURL = try await previewURL(in: submission.viewer)
    XCTAssertEqual(try Data(contentsOf: cachedURL), bytes)
    submission.viewer.dismiss()
    release.yield(())
    await sending.value
    XCTAssertFalse(FileManager.default.fileExists(atPath: draftURL.path))

    let conversation = try XCTUnwrap(store.selectedConversation)
    conversation.attachmentViewer.open(attachment)
    let conversationURL = try await previewURL(in: conversation.attachmentViewer)
    XCTAssertEqual(conversationURL, cachedURL)
    let artifact = ChatArtifact(
      source: .file(attachment.id), filename: attachment.filename,
      contentType: attachment.contentType)
    conversation.artifacts.open(artifact)
    let artifactContent = try await artifactPreviewTask(conversation.artifacts).value
    XCTAssertEqual(artifactContent.file?.url, cachedURL)
    conversation.attachmentViewer.dismiss()
    conversation.artifacts.dismiss()

    conversation.attachmentDraft.importFiles([source])
    try await waitForBusinessResult(watching: conversation.composer) {
      conversation.attachmentDraft.hasAttachments && conversation.attachmentDraft.isReady
    }
    await conversation.send()
    XCTAssertEqual(fixture.state.value.withLock { $0.messages.count }, 2)
    conversation.attachmentViewer.open(attachment)
    let nextURL = try await previewURL(in: conversation.attachmentViewer)
    XCTAssertEqual(try Data(contentsOf: nextURL), bytes)
    conversation.attachmentViewer.dismiss()
    store.close()
    XCTAssertFalse(FileManager.default.fileExists(atPath: nextURL.path))
  }

  func testNewChatCanSendOnlyFilesAndRemoveDraftFilesWithoutDeletingOriginals() async throws {
    let fixture = AttachmentFlowFixture()
    let store = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { store.close() }
    let source = try makeFile()
    defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
    store.newAttachmentDraft.importFiles([source])
    try await waitForBusinessResult(watching: store.newComposer) {
      !store.newAttachmentDraft.items.isEmpty && store.newAttachmentDraft.isReady
    }
    let first = try XCTUnwrap(store.newAttachmentDraft.items.first)
    store.newAttachmentDraft.remove(first.id)
    XCTAssertFalse(FileManager.default.fileExists(atPath: first.file.url.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
    store.newAttachmentDraft.importFiles([source])
    try await waitForBusinessResult(watching: store.newComposer) {
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

  func testNewChatPresentsItsFirstMessageBeforeCreationAndDeliversTheSameIdentity() async throws {
    let creating = expectation(description: "Conversation creation is awaiting its response")
    let (responses, release) = AsyncStream<Void>.makeStream()
    defer { release.finish() }
    let fixture = AttachmentFlowFixture(creation: {
      creating.fulfill()
      for await _ in responses { break }
      return true
    })
    let store = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    store.newChatDraft = "\n  Show this message immediately\n\t"
    let source = try makeFile()
    defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
    store.newAttachmentDraft.importFiles([source])
    try await waitForBusinessResult(watching: store.newComposer) {
      store.newAttachmentDraft.hasAttachments && store.newAttachmentDraft.isReady
    }

    let send = Task { await store.sendNewChat() }
    addTeardownBlock { @MainActor in
      store.close()
      send.cancel()
      release.finish()
      await send.value
    }
    await fulfillment(of: [creating], timeout: 3)
    let firstMessage = try XCTUnwrap(store.newChatSubmission?.message.message)
    XCTAssertEqual(firstMessage.text, "Show this message immediately")
    XCTAssertEqual(firstMessage.copyText, firstMessage.text)
    XCTAssertEqual(firstMessage.attachments.first?.filename, "notes.txt")

    release.yield(())
    await send.value
    let delivered = try XCTUnwrap(store.selectedConversation?.messages.first)
    XCTAssertEqual(delivered.id, firstMessage.id)
    XCTAssertEqual(delivered.text, firstMessage.text)
    XCTAssertEqual(delivered.copyText, firstMessage.copyText)
    XCTAssertEqual(delivered.attachments.map(\.id), firstMessage.attachments.map(\.id))
    XCTAssertEqual(delivered.attachments.map(\.filename), firstMessage.attachments.map(\.filename))
    let sent = try fixture.state.value.withLock {
      try $0.messages.map { try JSONDecoder().decode(AttachmentFlowFixture.Message.self, from: $0) }
    }
    XCTAssertEqual(sent.map(\.clientEventId), [firstMessage.id])
    XCTAssertEqual(sent.first?.userMessage.parts.first?.text, firstMessage.text)
    XCTAssertEqual(sent.first?.userMessage.parts.last?.fileId, AttachmentFlowFixture.fileID)
    XCTAssertEqual(store.newChatDraft, "")
  }

  func testFinishingAnEarlierSendKeepsTheNextNewChatsFirstMessageVisible() async throws {
    let sending = expectation(description: "The first conversation's send is held")
    let creating = expectation(description: "The second conversation's creation is held")
    let (sends, releaseSend) = AsyncStream<Void>.makeStream()
    let (creations, releaseCreation) = AsyncStream<Void>.makeStream()
    defer {
      releaseSend.finish()
      releaseCreation.finish()
    }
    let creationCount = Mutex(0)
    let fixture = AttachmentFlowFixture(
      failSend: true,
      creation: {
        let count = creationCount.withLock {
          $0 += 1
          return $0
        }
        if count == 1 { return true }
        creating.fulfill()
        for await _ in creations { break }
        return false
      },
      sending: {
        sending.fulfill()
        for await _ in sends { break }
      })
    let store = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    store.newChatDraft = "First conversation"
    let first = Task { await store.sendNewChat(sendTransition: ConversationSendTransition()) }
    addTeardownBlock { @MainActor in
      store.close()
      first.cancel()
      releaseSend.finish()
      releaseCreation.finish()
      await first.value
    }
    await fulfillment(of: [sending], timeout: 3)
    let firstConversation = try XCTUnwrap(store.selectedConversation)

    store.startNewChat()
    store.newChatDraft = "Second conversation"
    let second = Task { await store.sendNewChat() }
    addTeardownBlock { @MainActor in
      second.cancel()
      releaseCreation.finish()
      await second.value
    }
    await fulfillment(of: [creating], timeout: 3)
    let secondMessage = try XCTUnwrap(store.newChatSubmission?.message.message)
    releaseSend.yield(())
    await first.value

    XCTAssertEqual(store.newChatSubmission?.message.message, secondMessage)
    XCTAssertEqual(firstConversation.messages.first?.text, "First conversation")
    XCTAssertTrue(firstConversation.pending.first?.needsRetry == true)
    releaseCreation.yield(())
    await second.value
    XCTAssertEqual(store.newChatDraft, "Second conversation")
  }

  func testFirstSendBeforeComposerPreparationCannotRestoreTheOldDraftAfterward() async throws {
    let creating = expectation(description: "Server-default first chat is being created")
    let gate = AsyncStream<Void>.makeStream()
    defer { gate.continuation.finish() }
    let created = Mutex(false)
    let fixture = AttachmentFlowFixture(
      creation: {
        creating.fulfill()
        for await _ in gate.stream {}
        created.withLock { $0 = true }
        return true
      },
      threadList: { request in
        switch request.url?.path {
        case "/api/chat-threads/snapshot":
          let threads =
            created.withLock { $0 }
            ? """
            {"id":"\(AttachmentFlowFixture.threadID)","title":"First conversation","sortAt":"2026-10-19T10:00:00Z","createdAt":"2026-10-19T10:00:00Z","updatedAt":"2026-10-19T10:00:00Z"}
            """ : ""
          return ChatHTTPResponse(
            body: "{\"chatThreads\":[\(threads)],\"latestEventId\":null,\"latestSeqId\":null}")
        case "/api/chat-threads/events":
          return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
        case "/api/indicators":
          return ChatHTTPResponse(body: #"{"threads":{},"unreadAt":{}}"#)
        default: throw URLError(.unsupportedURL)
        }
      })
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: fixture.http.baseURL,
        userID: "user", workspaceID: "org"), directory: directory)
    var old = ChatDraftDocument()
    old.replaceText("Previously saved workspace draft")
    fixture.state.value.withLock {
      $0.composerDrafts["/api/chat-drafts/composer"] = ComposerDraft(
        document: old)
    }
    let store = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, draftStorage: storage)
    defer { store.close() }
    store.setPhase(.active)
    store.newChatDraft = "First message before navigation finishes"
    let sending = Task { await store.sendNewChat() }
    addTeardownBlock { @MainActor in
      store.close()
      sending.cancel()
      gate.continuation.finish()
      await sending.value
    }
    await fulfillment(of: [creating], timeout: 3)
    // The workspace composer can finish loading before the first creation returns.
    await store.prepareWorkspaceComposer()
    gate.continuation.finish()
    await sending.value
    await store.newComposer.synchronize()
    XCTAssertEqual(store.selectedThreadID, AttachmentFlowFixture.threadID)
    XCTAssertEqual(store.newChatDraft, "")
    XCTAssertEqual(fixture.state.value.withLock { $0.messages.count }, 1)
    store.startNewChat()
    XCTAssertEqual(store.newChatDraft, "")
  }

  func testFailedCreationPreservesTheFirstMessageWhenDefaultDraftLoadsDuringSend() async throws {
    let creating = expectation(description: "First chat creation is pending")
    let gate = AsyncStream<Void>.makeStream()
    defer { gate.continuation.finish() }
    let fixture = AttachmentFlowFixture(creation: {
      creating.fulfill()
      for await _ in gate.stream {}
      return false
    })
    let store = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { store.close() }
    store.newChatDraft = "Keep the first message for retry"
    let sending = Task { await store.sendNewChat() }
    addTeardownBlock { @MainActor in
      store.close()
      sending.cancel()
      gate.continuation.finish()
      await sending.value
    }
    await fulfillment(of: [creating], timeout: 3)
    await store.prepareWorkspaceComposer()
    gate.continuation.finish()
    await sending.value
    XCTAssertEqual(store.newChatDraft, "Keep the first message for retry")
    XCTAssertNil(store.selectedThreadID)
    XCTAssertNotNil(store.error)
  }

  func testFailedChatAccountWriteKeepsDraftAndAttachmentUntilTheChoiceIsCorrected() async throws {
    let accountID = ConnectorHTTPFixtures.accountID
    let rejected = Mutex(0)
    let message = "Chat or connector account not found"
    let fixture = AttachmentFlowFixture(connectorSettings: { request in
      switch request.url?.path {
      case "/api/chat-connector-overview":
        return ChatHTTPResponse(body: ConnectorHTTPFixtures.composerOverview())
      case "/api/chat-threads/\(AttachmentFlowFixture.threadID)/connector-access/\(accountID)":
        let body =
          try JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any]
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(body?["enabled"] as? Bool, false)
        rejected.withLock { $0 += 1 }
        return ChatHTTPResponse(
          status: 404,
          body: """
            {"error":{"code":"NOT_FOUND","message":"\(message)"}}
            """)
      case "/api/chat-threads/\(AttachmentFlowFixture.threadID)/connector-current":
        let choice = try JSONDecoder().decode(
          ChatConnectorSelection.self, from: chatRequestBody(request))
        XCTAssertEqual(choice.connectionId, accountID)
        return ChatHTTPResponse(body: ConnectorHTTPFixtures.access())
      default: throw URLError(.unsupportedURL)
      }
    })
    let store = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    store.newChatDraft = "Use my selected Slack account"
    let source = try makeFile()
    defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
    store.newAttachmentDraft.importFiles([source])
    try await waitForBusinessResult(watching: store.newComposer) {
      store.newAttachmentDraft.hasAttachments && store.newAttachmentDraft.isReady
    }
    let connectors = store.newModelSelection.connectors
    await connectors.refresh()
    await connectors.setAccountAccess(
      target: .builtin("slack"), connectionID: accountID, enabled: false)

    await store.sendNewChat()

    XCTAssertEqual(store.error, message)
    XCTAssertNil(store.selectedThreadID)
    XCTAssertEqual(store.newChatDraft, "Use my selected Slack account")
    XCTAssertEqual(store.newAttachmentDraft.items.first?.file.filename, "notes.txt")
    XCTAssertTrue(store.newAttachmentDraft.isReady)
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })
    XCTAssertEqual(rejected.withLock { $0 }, 1)

    await connectors.setAccountAccess(
      target: .builtin("slack"), connectionID: accountID, enabled: nil)
    await store.sendNewChat()

    XCTAssertEqual(store.selectedThreadID, AttachmentFlowFixture.threadID)
    let sent = try fixture.state.value.withLock {
      try $0.messages.map { try JSONDecoder().decode(AttachmentFlowFixture.Message.self, from: $0) }
    }
    XCTAssertEqual(sent.count, 1)
    XCTAssertEqual(sent.first?.userMessage.parts.last?.filenameSnapshot, "notes.txt")
    XCTAssertEqual(rejected.withLock { $0 }, 1)
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
    try await waitForBusinessResult(watching: store.newComposer) {
      !store.newAttachmentDraft.items.isEmpty && store.newAttachmentDraft.isReady
    }
    let operation = Task { await store.sendNewChat() }
    addTeardownBlock { @MainActor in
      store.close()
      operation.cancel()
      continuation.finish()
      await operation.value
    }
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

@MainActor
extension XCTestCase {

  fileprivate func previewURL(in viewer: MessageAttachmentStore) async throws -> URL {
    let preview = try XCTUnwrap(viewer.preview)
    let file = try await preview.store.get(preview.file).value
    return try XCTUnwrap(file?.url)
  }

  fileprivate func makeFile(filename: String = "notes.txt", content: Data = Data("notes".utf8))
    throws
    -> URL
  {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent(filename)
    try content.write(to: file)
    return file
  }
}
