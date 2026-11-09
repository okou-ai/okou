import ChatData
import ChatDataTestSupport
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class VoiceInputNavigationTests: XCTestCase {
  func testVoiceShortcutWaitsForAuthenticationAndPreservesDraftsAndSavedAudioWithoutSending()
    async throws
  {
    let fixture = VoiceEntryFixture()
    addTeardownBlock { try fixture.removeFiles() }
    let capture = VoiceCaptureFixture()
    let workspace = fixture.workspace(capture: capture)
    addTeardownBlock { @MainActor in workspace.close() }
    let requests = NewChatRequests.shared
    defer {
      if let id = requests.pendingID { requests.consume(id) }
    }

    _ = try await VoiceInputIntent().perform()
    XCTAssertFalse(requests.open(in: workspace))
    await workspace.refreshNavigation()
    await workspace.list.refresh()
    XCTAssertNil(workspace.list.error)
    workspace.setForeground(true)
    workspace.newChatDraft = "Existing notes: "
    await workspace.newComposer.synchronize()
    workspace.selectChat(AttachmentFlowFixture.threadID)
    let conversation = try XCTUnwrap(workspace.selectedConversation)
    conversation.draft = "Keep the conversation draft"
    let voice = try XCTUnwrap(workspace.newComposer.voice)
    addTeardownBlock { @MainActor in await voice.discard() }
    let host = UIHostingController(
      rootView: VoiceEntryHarness(workspace: workspace, isAuthenticated: false))
    let window = try await mountMentionHost(host)
    addTeardownBlock { @MainActor in unmount(window) }
    XCTAssertEqual(voice.phase, .idle)

    host.rootView = VoiceEntryHarness(workspace: workspace, isAuthenticated: true)
    try await eventually { voice.phase == .recording }
    XCTAssertNil(workspace.selectedThreadID)
    XCTAssertEqual(workspace.newChatDraft, "Existing notes: ")
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    XCTAssertFalse(input.isFirstResponder)
    capture.speak(seconds: 1)
    try await eventually { voice.duration == 1 }

    let scene = try XCTUnwrap(window.windowScene)
    NewChatSceneDelegate().windowScene(
      scene,
      performActionFor: UIApplicationShortcutItem(
        type: NewChatRequests.voiceShortcutType, localizedTitle: "Voice Input")
    ) { XCTAssertTrue($0) }
    XCTAssertTrue(requests.open(in: workspace))
    capture.speak(seconds: 1)
    try await eventually { voice.duration == 2 }

    workspace.setForeground(false)
    try await eventually { voice.phase == .saved }
    workspace.selectChat(AttachmentFlowFixture.threadID)
    NewChatSceneDelegate().windowScene(
      scene,
      performActionFor: UIApplicationShortcutItem(
        type: NewChatRequests.voiceShortcutType, localizedTitle: "Voice Input")
    ) { XCTAssertTrue($0) }
    workspace.setForeground(true)
    try await eventually { workspace.selectedThreadID == nil }
    XCTAssertEqual(voice.phase, .saved)
    XCTAssertEqual(voice.duration, 2, accuracy: 0.0001)

    await voice.finish()
    XCTAssertEqual(workspace.newChatDraft, "Existing notes: spoken words")
    XCTAssertEqual(conversation.draft, "Keep the conversation draft")
    XCTAssertEqual(fixture.state.created.withLock { $0 }, 0)
    XCTAssertTrue(fixture.flow.state.value.withLock { $0.messages.isEmpty })
    workspace.close()
    let reopened = fixture.workspace(capture: VoiceCaptureFixture())
    defer { reopened.close() }
    await reopened.refreshNavigation()
    XCTAssertEqual(reopened.newChatDraft, "Existing notes: spoken words")
  }

  func testVoiceQuickActionWaitsForTheEditorAndPreservesDraftWhenMicrophoneDenied() async throws {
    let fixture = VoiceEntryFixture()
    addTeardownBlock { try fixture.removeFiles() }
    let capture = VoiceCaptureFixture()
    capture.startFailure = NativeVoiceAudioCapture.CaptureError.permissionDenied
    let workspace = fixture.workspace(capture: capture)
    addTeardownBlock { @MainActor in workspace.close() }
    await workspace.refreshNavigation()
    workspace.setForeground(true)
    workspace.newChatDraft = "Keep these notes"
    await workspace.newComposer.synchronize()
    let voice = try XCTUnwrap(workspace.newComposer.voice)
    addTeardownBlock { @MainActor in await voice.discard() }
    let requests = NewChatRequests.shared
    defer {
      if let id = requests.pendingID { requests.consume(id) }
    }
    XCTAssertTrue(
      requests.receive(
        UIApplicationShortcutItem(
          type: NewChatRequests.voiceShortcutType, localizedTitle: "Voice Input")))
    XCTAssertTrue(requests.open(in: workspace))
    XCTAssertEqual(voice.phase, .idle)
    XCTAssertNil(voice.error)
    let host = UIHostingController(
      rootView: VoiceEntryHarness(workspace: workspace, isAuthenticated: true))
    let window = try await mountMentionHost(host)
    addTeardownBlock { @MainActor in unmount(window) }
    try await eventually { voice.microphoneDenied }
    XCTAssertEqual(voice.phase, .idle)
    XCTAssertNotNil(voice.error)
    XCTAssertEqual(workspace.newChatDraft, "Keep these notes")
    XCTAssertTrue(workspace.newComposer.canSend)
    XCTAssertEqual(fixture.state.created.withLock { $0 }, 0)
    XCTAssertTrue(fixture.flow.state.value.withLock { $0.messages.isEmpty })
  }

  func testNewChatCancelsVoiceStartupBeforeDelayedMicrophonePermissionReturns() async throws {
    let fixture = VoiceEntryFixture()
    addTeardownBlock { try fixture.removeFiles() }
    let capture = VoiceCaptureFixture()
    let gate = VoiceResponseGate(
      started: expectation(description: "Microphone permission requested"))
    let opened = expectation(description: "Voice and keyboard entries opened")
    opened.expectedFulfillmentCount = 2
    capture.startGate = gate
    let workspace = fixture.workspace(capture: capture)
    addTeardownBlock { @MainActor in workspace.close() }
    await workspace.refreshNavigation()
    workspace.setForeground(true)
    workspace.newChatDraft = "Retain this draft"
    await workspace.newComposer.synchronize()
    let voice = try XCTUnwrap(workspace.newComposer.voice)
    addTeardownBlock { @MainActor in
      gate.release()
      await voice.discard()
    }
    let host = UIHostingController(
      rootView: VoiceEntryHarness(
        workspace: workspace, isAuthenticated: true, didOpen: { opened.fulfill() }))
    let window = try await mountMentionHost(host)
    addTeardownBlock { @MainActor in unmount(window) }
    let requests = NewChatRequests.shared
    defer {
      if let id = requests.pendingID { requests.consume(id) }
    }

    _ = try await VoiceInputIntent().perform()
    await fulfillment(of: [gate.started], timeout: 3)
    _ = try await NewChatIntent().perform()
    await fulfillment(of: [opened], timeout: 3)
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await eventually { input.isFirstResponder }
    gate.release()
    try await eventually { voice.phase == .idle }
    XCTAssertEqual(workspace.newChatDraft, "Retain this draft")
    XCTAssertEqual(fixture.state.created.withLock { $0 }, 0)
    XCTAssertTrue(fixture.flow.state.value.withLock { $0.messages.isEmpty })
  }

  func testBackgroundingBeforeAuthenticationCancelsPendingVoiceInput() async throws {
    let fixture = VoiceEntryFixture()
    addTeardownBlock { try fixture.removeFiles() }
    let workspace = fixture.workspace(capture: VoiceCaptureFixture())
    addTeardownBlock { @MainActor in workspace.close() }
    await workspace.refreshNavigation()
    await workspace.list.refresh()
    XCTAssertNil(workspace.list.error)
    workspace.setForeground(true)
    workspace.selectChat(AttachmentFlowFixture.threadID)
    XCTAssertEqual(workspace.selectedThreadID, AttachmentFlowFixture.threadID)
    workspace.newChatDraft = "Keep the pending draft"
    let voice = try XCTUnwrap(workspace.newComposer.voice)
    addTeardownBlock { @MainActor in await voice.discard() }
    let host = UIHostingController(
      rootView: VoiceEntryHarness(workspace: workspace, isAuthenticated: false))
    let window = try await mountMentionHost(host)
    addTeardownBlock { @MainActor in unmount(window) }
    let requests = NewChatRequests.shared
    defer {
      if let id = requests.pendingID { requests.consume(id) }
    }

    _ = try await VoiceInputIntent().perform()
    NewChatSceneDelegate().sceneDidEnterBackground(try XCTUnwrap(window.windowScene))
    host.rootView = VoiceEntryHarness(workspace: workspace, isAuthenticated: true)
    try await hostingPresentationFrame()
    XCTAssertEqual(workspace.selectedThreadID, AttachmentFlowFixture.threadID)
    XCTAssertEqual(voice.phase, .idle)
    XCTAssertEqual(workspace.newChatDraft, "Keep the pending draft")
    XCTAssertEqual(fixture.state.created.withLock { $0 }, 0)
  }
}

