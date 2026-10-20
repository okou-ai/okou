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
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    conversation.draft = "Before old after"
    let host = UIHostingController(rootView: composer(conversation))
    let window = try await mount(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(textView(in: host.view))
    input.becomeFirstResponder()
    input.selectedRange = NSRange(location: 7, length: 3)
    let png = imageData()
    // This is the test device's pasteboard; no host clipboard or logged-in device is used.
    UIPasteboard.general.setItems(
      [
        [UTType.utf8PlainText.identifier: Data("pasted".utf8), UTType.png.identifier: png],
        [UTType.png.identifier: png],
      ], options: [.localOnly: true])
    defer { UIPasteboard.general.items = [] }
    input.paste(nil)
    try await eventually {
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

  func testImageOnlySystemPasteCanSendWithoutText() async throws {
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let host = UIHostingController(rootView: composer(conversation))
    let window = try await mount(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(textView(in: host.view))
    input.becomeFirstResponder()
    UIPasteboard.general.setItems(
      [[UTType.png.identifier: imageData()]], options: [.localOnly: true])
    defer { UIPasteboard.general.items = [] }
    XCTAssertTrue(
      input.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil))
    input.paste(nil)
    try await eventually {
      conversation.attachmentDraft.hasAttachments && conversation.attachmentDraft.isReady
    }
    XCTAssertEqual(conversation.draft, "")
    await conversation.send()
    let requests = fixture.state.value.withLock { $0.messages }
    XCTAssertEqual(requests.count, 1)
    let message = try JSONDecoder().decode(
      AttachmentFlowFixture.Message.self, from: XCTUnwrap(requests.first))
    XCTAssertFalse(message.hasTextContent)
    try await eventually { self.textView(in: host.view)?.isFirstResponder == true }
  }

  func testPlainTextSelectionUndoAndMarkedTextRemainNative() async throws {
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    conversation.draft = "Before old after"
    let host = UIHostingController(rootView: composer(conversation))
    let window = try await mount(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(textView(in: host.view))
    let compactHeight = input.bounds.height
    input.becomeFirstResponder()
    input.selectedRange = NSRange(location: 7, length: 3)
    UIPasteboard.general.setItems(
      [
        [UTType.utf8PlainText.identifier: Data("first\nsecond".utf8)]
      ], options: [.localOnly: true])
    defer { UIPasteboard.general.items = [] }
    input.paste(nil)
    try await eventually { conversation.draft == "Before first\nsecond after" }
    XCTAssertEqual(input.selectedRange.location, 19)
    input.undoManager?.undo()
    try await eventually { conversation.draft == "Before old after" }
    input.selectedRange = NSRange(location: 7, length: 3)
    input.setMarkedText("拼音", selectedRange: NSRange(location: 2, length: 0))
    try await eventually { input.markedTextRange != nil }
    XCTAssertTrue(input.isFirstResponder)
    input.unmarkText()
    input.insertText("\nNext line")
    try await eventually { conversation.draft.contains("Next line") }
    XCTAssertTrue(conversation.attachmentDraft.items.isEmpty)
    try await eventually {
      input.bounds.height > compactHeight
        && input.bounds.height >= (input.font?.lineHeight ?? 20) * 2 - 1
    }
    XCTAssertEqual(input.font?.pointSize, 16)
    XCTAssertEqual(input.textContainerInset, .zero)
    attach(window, name: "Focused multiline native composer")
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

  func testFeatureSwitchOffKeepsTextPasteAndRejectsImages() async throws {
    let fixture = AttachmentFlowFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let host = UIHostingController(rootView: composer(conversation, supportsAttachments: false))
    let window = try await mount(host)
    defer { unmount(window) }
    attach(window, name: "Compact native composer with attachments disabled")
    let input = try XCTUnwrap(textView(in: host.view))
    let file = try makeImage()
    defer { try? FileManager.default.removeItem(at: file) }
    input.becomeFirstResponder()
    input.paste(itemProviders: [try XCTUnwrap(NSItemProvider(contentsOf: file))])
    input.paste(itemProviders: [NSItemProvider(object: "text still works" as NSString)])
    try await eventually { conversation.draft == "text still works" }
    XCTAssertFalse(conversation.attachmentDraft.hasAttachments)
    XCTAssertTrue(fixture.state.value.withLock { $0.preparations.isEmpty })
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
    let host = UIHostingController(
      rootView: ChatComposerView(
        draft: Binding(get: { workspace.newChatDraft }, set: { workspace.newChatDraft = $0 }),
        isBusy: false, showsProgress: false, canStop: false, needsUpgrade: false,
        error: nil, attachmentURL: fixture.http.baseURL, attachments: workspace.newAttachmentDraft,
        supportsAttachments: true, submit: {}, refresh: nil))
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
    input.paste(itemProviders: [try XCTUnwrap(NSItemProvider(contentsOf: file))])
    try await eventually { conversation.attachmentDraft.error?.contains("1 GB") == true }
    XCTAssertEqual(conversation.draft, "Keep selected text")
    XCTAssertEqual(input.selectedRange, NSRange(location: 5, length: 8))
    XCTAssertFalse(conversation.attachmentDraft.hasAttachments)
    XCTAssertTrue(fixture.state.value.withLock { $0.preparations.isEmpty })
  }

  private func mount<V: View>(_ host: UIHostingController<V>) async throws -> UIWindow {
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    host.view.layoutIfNeeded()
    try await eventually { self.textView(in: host.view)?.bounds.isEmpty == false }
    return window
  }

  private func composer(_ conversation: ConversationStore, supportsAttachments: Bool = true)
    -> some View
  {
    ChatComposerView(
      draft: Binding(get: { conversation.draft }, set: { conversation.draft = $0 }),
      isBusy: false, showsProgress: false, canStop: false, needsUpgrade: false,
      error: nil, attachmentURL: URL(string: "https://app.example.invalid")!,
      attachments: conversation.attachmentDraft,
      supportsAttachments: supportsAttachments, submit: { await conversation.send() }, refresh: nil)
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
