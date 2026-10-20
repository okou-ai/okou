import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ComposerDraftTests: XCTestCase {
  func testRestartRestoresTextUploadedFilesAndRichDocumentWithoutCreatingAThread() async throws {
    let server = DraftServer(remote: try richDraft())
    let storage = server.storage()
    let first = server.composer(storage: storage)
    await first.synchronize()
    try await eventually { first.attachments.isReady }
    XCTAssertEqual(first.text, "Review this ")
    XCTAssertEqual(first.contextLabels, ["Plan"])
    first.text = "Review this carefully"
    await first.synchronize()
    let saved = server.state.value.withLock { $0.remote }
    XCTAssertEqual(
      saved.draftUserMessage?.parts.filter { $0["type"]?.string != "text" },
      try richDraft().draftUserMessage?.parts.filter { $0["type"]?.string != "text" })
    first.close()
    let reopened = server.composer(storage: storage)
    defer { reopened.close() }
    XCTAssertEqual(reopened.text, "Review this carefully")
    try await eventually { reopened.attachments.isReady }
    XCTAssertEqual(reopened.attachments.uploaded.first?.id, "file")
    XCTAssertEqual(reopened.value, saved)
    XCTAssertTrue(server.state.value.withLock { $0.paths.allSatisfy { !$0.contains("POST") } })
  }

  func testCancelledDraftOpeningDoesNotStartRemoteRequests() async {
    let server = DraftServer()
    let composer = server.composer()
    defer { composer.close() }
    let opening = Task { await composer.synchronize() }
    opening.cancel()
    await opening.value
    XCTAssertTrue(server.state.value.withLock { $0.paths.isEmpty })
  }

  func testTypingDuringLateRemoteLoadKeepsLocalInputAndClearCannotResurrectRemote() async throws {
    for clear in [false, true] {
      let gate = DraftGate()
      let started = expectation(description: "Draft request started")
      let server = DraftServer(
        remote: textDraft("Remote"),
        onRead: {
          started.fulfill()
          await gate.wait()
        })
      let composer = server.composer()
      defer {
        composer.close()
        gate.open()
      }
      let loading = Task { await composer.synchronize() }
      await fulfillment(of: [started], timeout: 2)
      composer.text = "Local typing"
      if clear { composer.clear() }
      gate.open()
      await loading.value
      XCTAssertEqual(composer.text, clear ? "" : "Local typing")
      XCTAssertEqual(
        server.state.value.withLock { $0.remote.draftUserMessage?.text ?? "" }, composer.text)
    }
  }

  func testTypingDuringReconnectKeepsLocalInputWithoutOverwritingAKnownRemoteChange() async throws {
    let gate = DraftGate()
    let started = expectation(description: "Reconnect draft read")
    let count = DraftReadCount()
    let server = DraftServer(
      remote: textDraft("Baseline"),
      onRead: {
        let index = count.value.withLock {
          $0 += 1
          return $0
        }
        if index == 2 {
          started.fulfill()
          await gate.wait()
        }
      })
    let composer = server.composer()
    defer {
      composer.close()
      gate.open()
    }
    await composer.synchronize()
    composer.text = "Local offline edit"
    server.state.value.withLock { $0.remote = textDraft("New edit from PWA") }
    let reconnect = Task { await composer.synchronize() }
    await fulfillment(of: [started], timeout: 2)
    composer.text = "Local typing continues"
    gate.open()
    await reconnect.value
    XCTAssertEqual(composer.text, "Local typing continues")
    XCTAssertNotNil(composer.conflictingRemote)
    XCTAssertEqual(
      server.state.value.withLock { $0.remote.draftUserMessage?.text }, "New edit from PWA")
  }

  func testOldSaveResponseCannotReplaceNewInputAndClearsAreSerializedAfterWrites() async throws {
    let saving = expectation(description: "Save is in flight")
    let gate = DraftGate()
    let server = DraftServer(onWrite: { index in
      if index == 1 {
        saving.fulfill()
        await gate.wait()
      }
    })
    let composer = server.composer()
    defer {
      composer.close()
      gate.open()
    }
    await composer.synchronize()
    composer.text = "Older save"
    let task = Task { await composer.synchronize() }
    await fulfillment(of: [saving], timeout: 2)
    composer.text = "New input"
    composer.clear()
    composer.text = "Final input"
    gate.open()
    await task.value
    XCTAssertEqual(composer.text, "Final input")
    XCTAssertEqual(server.state.value.withLock { $0.remote.draftUserMessage?.text }, "Final input")
    composer.clear()
    await composer.synchronize()
    XCTAssertEqual(server.state.value.withLock { $0.remote }, ComposerDraft())
  }

  func testOfflineReopenSynchronizesLocalDraftAndDetectsOtherDeviceChanges() async throws {
    let server = DraftServer()
    let storage = server.storage()
    let composer = server.composer(storage: storage)
    await composer.synchronize()
    server.state.value.withLock { $0.offline = true }
    composer.text = "Local offline draft"
    await composer.synchronize()
    XCTAssertNotNil(composer.error)
    composer.close()
    let reopened = server.composer(storage: storage)
    defer { reopened.close() }
    XCTAssertEqual(reopened.text, "Local offline draft")
    server.state.value.withLock { $0.offline = false }
    await reopened.synchronize()
    XCTAssertEqual(
      server.state.value.withLock { $0.remote.draftUserMessage?.text }, "Local offline draft")
    reopened.text = "New local work"
    server.state.value.withLock { $0.remote = textDraft("Other device") }
    await reopened.synchronize()
    XCTAssertNotNil(reopened.conflictingRemote)
    XCTAssertEqual(reopened.text, "New local work")
    XCTAssertEqual(server.state.value.withLock { $0.remote.draftUserMessage?.text }, "Other device")
    reopened.useRemote()
    XCTAssertEqual(reopened.text, "Other device")
  }

  func testOfflineClearSurvivesRestartAndCannotResurrectTheSentDraft() async throws {
    let server = DraftServer(remote: textDraft("Send me"))
    let storage = server.storage()
    let composer = server.composer(storage: storage)
    await composer.synchronize()
    server.state.value.withLock { $0.offline = true }
    composer.clear()
    await composer.synchronize()
    composer.close()
    let reopened = server.composer(storage: storage)
    defer { reopened.close() }
    XCTAssertEqual(reopened.text, "")
    server.state.value.withLock { $0.offline = false }
    await reopened.synchronize()
    XCTAssertEqual(server.state.value.withLock { $0.remote }, ComposerDraft())
  }

  func testUnreadableDeviceDraftIsNotReplacedByAnEmptyDefault() async throws {
    let server = DraftServer()
    let storage = server.storage()
    let key = ChatDraftTarget.agent(draftAgentID).key
    try storage.save("unreadable draft record", key: key)
    let composer = server.composer(storage: storage)
    XCTAssertNotNil(composer.error)
    XCTAssertFalse(composer.canSend)
    await composer.synchronize()
    composer.text = "New input remains in memory"
    composer.close()
    XCTAssertEqual(try storage.load(key, as: String.self), "unreadable draft record")
    XCTAssertTrue(server.state.value.withLock { $0.paths.isEmpty })
  }

  func testAcknowledgedClearDoesNotReviveAnOldRemoteDraftAfterRestart() async throws {
    let server = DraftServer(remote: textDraft("Old draft"))
    let storage = server.storage()
    let composer = server.composer(storage: storage)
    await composer.synchronize()
    composer.clear()
    await composer.synchronize()
    composer.close()
    server.state.value.withLock { $0.remote = textDraft("Old draft") }
    let reopened = server.composer(storage: storage)
    defer { reopened.close() }
    await reopened.synchronize()
    XCTAssertEqual(reopened.text, "")
    XCTAssertNotNil(reopened.conflictingRemote)
    reopened.keepLocal()
    await reopened.synchronize()
    XCTAssertEqual(server.state.value.withLock { $0.remote }, ComposerDraft())
  }

  func testUnavailableRemoteAttachmentRetainsCanonicalPartUntilExplicitRemoval() async throws {
    let server = DraftServer(remote: try richDraft())
    server.state.value.withLock { $0.missingFile = true }
    let composer = server.composer()
    defer { composer.close() }
    await composer.synchronize()
    try await eventually {
      composer.attachments.items.contains { if case .failed = $0.state { true } else { false } }
    }
    XCTAssertFalse(composer.canSend)
    composer.text = "Keep the attachment context"
    await composer.synchronize()
    XCTAssertTrue(
      server.state.value.withLock {
        $0.remote.draftUserMessage!.parts.contains { $0["fileId"]?.string == "file" }
      })
    let file = try XCTUnwrap(composer.attachments.items.first)
    composer.attachments.remove(file.id)
    await composer.synchronize()
    XCTAssertFalse(
      server.state.value.withLock {
        $0.remote.draftUserMessage!.parts.contains { $0["type"]?.string == "file" }
      })
    XCTAssertNil(server.state.value.withLock { $0.remote.draftAttachments })
    XCTAssertTrue(composer.canSend)
  }

  func testRemoteMetadataCannotOwnOrRemoveADeviceFile() async throws {
    let server = DraftServer()
    let source = server.directory.appendingPathComponent("provider-file.txt")
    try Data("Keep provider-owned bytes".utf8).write(to: source)
    var remote = try richDraft()
    let file = try XCTUnwrap(remote.draftAttachments?.first?.attachment)
    remote.draftAttachments = [.init(attachment: file, url: source.absoluteString)]
    server.state.value.withLock { $0.remote = remote }
    let composer = server.composer()
    await composer.synchronize()
    XCTAssertFalse(composer.canSend)
    XCTAssertNotNil(composer.attachments.error)
    composer.clear()
    composer.close()
    XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
  }

  func testInterruptedLocalFileIsNeverRestoredAsUploadedAndMissingFileRetryFails() async throws {
    let server = DraftServer()
    let storage = server.storage()
    let source = server.directory.appendingPathComponent("local.txt")
    try Data("local".utf8).write(to: source)
    let composer = server.composer(storage: storage)
    composer.attachments.importFiles([source])
    try await eventually {
      composer.attachments.items.contains { if case .failed = $0.state { true } else { false } }
    }
    let copied = try XCTUnwrap(composer.attachments.items.first?.file.url)
    composer.close()
    XCTAssertTrue(FileManager.default.fileExists(atPath: copied.path))
    try FileManager.default.removeItem(at: copied)
    let reopened = server.composer(storage: storage)
    defer {
      reopened.clear()
      reopened.close()
    }
    XCTAssertTrue(reopened.attachments.uploaded.isEmpty)
    XCTAssertFalse(reopened.attachments.isReady)
    let item = try XCTUnwrap(reopened.attachments.items.first)
    reopened.attachments.retry(item.id)
    try await eventually {
      reopened.attachments.items.contains { if case .failed = $0.state { true } else { false } }
    }
    XCTAssertTrue(reopened.attachments.uploaded.isEmpty)
  }

  func testNativeComposerPreviewShowsRestoredContextAndConflictActions() async throws {
    let server = DraftServer(remote: try richDraft())
    let composer = server.composer()
    defer { composer.close() }
    await composer.synchronize()
    composer.text = "Saved draft after restart"
    server.state.value.withLock { $0.remote = textDraft("Edited on PWA") }
    await composer.synchronize()
    let host = UIHostingController(
      rootView: ChatComposerView(
        draft: Binding(get: { composer.text }, set: { composer.text = $0 }),
        isBusy: false, showsProgress: false, canStop: false, needsUpgrade: false,
        error: nil, attachmentURL: server.http.baseURL, attachments: composer.attachments,
        supportsAttachments: true, draftState: composer, submit: {}, refresh: nil))
    XCTAssertNotNil(composer.conflictingRemote)
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    host.view.layoutIfNeeded()
    await Task.yield()
    defer { unmount(window) }
    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = "Restored draft and cross-device choice"
    attachment.lifetime = .keepAlways
    add(attachment)
    XCTAssertNotNil(composer.conflictingRemote)
  }
}

