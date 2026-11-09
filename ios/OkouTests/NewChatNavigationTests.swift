import ChatData
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class NewChatNavigationTests: XCTestCase {
  func testSystemNewChatPreservesBothDraftsAndDoesNotReplayOnOrdinaryNavigation() async throws {
    let fixture = MentionNavigationFixture()
    let workspace = try await fixture.workspace()
    defer { workspace.close() }
    workspace.setForeground(true)
    workspace.newChatDraft = "Keep the next chat's draft"
    workspace.selectChat(AttachmentFlowFixture.threadID)
    let conversation = try XCTUnwrap(workspace.selectedConversation)
    conversation.draft = "Keep this conversation's draft"
    let requests = NewChatRequests()

    XCTAssertTrue(
      requests.receive(
        UIApplicationShortcutItem(type: NewChatRequests.shortcutType, localizedTitle: "New chat")))
    XCTAssertTrue(requests.open(in: workspace))

    XCTAssertNil(workspace.selectedThreadID)
    XCTAssertNil(workspace.selectedConversation)
    XCTAssertEqual(workspace.newChatDraft, "Keep the next chat's draft")
    XCTAssertEqual(conversation.draft, "Keep this conversation's draft")

    workspace.selectChat(AttachmentFlowFixture.threadID)
    XCTAssertFalse(requests.open(in: workspace))
    XCTAssertEqual(workspace.selectedThreadID, AttachmentFlowFixture.threadID)
  }

  func testShortcutAndHomeScreenActionsFocusThePreservedDraftOnlyWhenReady() async throws {
    let creations = Mutex(0)
    let fixture = AttachmentFlowFixture(
      creation: {
        creations.withLock { $0 += 1 }
        return true
      })
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: fixture.http.baseURL, userID: UUID().uuidString, workspaceID: UUID().uuidString),
      directory: directory)
    let workspace = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, draftStorage: storage)
    defer { workspace.close() }
    let requests = NewChatRequests.shared
    defer {
      if let id = requests.pendingID { requests.consume(id) }
    }

    _ = try await NewChatIntent().perform()
    // The request arrives before an active workspace or its Agent is available.
    XCTAssertFalse(requests.open(in: workspace))
    await workspace.refreshNavigation()
    workspace.setForeground(true)
    let saved = "保留草稿 🌷"
    workspace.newChatDraft = saved
    await workspace.newComposer.synchronize()
    let host = UIHostingController(
      rootView: SystemNewChatHarness(workspace: workspace, isAuthenticated: false))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    XCTAssertFalse(input.isFirstResponder)

    host.rootView = SystemNewChatHarness(workspace: workspace, isAuthenticated: true)
    try await eventually { input.isFirstResponder }
    XCTAssertEqual(workspace.newChatDraft, saved)
    input.selectedRange = NSRange(location: (saved as NSString).length, length: 0)
    input.insertText(" 继续")
    XCTAssertEqual(workspace.newChatDraft, saved + " 继续")

    input.resignFirstResponder()
    try await hostingPresentationFrame()
    let scene = try XCTUnwrap(window.windowScene)
    NewChatSceneDelegate().windowScene(
      scene,
      performActionFor: UIApplicationShortcutItem(
        type: NewChatRequests.shortcutType, localizedTitle: "New chat")
    ) { handled in
      XCTAssertTrue(handled)
    }
    try await eventually { input.isFirstResponder }
    XCTAssertEqual(workspace.newChatDraft, saved + " 继续")
    XCTAssertEqual(creations.withLock { $0 }, 0)
    XCTAssertTrue(fixture.state.value.withLock { $0.messages.isEmpty })

    workspace.close()
    let reopened = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, draftStorage: storage)
    defer { reopened.close() }
    XCTAssertEqual(reopened.newChatDraft, saved + " 继续")
  }
}

private struct SystemNewChatHarness: View {
  let workspace: WorkspaceStore
  let isAuthenticated: Bool

  var body: some View {
    MentionComposerHarness(workspace: workspace)
      .modifier(NewChatNavigation(workspace: workspace, isAuthenticated: isAuthenticated))
      .environment(\.scenePhase, .active)
  }
}