private struct VoiceEntryHarness: View {
  let workspace: WorkspaceStore
  let isAuthenticated: Bool
  var didOpen: () -> Void = {}

  var body: some View {
    MentionComposerHarness(workspace: workspace)
      .modifier(
        NewChatNavigation(
          workspace: workspace, isAuthenticated: isAuthenticated, didOpen: didOpen)
      )
      .environment(\.scenePhase, .active)
  }
}

private final class VoiceEntryFixture: Sendable {
  let state = VoiceEntryState()
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let flow: AttachmentFlowFixture

  init() {
    let state = state
    flow = AttachmentFlowFixture(
      creation: {
        state.created.withLock { $0 += 1 }
        return true
      },
      voiceInput: { request in
        switch request.url?.path {
        case "/api/voice-io/quota":
          return ChatHTTPResponse(body: #"{"allowed":true,"count":0,"limit":60}"#)
        case "/api/voice-io/transcribe/segment":
          return ChatHTTPResponse(body: #"{"transcript":"spoken words","language":"en"}"#)
        case "/api/voice-io/polish/segments":
          return ChatHTTPResponse(body: #"{"text":"spoken words"}"#)
        default: throw URLError(.unsupportedURL)
        }
      },
      threadList: { request in
        switch request.url?.path {
        case "/api/chat-threads/snapshot":
          return ChatHTTPResponse(
            body: """
              {"chatThreads":[{
                "id":"\(AttachmentFlowFixture.threadID)",
                "agentId":"\(AttachmentFlowFixture.agentID)",
                "title":"Existing conversation",
                "createdAt":"2026-11-09T00:00:00Z",
                "updatedAt":"2026-11-09T00:00:00Z",
                "sortAt":"2026-11-09T00:00:00Z",
                "archived":false,"hidden":false,"pinnedAt":null,"pinOrder":null
              }],"latestEventId":null,"latestSeqId":0}
              """)
        case "/api/chat-threads/events":
          return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
        case "/api/indicators":
          return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
        default: throw URLError(.unsupportedURL)
        }
      })
  }

  @MainActor
  func workspace(capture: VoiceCaptureFixture) -> WorkspaceStore {
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: flow.http.baseURL, userID: "voice-entry-user",
        workspaceID: "voice-entry-workspace"),
      directory: directory)
    return WorkspaceStore(
      client: flow.http.client, webURL: flow.http.baseURL, draftStorage: storage,
      voiceCapture: { capture })
  }

  func removeFiles() throws {
    if FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }
}

private final class VoiceEntryState: Sendable {
  let created = Mutex(0)
}