private func textDraft(_ text: String) -> ComposerDraft {
  var document = ChatDraftDocument()
  document.replaceText(text)
  return ComposerDraft(document: document)
}

private func richDraft() throws -> ComposerDraft {
  try JSONDecoder().decode(
    ComposerDraft.self,
    from: Data(
      #"{"draftUserMessage":{"version":1,"parts":[{"type":"text","text":"Review this "},{"type":"chat_thread","threadId":"43000000-0000-4000-8000-000000000001","titleSnapshot":"Plan"},{"type":"file","fileId":"file","filenameSnapshot":"notes.txt","contentType":"text/plain","annotatedFileId":"annotated","annotations":{"marks":[]}}]},"draftAttachments":[{"id":"file","url":"artifact://file","filename":"notes.txt","contentType":"text/plain","size":5}]}"#
        .utf8))
}

private final class DraftServer: Sendable {
  struct State: Sendable {
    var remote = ComposerDraft()
    var offline = false
    var missingFile = false
    var paths: [String] = []
    var writes = 0
  }
  let state: DraftServerState
  let http: ChatHTTPFixture
  let directory: URL
  init(
    remote: ComposerDraft = ComposerDraft(), onRead: @escaping @Sendable () async -> Void = {},
    onWrite: @escaping @Sendable (Int) async -> Void = { _ in }
  ) {
    let state = DraftServerState(remote: remote)
    self.state = state
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    http = ChatHTTPFixture { request in
      let path = request.url!.path
      let offline = state.value.withLock { value in
        value.paths.append(request.httpMethod! + " " + path)
        return value.offline
      }
      if offline { throw URLError(.notConnectedToInternet) }
      if path == "/api/web/file-url" {
        return ChatHTTPResponse(
          status: state.value.withLock { $0.missingFile } ? 404 : 200, body: "{}")
      }
      guard path == "/api/agents/\(draftAgentID)/draft" else { throw URLError(.unsupportedURL) }
      if request.httpMethod == "PATCH" {
        let index = state.value.withLock { value in
          value.writes += 1
          return value.writes
        }
        await onWrite(index)
        let draft = try JSONDecoder().decode(ComposerDraft.self, from: chatRequestBody(request))
        state.value.withLock { $0.remote = draft }
        return ChatHTTPResponse(status: 204, body: "")
      }
      let remote = state.value.withLock { $0.remote }
      await onRead()
      return ChatHTTPResponse(
        body: String(decoding: try JSONEncoder().encode(remote), as: UTF8.self))
    }
  }
  deinit { try? FileManager.default.removeItem(at: directory) }
  func storage() -> ChatDraftStorage {
    ChatDraftStorage(
      scope: ChatCacheScope(apiBaseURL: http.baseURL, userID: "user", workspaceID: "org"),
      directory: directory)
  }
  @MainActor func composer(storage: ChatDraftStorage? = nil) -> ComposerDraftStore {
    ComposerDraftStore(
      target: .agent(draftAgentID),
      commands: ChatCommands(client: http.client, sync: ChatSync(client: http.client)),
      repository: ChatDraftRepository(client: http.client), storage: storage, didFail: { _ in })
  }
}

private final class DraftGate: Sendable {
  let stream: AsyncStream<Void>
  let continuation: AsyncStream<Void>.Continuation
  init() { (stream, continuation) = AsyncStream.makeStream() }
  func wait() async { for await _ in stream { return } }
  func open() { continuation.finish() }
}

private final class DraftServerState: Sendable {
  let value: Mutex<DraftServer.State>
  init(remote: ComposerDraft) { value = Mutex(DraftServer.State(remote: remote)) }
}

private let draftAgentID = "43000000-0000-4000-8000-000000000002"

private final class DraftReadCount: Sendable { let value = Mutex(0) }
