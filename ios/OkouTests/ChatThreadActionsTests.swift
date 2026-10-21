import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatThreadActionsTests: XCTestCase {
  func testNativeMenuAndRenamePresentationInLightDarkAndAccessibilityText() async throws {
    let fixture = ThreadActionsFixture(muted: true)
    let store = fixture.workspace()
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    fixture.remote(kind: "pinned", extra: ",\"pinOrder\":\"a0\"")
    await store.list.refresh(waitForCurrent: true)
    await store.list.rename(
      try XCTUnwrap(store.list.threads.first),
      title:
        "A long conversation title about planning the week and keeping important follow-ups together"
    )
    store.selectChat(ThreadActionsFixture.thread)
    for style in [UIUserInterfaceStyle.light, .dark] {
      let host = UIHostingController(
        rootView: ThreadActionsHarness(store: store)
          .environment(\.colorScheme, style == .dark ? .dark : .light))
      host.overrideUserInterfaceStyle = style
      if style == .dark {
        host.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraLarge
      }
      let window = try await mountActions(host)
      defer { unmount(window) }
      let button = try XCTUnwrap(moreButton(in: host.view))
      button.performPrimaryAction()
      try await eventually {
        window.windowScene?.windows.contains { hasLabel("Archive chat", in: $0) } == true
      }
      try await eventually {
        window.windowScene?.windows.allSatisfy { menuLabelsHaveSettled(in: $0) } == true
      }
      button.contextMenuInteraction?.dismissMenu()
      try await eventually {
        window.windowScene?.windows.contains { hasLabel("Archive chat", in: $0) } == false
      }
      button.sendAction(try action("chat-rename", in: button))
      try await eventually { findAlert(host) != nil }
      try await eventually { findAlert(host)?.viewIfLoaded.map(presentationHasSettled) == true }
      XCTAssertEqual(findAlert(host)?.traitCollection.userInterfaceStyle.rawValue, style.rawValue)
      attach(
        window,
        name: style == .light
          ? "Native rename light long synthetic title"
          : "Native rename dark accessibility text long synthetic title")
      store.list.cancelRename()
      try await eventually { findAlert(host) == nil }
    }
  }

  func testNativeMenuUsesCurrentStateAndKeepsEntryAvailableDuringMute() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    let host = UIHostingController(rootView: ThreadActionsHarness(store: store))
    let window = try await mountActions(host)
    defer { unmount(window) }
    let button = try XCTUnwrap(moreButton(in: host.view))
    XCTAssertTrue(button.showsMenuAsPrimaryAction)
    XCTAssertEqual(button.accessibilityLabel, "More chat actions")
    XCTAssertEqual(button.bounds.width, 48)
    XCTAssertEqual(button.bounds.height, 48)
    XCTAssertEqual(
      menuActions(button.menu).map(\.title), ["Pin chat", "Rename", "Mute chat", "Archive chat"])
    XCTAssertTrue((button.menu?.children.last as? UIMenu)?.options.contains(.displayInline) == true)

    let gate = ThreadActionGate()
    defer { gate.open() }
    fixture.state.value.withLock { $0.nextGate = gate }
    button.sendAction(try action("chat-mute", in: button))
    try await eventually { fixture.writes.contains { $0.action == "mute" } }
    try await eventually {
      (try? self.action("chat-rename", in: button))?.attributes.contains(.disabled) == true
    }
    XCTAssertTrue(button.isEnabled)
    XCTAssertTrue(try action("chat-mute", in: button).attributes.contains(.disabled))
    await store.setMuted(ThreadActionsFixture.thread, muted: true)
    XCTAssertEqual(fixture.writes.filter { $0.action == "mute" }.count, 1)
    gate.open()
    try await eventually { (try? self.action("chat-mute", in: button))?.title == "Unmute chat" }
    XCTAssertEqual(button.accessibilityValue, "Not pinned, Muted")
    XCTAssertFalse(try action("chat-rename", in: button).attributes.contains(.disabled))
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isUnread)
    XCTAssertTrue(
      store.list.threads(agentID: ThreadActionsFixture.agent, archived: false).count == 1)
    XCTAssertTrue(store.threadFeedback?.message.contains("tasks keep running") == true)
    fixture.state.value.withLock { $0.mutingEnabled = false }
    await store.refreshNavigation()
    XCTAssertEqual(try action("chat-mute", in: button).title, "Unmute chat")

    // The same control reads remote pin/archive changes through the normal event protocol.
    fixture.remote(kind: "pinned", extra: ",\"pinOrder\":\"a0\"")
    fixture.remote(kind: "archived")
    await store.list.refresh(waitForCurrent: true)
    try await eventually {
      (try? self.action("chat-archive", in: button))?.title == "Unarchive chat"
    }
    XCTAssertEqual(try action("chat-pin", in: button).title, "Unpin chat")
    XCTAssertEqual(button.accessibilityValue, "Pinned, Muted, Archived")
    XCTAssertEqual(
      button.configuration?.image?.pngData(), UIImage(systemName: "ellipsis")?.pngData())
    attach(window, name: "Native more control with pinned muted archived synthetic chat")
    button.sendAction(try action("chat-mute", in: button))
    try await eventually {
      !menuActions(button.menu).contains { $0.identifier == UIAction.Identifier("chat-mute") }
    }
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isUnread)
    store.startNewChat()
    try await eventually { moreButton(in: host.view) == nil }
  }

  func testRenameTrimsSkipsEmptyAndUnchangedAndRestoresNativeEditorAfterFailure() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    let host = UIHostingController(rootView: ThreadActionsHarness(store: store))
    let window = try await mountActions(host)
    defer { unmount(window) }
    let button = try XCTUnwrap(moreButton(in: host.view))
    button.sendAction(try action("chat-rename", in: button))
    try await eventually { findAlert(host) != nil }
    let alert = try XCTUnwrap(findAlert(host))
    let field = try XCTUnwrap(alert.textFields?.first)
    XCTAssertEqual(field.text, "Planning a useful week")
    field.text = "  \n "
    field.sendActions(for: .editingChanged)
    XCTAssertFalse(try XCTUnwrap(alert.actions.first { $0.title == "Save" }).isEnabled)
    await store.list.saveRename()
    XCTAssertTrue(fixture.writes.isEmpty)
    store.list.beginRename(ThreadActionsFixture.thread)
    store.list.renameTitle = "  Planning a useful week \n"
    await store.list.saveRename()
    XCTAssertTrue(fixture.writes.isEmpty)

    fixture.state.value.withLock { $0.failNext["rename"] = 503 }
    store.list.beginRename(ThreadActionsFixture.thread)
    store.list.renameTitle = "  A title worth keeping  "
    await store.list.saveRename()
    try await eventually { findAlert(host)?.message == "rename unavailable" }
    XCTAssertEqual(findAlert(host)?.textFields?.first?.text, "  A title worth keeping  ")
    XCTAssertEqual(store.selectedConversation?.thread.title, "Planning a useful week")
    XCTAssertNil(store.list.error)
    attach(window, name: "Native rename retry retains the synthetic title and failure message")
    await store.list.saveRename()
    try await eventually { findAlert(host) == nil }
    XCTAssertEqual(store.selectedConversation?.thread.title, "A title worth keeping")
    XCTAssertEqual(store.list.threads.first?.displayTitle, "A title worth keeping")
    XCTAssertEqual(
      fixture.writes.filter { $0.action == "rename" }.map(\.title),
      ["A title worth keeping", "A title worth keeping"])
  }

  func testUnmuteMarksReadBeforeExposingPastRepliesAndAllowsSwitchOffRecovery() async throws {
    let fixture = ThreadActionsFixture(muted: true)
    let store = fixture.workspace()
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isUnread)
    fixture.state.value.withLock {
      $0.mutingEnabled = false
      $0.failNext["mark-read"] = 503
    }
    await store.refreshNavigation()
    XCTAssertTrue(store.list.canMute(ThreadActionsFixture.thread))
    await store.setMuted(ThreadActionsFixture.thread, muted: false)
    XCTAssertEqual(fixture.writes.map(\.action), ["mark-read"])
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isMuted)
    XCTAssertEqual(store.threadFeedback?.actionTitle, "Retry")
    let retry = try XCTUnwrap(store.threadFeedback)
    await retry.action()
    XCTAssertEqual(fixture.writes.map(\.action), ["mark-read", "mark-read", "unmute"])
    let thread = try XCTUnwrap(store.list.threads.first)
    XCTAssertFalse(thread.isMuted)
    XCTAssertFalse(thread.isUnread)
    XCTAssertFalse(store.list.unreadAgentIDs.contains(ThreadActionsFixture.agent))
    XCTAssertNil(store.threadFeedback?.actionTitle)
    XCTAssertFalse(store.list.canMute(ThreadActionsFixture.thread))

    // A new reply after unmuting can become unread normally.
    fixture.state.value.withLock { $0.unread = true }
    await store.list.refreshIndicators()
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isUnread)
  }

  func testMuteDenialAndUnmuteFailureKeepRecoverableState() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    fixture.state.value.withLock { $0.failNext["mute"] = 404 }
    await store.setMuted(ThreadActionsFixture.thread, muted: true)
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isMuted)
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isUnread)
    await (try XCTUnwrap(store.threadFeedback)).action()
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isMuted)
    // Undo a mute restores the old unread state, without marking read.
    await (try XCTUnwrap(store.threadFeedback)).action()
    XCTAssertEqual(fixture.writes.map(\.action), ["mute", "mute", "unmute"])
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isUnread)
    await store.setMuted(ThreadActionsFixture.thread, muted: true)
    fixture.state.value.withLock { $0.failNext["unmute"] = 403 }
    await store.setMuted(ThreadActionsFixture.thread, muted: false)
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isMuted)
    XCTAssertEqual(store.threadFeedback?.actionTitle, "Retry")
    await (try XCTUnwrap(store.threadFeedback)).action()
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isMuted)
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isUnread)
  }

  func testDetailArchiveSurvivesNavigationAndCallerCancellationAndUndoRestoresChat() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    let conversation = try XCTUnwrap(store.selectedConversation)
    let gate = ThreadActionGate()
    defer { gate.open() }
    fixture.state.value.withLock { $0.nextGate = gate }
    let archiving = Task {
      await store.setArchived(ThreadActionsFixture.thread, archived: true, leaveDetail: true)
    }
    try await eventually { fixture.writes.contains { $0.action == "archive" } }
    XCTAssertNil(store.selectedThreadID)
    XCTAssertEqual(store.selectedAgentID, ThreadActionsFixture.agent)
    XCTAssertTrue(store.list.threads(agentID: ThreadActionsFixture.agent, archived: false).isEmpty)
    XCTAssertEqual(
      store.list.threads(agentID: ThreadActionsFixture.agent, archived: true).map(\.id),
      [ThreadActionsFixture.thread])
    // Ending the initiating detail task must not revoke the workspace-owned command.
    archiving.cancel()
    let duplicate = await store.setArchived(ThreadActionsFixture.thread, archived: true)
    XCTAssertFalse(duplicate)
    gate.open()
    let archived = await archiving.value
    XCTAssertTrue(archived)
    XCTAssertEqual(store.threadFeedback?.actionTitle, "Undo")
    await (try XCTUnwrap(store.threadFeedback)).action()
    XCTAssertEqual(store.selectedThreadID, ThreadActionsFixture.thread)
    XCTAssertTrue(store.selectedConversation === conversation)
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isArchived)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive", "unarchive"])
  }

  func testFailedArchiveRetryReusesEventAndRetainsDetailUndoDestinationAcrossAgentChange()
    async throws
  {
    let fixture = ThreadActionsFixture(muted: true)
    let store = fixture.workspace()
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    fixture.state.value.withLock { $0.failNext["archive"] = 503 }
    await store.setArchived(ThreadActionsFixture.thread, archived: true, leaveDetail: true)
    XCTAssertNil(store.selectedThreadID)
    XCTAssertEqual(store.threadFeedback?.actionTitle, "Retry")
    store.startNewChat(agentID: ThreadActionsFixture.otherAgent)
    await (try XCTUnwrap(store.threadFeedback)).action()
    XCTAssertEqual(store.selectedAgentID, ThreadActionsFixture.otherAgent)
    XCTAssertEqual(
      fixture.writes.filter { $0.action == "archive" }.map(\.eventID),
      Array(repeating: try XCTUnwrap(fixture.writes.first?.eventID), count: 2))
    XCTAssertTrue(store.threadFeedback?.message.contains("stay archived while muted") == true)
    fixture.state.value.withLock { $0.failNext["unarchive"] = 503 }
    await (try XCTUnwrap(store.threadFeedback)).action()
    XCTAssertNil(store.selectedThreadID)
    XCTAssertEqual(store.threadFeedback?.actionTitle, "Retry")
    XCTAssertTrue(store.threadFeedback?.persists == true)
    await (try XCTUnwrap(store.threadFeedback)).action()
    XCTAssertEqual(store.selectedThreadID, ThreadActionsFixture.thread)
    XCTAssertEqual(store.selectedAgentID, ThreadActionsFixture.agent)
    // Opening an archived chat (including via a deep link) and unarchiving keeps it open.
    fixture.remote(kind: "archived")
    await store.refresh()
    let opened = await store.openChatLink(
      .thread(id: ThreadActionsFixture.thread, runID: nil))
    XCTAssertTrue(opened)
    await store.setArchived(ThreadActionsFixture.thread, archived: false, leaveDetail: true)
    XCTAssertEqual(store.selectedThreadID, ThreadActionsFixture.thread)
  }

  func testClosingWorkspaceCancelsMutationsAndDiscardsEditorsFeedbackAndUndo() async throws {
    for operation in ["archive", "mute", "rename"] {
      let fixture = ThreadActionsFixture()
      let store = fixture.workspace()
      await store.refreshNavigation()
      await store.refresh()
      store.selectChat(ThreadActionsFixture.thread)
      let gate = ThreadActionGate()
      defer { gate.open() }
      fixture.state.value.withLock { $0.nextGate = gate }
      let pending = Task {
        switch operation {
        case "archive":
          await store.setArchived(ThreadActionsFixture.thread, archived: true, leaveDetail: true)
        case "mute": await store.setMuted(ThreadActionsFixture.thread, muted: true)
        default:
          store.list.beginRename(ThreadActionsFixture.thread)
          store.list.renameTitle = "Old workspace edit"
          await store.list.saveRename()
        }
      }
      try await eventually { !fixture.writes.isEmpty }
      store.close()
      gate.open()
      await pending.value
      XCTAssertNil(store.threadFeedback)
      XCTAssertNil(store.list.renameRequest)
      let freshFixture = ThreadActionsFixture()
      let fresh = freshFixture.workspace()
      defer { fresh.close() }
      await fresh.refresh()
      XCTAssertEqual(fresh.list.threads.first?.title, "Planning a useful week")
      XCTAssertFalse(try XCTUnwrap(fresh.list.threads.first).isMuted)
      XCTAssertFalse(try XCTUnwrap(fresh.list.threads.first).isArchived)
      XCTAssertNil(fresh.threadFeedback)
    }
  }

  func testUpgradeFromMenuMutationClosesWorkspaceWithoutRetryOrEditor() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    await store.refreshNavigation()
    await store.refresh()
    fixture.state.value.withLock { $0.failNext["mute"] = 426 }
    await store.setMuted(ThreadActionsFixture.thread, muted: true)
    XCTAssertTrue(store.needsUpgrade)
    XCTAssertNil(store.threadFeedback)
    store.list.beginRename(ThreadActionsFixture.thread)
    XCTAssertNil(store.list.renameRequest)
  }

  private func action(_ id: String, in button: UIButton) throws -> UIAction {
    try XCTUnwrap(menuActions(button.menu).first { $0.identifier == UIAction.Identifier(id) })
  }

  private func mountActions<V: View>(_ host: UIHostingController<V>) async throws -> UIWindow {
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    host.view.layoutIfNeeded()
    try await eventually { moreButton(in: host.view)?.window != nil }
    return window
  }

  private func attach(_ window: UIWindow, name: String) {
    let attachment = XCTAttachment(
      image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
      })
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}

