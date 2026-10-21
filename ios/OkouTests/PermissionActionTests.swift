import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class PermissionActionTests: XCTestCase {
  func testPermissionCompletionAndRefreshPreserveTheHistoryReadingPosition() async throws {
    let message =
      "Permission review\n\n" + PermissionHTTPFixture.actionURL(callback: false)
      + "\n\n" + String(repeating: "Ordinary **history** remains selectable.\n\n", count: 40)
    let fixture = PermissionHTTPFixture(message: message)
    let (conversation, card) = try await setup(fixture, callback: false)
    defer { conversation.close() }
    conversation.rememberReadingPosition(
      ConversationReadingPosition(messageID: PermissionHTTPFixture.messageID, offset: 0))
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    try await eventually {
      abs(offset(of: PermissionHTTPFixture.messageID, in: host.view) ?? .infinity) < 1
    }
    let collection = try XCTUnwrap(markers(in: host.view).first?.enclosingScrollView)
    let height = collection.contentSize.height
    await card.confirm()
    await conversation.refresh()
    try await savedReadingPositionMatchesViewport(conversation, in: host.view)
    XCTAssertEqual(
      offset(of: PermissionHTTPFixture.messageID, in: host.view) ?? .infinity, 0, accuracy: 1)
    XCTAssertEqual(collection.contentSize.height, height, accuracy: 1)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
  }

  func testClosingDuringAWriteCancelsItWithoutContinuingTheChat() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Permission write started")
    let fixture = PermissionHTTPFixture { request in
      if request.httpMethod == "PUT" {
        started.fulfill()
        await gate.wait()
      }
    }
    let (conversation, card) = try await setup(fixture)
    defer {
      gate.open()
      conversation.close()
    }
    let operation = Task { await card.confirm() }
    await fulfillment(of: [started], timeout: 3)
    conversation.close()
    gate.open()
    await operation.value
    // Canceling an HTTP request cannot roll back a write the server already accepted.
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    XCTAssertFalse(card.canConfirm)
    let (reopened, refreshed) = try await setup(fixture)
    defer { reopened.close() }
    XCTAssertEqual(refreshed.applied, fixture.state.withLock { $0.grants != "[]" })
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
  }

  func testNativePermissionSheetDismissalAndConfirmationPreserveTheTranscript() async throws {
    let message =
      "Ordinary **Markdown** and a [link](https://example.com).\n\n"
      + PermissionHTTPFixture.actionURL() + "\n\nText after the request."
    let fixture = PermissionHTTPFixture(message: message)
    let conversation = makeConversation(fixture)
    defer { conversation.close() }
    await conversation.refresh()
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    try await eventually {
      fixture.state.withLock {
        $0.requests.contains { $0.url?.path == "/api/connector-catalog/gmail/permissions" }
      }
    }
    _ = try XCTUnwrap(
      fixture.state.withLock {
        $0.requests.first { $0.url?.path == "/api/connector-catalog/gmail/permissions" }
      })
    let action = try XCTUnwrap(
      ChatPermissionAction(
        url: XCTUnwrap(
          URL(string: PermissionHTTPFixture.actionURL(), relativeTo: fixture.http.baseURL)),
        agentID: conversation.thread.agentID, threadID: conversation.thread.id))
    let card = conversation.permissionActions.card(action)
    try await eventually { card.canConfirm }
    let first = UIHostingController(rootView: PermissionActionDetails(store: card))
    host.present(first, animated: false)
    try await eventually { host.presentedViewController != nil }
    first.dismiss(animated: false)
    try await eventually { host.presentedViewController == nil }
    let canceled = try await ChatPermissions(client: fixture.http.client).load(card.action)
    XCTAssertTrue(canceled.grants.isEmpty)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    let sheet = UIHostingController(rootView: PermissionActionDetails(store: card))
    host.present(sheet, animated: false)
    try await eventually { host.presentedViewController != nil }
    await card.confirm()
    try await eventually {
      fixture.state.withLock { !$0.events.isEmpty }
    }
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 1)
    let detailAttachment = XCTAttachment(
      image: UIGraphicsImageRenderer(bounds: sheet.view.bounds).image { _ in
        sheet.view.drawHierarchy(in: sheet.view.bounds, afterScreenUpdates: true)
      })
    detailAttachment.name = "Native permission details after explicit confirmation"
    detailAttachment.lifetime = .keepAlways
    add(detailAttachment)
    sheet.dismiss(animated: false)
    try await eventually { host.presentedViewController == nil }
    await conversation.refresh()
    try await eventually {
      guard let collection = markers(in: host.view).first?.enclosingScrollView else { return false }
      return collection.contentSize.height - collection.bounds.maxY
        + collection.adjustedContentInset.bottom <= 1
    }
    let attachment = XCTAttachment(
      image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
      })
    attachment.name = "Native transcript after permission and continuation"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testExplicitAllowSavesAndContinuesOnceAndRefreshDoesNotRepeatIt() async throws {
    let fixture = PermissionHTTPFixture()
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    card.duration = .week
    await card.confirm()
    XCTAssertNil(card.error)
    XCTAssertTrue(card.applied)
    let refreshed = try await ChatPermissions(client: fixture.http.client).load(card.action)
    XCTAssertEqual(refreshed.grants.first?.action, .allow)
    await card.confirm()
    await conversation.refresh()
    let requests = fixture.state.withLock { $0.requests }
    XCTAssertEqual(requests.filter { $0.httpMethod == "PUT" }.count, 1)
    XCTAssertEqual(requests.filter { $0.url!.path == "/api/chat/events" }.count, 1)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permission" })
    let sent = try XCTUnwrap(requests.first { $0.url!.path == "/api/chat/events" })
    let body = try XCTUnwrap(
      JSONSerialization.jsonObject(with: chatRequestBody(sent)) as? [String: Any])
    XCTAssertEqual(body["cloudBrowserEnabled"] as? Bool, false)
    XCTAssertTrue(body["computerUseHostId"] is NSNull)
  }

  func testUncertainResumeReadsAcceptedEventBeforeExplicitRetry() async throws {
    var state = PermissionHTTPFixture.State()
    state.loseResumeResponseOnce = true
    let fixture = PermissionHTTPFixture(initial: state)
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    await card.confirm()
    XCTAssertNotNil(card.error)
    XCTAssertTrue(card.needsContinuation)
    await card.confirm()
    XCTAssertNil(card.error)
    XCTAssertFalse(card.needsContinuation)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permission" })
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 1)
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.url!.path == "/api/chat/events" }.count }, 1)
  }

  func testUncertainGrantReadsServerStateAndOnlyContinuesAfterRetry() async throws {
    var state = PermissionHTTPFixture.State()
    state.loseApplyResponseOnce = true
    let fixture = PermissionHTTPFixture(initial: state)
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    await card.confirm()
    XCTAssertNotNil(card.error)
    XCTAssertTrue(card.applied)
    XCTAssertTrue(card.needsContinuation)
    XCTAssertTrue(fixture.state.withLock { $0.events.isEmpty })
    await card.confirm()
    XCTAssertNil(card.error)
    XCTAssertTrue(conversation.messages.contains { $0.text == "Continue after permission" })
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 1)
  }

  func testDeniedWriteCanRetryAndClosingPreventsFurtherMutations() async throws {
    var state = PermissionHTTPFixture.State()
    state.failApplyOnce = true
    let fixture = PermissionHTTPFixture(initial: state)
    let (conversation, card) = try await setup(fixture, action: "deny")
    await card.confirm()
    XCTAssertNotNil(card.error)
    XCTAssertFalse(card.applied)
    await card.confirm()
    XCTAssertNil(card.error)
    let saved = try await ChatPermissions(client: fixture.http.client).load(card.action)
    XCTAssertEqual(saved.grants.first?.action, .deny)
    XCTAssertNil(saved.grants.first?.expiresAt)
    conversation.close()
    let requests = fixture.state.withLock { $0.requests.count }
    await card.confirm()
    await card.refresh()
    XCTAssertEqual(fixture.state.withLock { $0.requests.count }, requests)
  }

  func testExistingGrantDefaultsExpiredAndMissingMetadataAreReadOnlyUntilExplicitConfirm()
    async throws
  {
    for variant in 0..<4 {
      var state = PermissionHTTPFixture.State()
      if variant == 0 { state.grants = PermissionHTTPFixture.grant() }
      if variant == 1 { state.defaultPolicy = "allow" }
      if variant == 2 {
        state.grants = PermissionHTTPFixture.grant(expiration: "2020-01-01T00:00:00Z")
      }
      if variant == 3 { state.missingMetadata = true }
      let fixture = PermissionHTTPFixture(initial: state)
      let (conversation, card) = try await setup(fixture)
      defer { conversation.close() }
      await card.refresh()
      XCTAssertEqual(card.applied, variant < 2)
      XCTAssertEqual(card.canConfirm, variant == 2)
      XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
    }
  }

  func testNativeCardRendersActualScopeAndKeepsOrdinaryMarkdownAroundIt() async throws {
    let fixture = PermissionHTTPFixture()
    let (conversation, card) = try await setup(fixture)
    defer { conversation.close() }
    let ordinary = "Ordinary **Markdown** and a [link](https://example.com)."
    _ = await conversation.messageMarkdown.content(for: ordinary)
    let host = UIHostingController(
      rootView: ScrollView {
        VStack {
          MessageBodyView(
            text: ordinary,
            baseURL: fixture.http.baseURL, markdown: conversation.messageMarkdown)
          PermissionActionCard(store: card, loadsState: true)
        }.padding(20)
      })
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { unmount(window) }
    await Task.yield()
    host.view.layoutIfNeeded()
    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = "Native Gmail permission request with Markdown"
    attachment.lifetime = .keepAlways
    add(attachment)
    XCTAssertEqual(card.metadata?.label, "Gmail")
    XCTAssertEqual(card.snapshot?.agentName, "Mail assistant")
  }

  private func setup(
    _ fixture: PermissionHTTPFixture, action: String = "allow", callback: Bool = true
  ) async throws
    -> (ConversationStore, PermissionActionStore)
  {
    let conversation = makeConversation(fixture)
    let thread = conversation.thread
    await conversation.refresh()
    let url = try XCTUnwrap(
      URL(
        string: PermissionHTTPFixture.actionURL(action: action, callback: callback),
        relativeTo: fixture.http.baseURL)
    )
    let descriptor = try XCTUnwrap(
      ChatPermissionAction(url: url, agentID: thread.agentID, threadID: thread.id))
    let card = conversation.permissionActions.card(descriptor)
    await card.refresh()
    XCTAssertNil(card.error)
    return (conversation, card)
  }

  private func makeConversation(_ fixture: PermissionHTTPFixture) -> ConversationStore {
    let sync = ChatSync(client: fixture.http.client)
    let commands = ChatCommands(client: fixture.http.client, sync: sync)
    let thread = ChatThread(
      id: PermissionHTTPFixture.threadID, agentID: PermissionHTTPFixture.agentID,
      title: "Permissions", createdAt: .now, updatedAt: .now, sortAt: .now, pinnedAt: nil,
      pinOrder: nil)
    return ConversationStore(
      thread: thread, sync: sync, commands: commands,
      webURL: fixture.http.baseURL,
      messageMarkdown: MessageMarkdownCache(baseURL: fixture.http.baseURL),
      isVisible: { true }, didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {})
  }

}
