import ChatData
import ChatDomain
import SwiftUI
import Synchronization
import UniformTypeIdentifiers
import XCTest

@testable import Okou

@MainActor
final class ChatComposerPasteTests: XCTestCase {
  func testSystemPasteUploadsMixedImagesAndReplacesSelectedTextOnce() async throws {
    preserveNativePasteboard(for: self)
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    conversation.draft = "Before old after"
    let host = UIHostingController(rootView: composer(conversation))
    let window = try await mount(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(textView(in: host.view))
    input.becomeFirstResponder()
    // The editing menu operates after native focus and SwiftUI expansion settle.
    // Wait before setting the selection so the focus handoff cannot replace it.
    try await eventually(
      message: "Composer did not focus and expand: firstResponder=\(input.isFirstResponder), "
        + "bounds=\(input.bounds), attached=\(input.window === window), "
        + "current=\(self.textView(in: host.view) === input)"
    ) {
      input.isFirstResponder && input.bounds.height >= (input.font?.lineHeight ?? 20) * 2 - 1
    }
    input.selectedRange = NSRange(location: 7, length: 3)
    let png = imageData()
    // This is the test device's pasteboard; no host clipboard or logged-in device is used.
    UIPasteboard.general.setItems(
      [
        [UTType.utf8PlainText.identifier: Data("pasted".utf8), UTType.png.identifier: png],
        [UTType.png.identifier: png],
      ], options: [.localOnly: true])
    input.paste(nil)
    try await eventually(
      message: "Mixed paste not ready: draft=\(conversation.draft), "
        + "items=\(conversation.attachmentDraft.items.count), "
        + "importing=\(conversation.attachmentDraft.importingCount), "
        + "error=\(String(describing: conversation.attachmentDraft.error))"
    ) {
      conversation.draft == "Before pasted after"
        && conversation.attachmentDraft.items.count == 2 && conversation.attachmentDraft.isReady
    }
    try await eventually {
      input.isFirstResponder && input.bounds.height >= (input.font?.lineHeight ?? 20) * 2 - 1
    }
    let requests = fixture.state.value.withLock { $0.preparations }
    XCTAssertEqual(requests.count, 2)
    for request in requests {
      let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request) as? [String: Any])
      XCTAssertEqual(body["contentType"] as? String, "image/png")
      XCTAssertEqual(body["size"] as? Int, png.count)
      XCTAssertTrue((body["filename"] as? String)?.hasSuffix(".png") == true)
    }
    for item in conversation.attachmentDraft.items {
      XCTAssertEqual(try Data(contentsOf: item.file.url), png)
      XCTAssertNotNil(item.file.thumbnail)
    }
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })
    attach(window, name: "Mixed image paste in the native composer")
    await conversation.send()
    XCTAssertEqual(fixture.state.value.withLock { $0.messages.count }, 1)
    XCTAssertFalse(conversation.attachmentDraft.hasAttachments)
  }

  func testRepeatedProviderInOnePasteUploadsOnceAndCanBeExplicitlyPastedAgain() async throws {
    let fixture = AttachmentFlowFixture(failUpload: true)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let file = try makeImage()
    defer { try? FileManager.default.removeItem(at: file) }
    let host = UIHostingController(rootView: composer(conversation))
    let window = try await mount(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(textView(in: host.view))
    let provider = try XCTUnwrap(NSItemProvider(contentsOf: file))
    input.paste(itemProviders: [provider, provider])
    try await eventually {
      conversation.attachmentDraft.items.contains {
        if case .failed = $0.state { true } else { false }
      }
    }
    XCTAssertEqual(fixture.state.value.withLock { $0.preparations.count }, 1)
    let item = try XCTUnwrap(conversation.attachmentDraft.items.first)
    conversation.attachmentDraft.retry(item.id)
    try await eventually { conversation.attachmentDraft.isReady }
    input.paste(itemProviders: [provider])
    try await eventually {
      conversation.attachmentDraft.items.count == 2 && conversation.attachmentDraft.isReady
    }
    XCTAssertEqual(fixture.state.value.withLock { $0.preparations.count }, 3)
    XCTAssertEqual(conversation.draft, "")
    conversation.attachmentDraft.remove(item.id)
    XCTAssertFalse(FileManager.default.fileExists(atPath: item.file.url.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
  }

  func testLateProviderCannotEnterReplacementWorkspaceDraft() async throws {
    let fixture = AttachmentFlowFixture()
    let oldWorkspace = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    let replacement = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer {
      oldWorkspace.close()
      replacement.close()
    }
    let file = try makeImage()
    defer { try? FileManager.default.removeItem(at: file) }
    let started = expectation(description: "Image provider started")
    let completed = expectation(description: "Image provider completed after workspace close")
    let (stream, continuation) = AsyncStream<Void>.makeStream()
    defer { continuation.finish() }
    let provider = NSItemProvider()
    provider.registerFileRepresentation(
      forTypeIdentifier: UTType.png.identifier, fileOptions: [], visibility: .all
    ) {
      callback in
      started.fulfill()
      Task {
        for await _ in stream { break }
        callback(file, false, nil)
        completed.fulfill()
      }
      return Progress(totalUnitCount: 1)
    }
    oldWorkspace.newAttachmentDraft.importPastedImages([provider])
    await fulfillment(of: [started], timeout: 3)
    XCTAssertFalse(oldWorkspace.newAttachmentDraft.isReady)
    oldWorkspace.close()
    continuation.yield()
    await fulfillment(of: [completed], timeout: 3)
    XCTAssertFalse(replacement.newAttachmentDraft.hasAttachments)
    XCTAssertFalse(oldWorkspace.newAttachmentDraft.hasAttachments)
    XCTAssertTrue(fixture.state.value.withLock { $0.preparations.isEmpty })
  }

  func testResettingAgentDraftDetachesALateMixedTextPaste() async throws {
    let fixture = AttachmentFlowFixture()
    let workspace = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { workspace.close() }
    workspace.selectedAgentID = AttachmentFlowFixture.agentID
    let originalComposer = workspace.newComposer
    let host = UIHostingController(rootView: WorkspacePasteComposerHarness(workspace: workspace))
    let window = try await mount(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(textView(in: host.view))
    input.becomeFirstResponder()
    let file = try makeImage()
    defer { try? FileManager.default.removeItem(at: file) }
    let started = expectation(description: "Mixed text provider started")
    let (stream, continuation) = AsyncStream<Void>.makeStream()
    defer { continuation.finish() }
    let provider = NSItemProvider()
    provider.registerFileRepresentation(
      forTypeIdentifier: UTType.png.identifier, fileOptions: [], visibility: .all
    ) {
      callback in
      callback(file, false, nil)
      return Progress(totalUnitCount: 1)
    }
    provider.registerDataRepresentation(
      forTypeIdentifier: UTType.utf8PlainText.identifier, visibility: .all
    ) {
      callback in
      started.fulfill()
      Task {
        for await _ in stream { break }
        callback(Data("late text".utf8), nil)
      }
      return Progress(totalUnitCount: 1)
    }
    input.paste(itemProviders: [provider])
    await fulfillment(of: [started], timeout: 3)
    workspace.startNewChat(agentID: "another-agent")
    input.insertText("stale edit")
    XCTAssertEqual(workspace.newChatDraft, "")
    XCTAssertTrue(originalComposer.text.contains("stale edit"))
    try await eventually { self.textView(in: host.view) !== input && input.delegate == nil }
    continuation.yield()
    // Wait until UIKit has resolved the old paste, rather than waiting a fixed delay.
    try await eventually { input.text.contains("late text") }
    XCTAssertEqual(workspace.newChatDraft, "")
    XCTAssertFalse(workspace.newAttachmentDraft.hasAttachments)
  }

  func testSwitchingConversationsKeepsPendingImageInItsOriginalDraft() async throws {
    let originalFixture = AttachmentFlowFixture()
    let nextFixture = AttachmentFlowFixture()
    let original = originalFixture.conversation()
    let next = nextFixture.conversation()
    defer {
      original.close()
      next.close()
    }
    let host = UIHostingController(rootView: composer(original))
    let window = try await mount(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(textView(in: host.view))
    let file = try makeImage()
    defer { try? FileManager.default.removeItem(at: file) }
    let started = expectation(description: "Image requested in original conversation")
    let (stream, continuation) = AsyncStream<Void>.makeStream()
    defer { continuation.finish() }
    let provider = NSItemProvider()
    provider.registerFileRepresentation(
      forTypeIdentifier: UTType.png.identifier, fileOptions: [], visibility: .all
    ) {
      callback in
      started.fulfill()
      Task {
        for await _ in stream { break }
        callback(file, false, nil)
      }
      return Progress(totalUnitCount: 1)
    }
    input.paste(itemProviders: [provider])
    await fulfillment(of: [started], timeout: 3)
    host.rootView = composer(next)
    try await eventually { self.textView(in: host.view) !== input }
    continuation.yield()
    try await eventually {
      original.attachmentDraft.hasAttachments && original.attachmentDraft.isReady
    }
    XCTAssertFalse(next.attachmentDraft.hasAttachments)
    XCTAssertEqual(originalFixture.state.value.withLock { $0.preparations.count }, 1)
    XCTAssertTrue(nextFixture.state.value.withLock { $0.preparations.isEmpty })
    XCTAssertTrue(originalFixture.state.value.withLock { $0.messages.isEmpty })
  }

  func testOversizedPastedImagePreservesSelectionAndDoesNotAllocateUpload() async throws {
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    conversation.draft = "Keep selected text"
    let host = UIHostingController(rootView: composer(conversation))
    let window = try await mount(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(textView(in: host.view))
    input.becomeFirstResponder()
    input.selectedRange = NSRange(location: 5, length: 8)
    let file = try makeImage()
    defer { try? FileManager.default.removeItem(at: file) }
    let handle = try FileHandle(forWritingTo: file)
    try handle.truncate(atOffset: UInt64(ChatAttachment.maximumSize + 1))
    try handle.close()
    let provider = NSItemProvider()
    provider.registerFileRepresentation(
      forTypeIdentifier: UTType.png.identifier, fileOptions: .openInPlace, visibility: .all
    ) { callback in
      callback(file, true, nil)
      return Progress(totalUnitCount: 1)
    }
    input.paste(itemProviders: [provider])
    try await eventually { conversation.attachmentDraft.error?.contains("1 GB") == true }
    XCTAssertEqual(conversation.draft, "Keep selected text")
    XCTAssertEqual(input.selectedRange, NSRange(location: 5, length: 8))
    XCTAssertFalse(conversation.attachmentDraft.hasAttachments)
    XCTAssertTrue(fixture.state.value.withLock { $0.preparations.isEmpty })
  }

  func testRetiredNativeEditorCannotChangeAClearedDraftBeforeDismantling() async throws {
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    conversation.draft = "Old draft"
    let host = UIHostingController(rootView: composer(conversation))
    let window = try await mount(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(textView(in: host.view))
    input.becomeFirstResponder()
    // Clear only after SwiftUI has presented the native focus change. UIKit's
    // immediate first-responder result alone precedes the composer's focus handoff.
    try await eventually {
      input.isFirstResponder && input.bounds.height >= (input.font?.lineHeight ?? 20) * 2 - 1
    }
    conversation.composer.clear()
    input.insertText("stale callback")
    XCTAssertEqual(conversation.draft, "")
    XCTAssertTrue(input.text.contains("stale callback"))
    try await eventually(
      message:
        "Replacement: same=\(self.textView(in: host.view) === input), focused=\(self.textView(in: host.view)?.isFirstResponder == true), text=\(self.textView(in: host.view)?.text ?? "<missing>"), key=\(window.isKeyWindow)"
    ) {
      guard let replacement = self.textView(in: host.view) else { return false }
      return replacement !== input && !replacement.isFirstResponder && replacement.text.isEmpty
    }
  }

  func testRemoteHydrationCannotCancelAnImagePasteBeforeItsFileArrives() async throws {
    let reading = expectation(description: "Draft hydration started")
    let loading = expectation(description: "Image provider started")
    let (readStream, readGate) = AsyncStream<Void>.makeStream()
    let (imageStream, imageGate) = AsyncStream<Void>.makeStream()
    defer {
      readGate.finish()
      imageGate.finish()
    }
    let reads = Mutex(0)
    let fixture = AttachmentFlowFixture(draftRead: {
      let first = reads.withLock {
        $0 += 1
        return $0 == 1
      }
      guard first else { return }
      reading.fulfill()
      for await _ in readStream { break }
    })
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: fixture.http.baseURL, userID: "paste-user", workspaceID: "paste-workspace"),
      directory: directory)
    let repository = ChatDraftRepository(client: fixture.http.client)
    var document = ChatDraftDocument()
    document.replaceText("Saved on another device")
    let remote = ComposerDraft(document: document)
    try await repository.save(remote, to: .thread(AttachmentFlowFixture.threadID))
    let conversation = fixture.conversation(storage: storage)
    defer {
      conversation.composer.clear()
      conversation.close()
    }
    let host = UIHostingController(rootView: composer(conversation))
    let window = try await mount(host)
    defer { unmount(window) }
    let synchronization = Task { await conversation.composer.synchronize() }
    await fulfillment(of: [reading], timeout: 3)
    let file = try makeImage()
    defer { try? FileManager.default.removeItem(at: file) }
    let provider = NSItemProvider()
    provider.registerFileRepresentation(
      forTypeIdentifier: UTType.png.identifier, fileOptions: .openInPlace, visibility: .all
    ) { callback in
      loading.fulfill()
      Task {
        for await _ in imageStream { break }
        callback(file, true, nil)
      }
      return Progress(totalUnitCount: 1)
    }
    let input = try XCTUnwrap(textView(in: host.view))
    input.paste(itemProviders: [provider])
    await fulfillment(of: [loading], timeout: 3)
    readGate.yield()
    await synchronization.value
    imageGate.yield()
    try await eventually {
      conversation.attachmentDraft.hasAttachments && conversation.attachmentDraft.isReady
        && fixture.state.value.withLock { $0.preparations.count == 1 }
    }
    let unchanged = try await repository.load(.thread(AttachmentFlowFixture.threadID))
    XCTAssertEqual(unchanged, remote)
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })
    conversation.composer.keepLocal()
    await conversation.composer.synchronize()
    let saved = try await repository.load(.thread(AttachmentFlowFixture.threadID))
    XCTAssertTrue(
      saved.draftUserMessage?.parts.contains {
        $0["type"]?.string == "file" && $0["fileId"]?.string == AttachmentFlowFixture.fileID
      } == true)
    XCTAssertEqual(saved.draftAttachments?.first?.id, AttachmentFlowFixture.fileID)
  }

  private func mount<V: View>(_ host: UIHostingController<V>) async throws -> UIWindow {
    let window = try await mountNativeHost(host) { _ in
      self.textView(in: host.view)?.bounds.isEmpty == false
    }
    // SwiftUI can lay out the editor before presenting its initial unfocused state.
    // Native focus requests belong after that presentation, as with a user's first tap.
    await hostingPresentationFrame()
    return window
  }

  private func composer(_ conversation: ConversationStore)
    -> some View
  {
    ChatComposerView(
      draft: Binding(get: { conversation.draft }, set: { conversation.draft = $0 }),
      isBusy: false, showsProgress: false, canStop: false, needsUpgrade: false,
      error: nil, attachmentURL: URL(string: "https://app.example.invalid")!,
      attachments: conversation.attachmentDraft,
      draftState: conversation.composer,
      submit: { await conversation.send() }, refresh: nil)
  }

  private func imageData() -> Data {
    UIGraphicsImageRenderer(size: CGSize(width: 80, height: 60)).pngData { context in
      UIColor.systemTeal.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 80, height: 60))
    }
  }

  private func makeImage() throws -> URL {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(
      "Screenshot-\(UUID()).png")
    try imageData().write(to: file)
    return file
  }

  private func textView(in view: UIView) -> ComposerTextView? {
    if let input = view as? ComposerTextView { return input }
    return view.subviews.lazy.compactMap { self.textView(in: $0) }.first
  }

  private func attach(_ window: UIWindow, name: String) {
    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}

private struct WorkspacePasteComposerHarness: View {
  let workspace: WorkspaceStore

  var body: some View {
    @Bindable var composer = workspace.newComposer
    ChatComposerView(
      draft: $composer.text,
      isBusy: false, showsProgress: false, canStop: false, needsUpgrade: false,
      error: nil, attachmentURL: workspace.webURL, attachments: composer.attachments,
      draftState: composer, submit: {}, refresh: nil)
  }
}