private struct ThreadActionsHarness: View {
  let store: WorkspaceStore
  var body: some View {
    Group {
      if let conversation = store.selectedConversation {
        ChatDetailView(conversation: conversation, topContentInset: 60)
      } else {
        Text("New chat").frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .safeAreaBar(edge: .top, spacing: 0) {
      ChatWorkspaceHeader(store: store, height: 60, openSidebar: {})
    }
    .background { ChatThreadRenameDialog(list: store.list).frame(width: 0, height: 0) }
    .tint(.primary)
  }
}

@MainActor
private func moreButton(in view: UIView) -> UIButton? {
  if let button = view as? UIButton, button.accessibilityIdentifier == "chat-thread-more" {
    return button
  }
  return view.subviews.lazy.compactMap { moreButton(in: $0) }.first
}

@MainActor
private func menuActions(_ menu: UIMenu?) -> [UIAction] {
  menu?.children.flatMap { element in
    if let action = element as? UIAction { return [action] }
    return menuActions(element as? UIMenu)
  } ?? []
}

@MainActor
private func findAlert(_ controller: UIViewController) -> UIAlertController? {
  if let alert = controller as? UIAlertController, !alert.isBeingDismissed { return alert }
  if let presented = controller.presentedViewController, let alert = findAlert(presented) {
    return alert
  }
  return controller.children.lazy.compactMap { findAlert($0) }.first
}

@MainActor
private func hasLabel(_ text: String, in view: UIView) -> Bool {
  if let label = view as? UILabel, label.text == text { return true }
  return view.subviews.contains { hasLabel(text, in: $0) }
}

@MainActor
private func menuLabelsHaveSettled(in view: UIView) -> Bool {
  if let label = view as? UILabel, label.text == "Archive chat" {
    return presentationHasSettled(label)
  }
  return view.subviews.allSatisfy { menuLabelsHaveSettled(in: $0) }
}

@MainActor
private func presentationHasSettled(_ view: UIView) -> Bool {
  var current: UIView? = view
  while let ancestor = current {
    if let presented = ancestor.layer.presentation() {
      let layer = ancestor.layer
      if abs(presented.opacity - layer.opacity) > 0.001
        || abs(presented.position.x - layer.position.x) > 0.5
        || abs(presented.position.y - layer.position.y) > 0.5
        || presented.bounds != layer.bounds
      {
        return false
      }
    }
    current = ancestor.superview
  }
  return true
}

private final class ThreadActionGate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation
  init() {
    (stream, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
  }
  func open() {
    continuation.yield(())
    continuation.finish()
  }
  func wait() async { for await _ in stream { return } }
}

private final class ThreadActionsFixture: Sendable {
  static let thread = "78000000-0000-4000-8000-000000000001"
  static let agent = "78000000-0000-4000-8000-000000000002"
  static let otherAgent = "78000000-0000-4000-8000-000000000003"
  static let date = "2026-10-21T00:00:00Z"
  struct Write: Sendable {
    let action: String
    let eventID: String?
    let title: String?
  }
  struct State: Sendable {
    var muted = false
    var unread = true
    var title = "Planning a useful week"
    var mutingEnabled = true
    var failNext: [String: Int] = [:]
    var nextGate: ThreadActionGate?
    var writes: [Write] = []
    var events: [String] = []
  }
  final class StateBox: Sendable { let value = Mutex(State()) }
  let state: StateBox
  let http: ChatHTTPFixture
  var writes: [Write] { state.value.withLock { $0.writes } }
  @MainActor
  func workspace() -> WorkspaceStore { WorkspaceStore(client: http.client, webURL: http.baseURL) }

  init(muted: Bool = false) {
    let state = StateBox()
    state.value.withLock { $0.muted = muted }
    self.state = state
    http = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      if request.httpMethod == "POST" {
        XCTAssertEqual(
          request.value(forHTTPHeaderField: "Authorization"), "Bearer local-test-session")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Type"), "iOS")
        let action = String(path.split(separator: "/").last ?? "")
        let eventID = URLComponents(
          url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems?.first {
            $0.name == "eventId"
          }?.value
        let title =
          action == "rename"
          ? try JSONDecoder().decode([String: String].self, from: chatRequestBody(request))["title"]
          : nil
        let (gate, status) = state.value.withLock { state in
          state.writes.append(Write(action: action, eventID: eventID, title: title))
          let gate = state.nextGate
          state.nextGate = nil
          return (gate, state.failNext.removeValue(forKey: action) ?? 204)
        }
        await gate?.wait()
        try Task.checkCancellation()
        if status != 204 {
          return ChatHTTPResponse(
            status: status, body: "{\"error\":{\"message\":\"\(action) unavailable\"}}")
        }
        if action == "mark-read" {
          state.value.withLock { $0.unread = false }
          return ChatHTTPResponse(body: "{\"lastReadAt\":\"2026-10-21T01:00:00Z\"}")
        }
        state.value.withLock { state in
          let kind: String
          var extra = ""
          switch action {
          case "mute", "unmute":
            kind = "sort_touched"
            state.muted = action == "mute"
            extra = ",\"muted\":\(state.muted)"
          case "archive": kind = "archived"
          case "unarchive": kind = "unarchived"
          case "rename":
            kind = "renamed"
            state.title = title ?? ""
            let encoded = try? JSONEncoder().encode(state.title)
            extra = ",\"title\":\(encoded.map { String(decoding: $0, as: UTF8.self) } ?? "null")"
          default:
            XCTFail("Unexpected mutation: \(path)")
            return
          }
          state.events.append(
            Self.event(
              kind: kind, id: eventID ?? UUID().uuidString, seq: state.events.count + 1,
              extra: extra))
        }
        return ChatHTTPResponse(status: 204, body: "")
      }
      switch path {
      case "/api/user-model-preference":
        return ChatHTTPResponse(
          body:
            "{\"selectedModel\":null,\"serviceTier\":null,\"modelSettings\":{},\"selectedImageModel\":null,\"updatedAt\":null}"
        )
      case "/api/run-models": return runModelsResponse()
      case "/api/model-catalog": return modelCatalogResponse()
      case "/api/chat-threads/\(Self.thread)/metadata":
        return ChatHTTPResponse(
          body:
            "{\"id\":\"\(Self.thread)\",\"agentId\":\"\(Self.agent)\",\"selectedModel\":null,\"modelSettings\":{},\"serviceTier\":null,\"computerUseHostId\":null,\"cloudBrowserEnabled\":false}"
        )
      case "/api/chat-threads/\(Self.thread)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body:
            "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
      case "/api/chat-threads/\(Self.thread)/event-rows":
        let since =
          Int(
            URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first {
              $0.name == "sinceSeqId"
            }?.value ?? "0") ?? 0
        let rows =
          since == 0
          ? [
            Self.message(
              1, type: "input.prompt",
              payload:
                "{\"userMessage\":{\"version\":1,\"parts\":[{\"type\":\"text\",\"text\":\"Help me make room for focused work this week.\"}]}}"
            ),
            Self.message(
              2, type: "output.message",
              payload:
                "{\"content\":\"Start with the two things that matter most.\\n\\n- Reserve a quiet morning for the main project.\\n- Keep a short list of follow-ups for tomorrow.\\n\\nYou can keep this conversation close by or mute it while you focus.\"}"
            ),
          ].joined(separator: ",") : ""
        return ChatHTTPResponse(
          body:
            "{\"rows\":[\(rows)],\"cursor\":{\"lastEventId\":\"\(Self.messageID(2))\",\"lastSeqId\":2},\"hasMore\":false}"
        )
      case "/api/chat-threads/\(Self.thread)":
        return ChatHTTPResponse(body: "{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}")
      case "/api/chat-threads/\(Self.thread)/connector-selections":
        return ChatHTTPResponse(body: "{\"selections\":[]}")
      case "/api/agents":
        return ChatHTTPResponse(
          body:
            "[{\"agentId\":\"\(Self.agent)\",\"isDefaultAgent\":true,\"displayName\":\"Okou\"},{\"agentId\":\"\(Self.otherAgent)\",\"isDefaultAgent\":false,\"displayName\":\"Research\"}]"
        )
      case "/api/user-preferences": return ChatHTTPResponse(body: "{\"pinnedAgentIds\":[]}")
      case "/api/feature-switches":
        return ChatHTTPResponse(
          body:
            "{\"effectiveSwitches\":{\"chatThreadArchiving\":true,\"chatThreadMuting\":\(state.value.withLock { $0.mutingEnabled })}}"
        )
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body:
            "{\"chatThreads\":[{\"id\":\"\(Self.thread)\",\"agentId\":\"\(Self.agent)\",\"title\":\"Planning a useful week\",\"muted\":\(muted),\"createdAt\":\"\(Self.date)\",\"updatedAt\":\"\(Self.date)\",\"sortAt\":\"\(Self.date)\"}],\"latestEventId\":null,\"latestSeqId\":null}"
        )
      case "/api/chat-threads/events":
        let since =
          Int(
            URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first {
              $0.name == "sinceSeqId"
            }?.value ?? "0") ?? 0
        return ChatHTTPResponse(
          body:
            "{\"events\":[\(state.value.withLock { $0.events.dropFirst(since).joined(separator: ",") })],\"hasMore\":false}"
        )
      case "/api/indicators":
        let unread = state.value.withLock { $0.unread }
        let indicator = unread ? "{\"\(Self.thread)\":\"unread\"}" : "{}"
        let unreadAt = unread ? "{\"\(Self.thread)\":\"\(Self.date)\"}" : "{}"
        let agents =
          state.value.withLock { $0.unread && !$0.muted } ? "{\"\(Self.agent)\":\"unread\"}" : "{}"
        return ChatHTTPResponse(
          body: "{\"agents\":\(agents),\"threads\":\(indicator),\"unreadAt\":\(unreadAt)}")
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  func remote(kind: String, extra: String = "") {
    state.value.withLock {
      $0.events.append(
        Self.event(kind: kind, id: UUID().uuidString, seq: $0.events.count + 1, extra: extra))
    }
  }

  private static func event(kind: String, id: String, seq: Int, extra: String) -> String {
    "{\"id\":\"\(id.lowercased())\",\"seqId\":\(seq),\"kind\":\"\(kind)\",\"chatThreadId\":\"\(thread)\",\"agentId\":\"\(agent)\",\"createdAt\":\"\(date)\"\(extra)}"
  }

  private static func messageID(_ seq: Int) -> String {
    String(format: "78000000-0000-4000-8000-%012d", seq + 10)
  }

  private static func message(_ seq: Int, type: String, payload: String) -> String {
    "{\"id\":\"\(messageID(seq))\",\"chatThreadId\":\"\(thread)\",\"runId\":null,\"revokesEventId\":null,\"contextType\":null,\"contextId\":null,\"runEventSequenceNumber\":null,\"runEventId\":null,\"seqId\":\(seq),\"createdAt\":\"\(date)\",\"eventType\":\"\(type)\",\"payload\":\(payload)}"
  }
}
