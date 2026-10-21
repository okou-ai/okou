import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

/// Only the HTTP provider is synthetic. Navigation decoding, workspace scoping,
/// draft persistence, native editors and command delivery use production code.
final class MentionNavigationFixture: Sendable {
  let http: ChatHTTPFixture
  let paths: MentionRequestLog
  static func agent(_ index: Int) -> String {
    String(format: "73000000-0000-4000-8000-%012d", index)
  }
  static func thread(_ index: Int) -> String {
    String(format: "74000000-0000-4000-8000-%012d", index)
  }

  init(workflows: (@Sendable (URLRequest) async throws -> ChatHTTPResponse)? = nil) {
    let paths = MentionRequestLog()
    self.paths = paths
    http = ChatHTTPFixture { request in
      let path = request.url!.path
      paths.value.withLock { $0.append(path) }
      switch path {
      case "/api/workflows/for-composer":
        guard let workflows else { throw URLError(.unsupportedURL) }
        return try await workflows(request)
      case "/api/agents":
        let names = [
          "Planner", "Research Agent", "Notes", "Release",
          "研究 Agent — Long workspace name with 中文 and 🌷 to check native truncation and accessibility",
        ]
        let others = names.enumerated().map { index, name in
          ["agentId": Self.agent(index + 1), "displayName": name, "isDefaultAgent": false]
            as [String: Any]
        }
        let values =
          [
            [
              "agentId": AttachmentFlowFixture.agentID, "displayName": "Okou",
              "isDefaultAgent": true,
            ] as [String: Any]
          ] + others
        return ChatHTTPResponse(
          body: String(decoding: try JSONSerialization.data(withJSONObject: values), as: UTF8.self))
      case "/api/user-preferences": return ChatHTTPResponse(body: "{\"pinnedAgentIds\":[]}")
      case "/api/feature-switches":
        return ChatHTTPResponse(body: "{\"effectiveSwitches\":{\"chatThreadArchiving\":true}}")
      case "/api/chat-threads/snapshot":
        var threads: [[String: Any]] = (1...30).map {
          Self.row(
            id: Self.thread($0), title: String(format: "Project %02d", $0), day: $0,
            agent: Self.agent(2))
        }
        threads.append(
          Self.row(
            id: Self.thread(31), title: "Cross Agent archived plan", day: 31, agent: Self.agent(1),
            archived: true))
        threads.append(
          Self.row(
            id: Self.thread(32), title: "Hidden plan", day: 31, agent: Self.agent(1), hidden: true))
        threads.append(Self.row(id: Self.thread(33), title: "", day: 31, agent: Self.agent(1)))
        threads.append(
          Self.row(
            id: AttachmentFlowFixture.threadID, title: "Current conversation", day: 1,
            agent: AttachmentFlowFixture.agentID))
        threads.append(
          Self.row(
            id: Self.thread(34), title: "Pinned older", day: 1, agent: Self.agent(1), pinOrder: "a0"
          ))
        threads.append(
          Self.row(
            id: Self.thread(35), title: "Pinned recent", day: 2, agent: Self.agent(1),
            pinOrder: "a1"))
        return ChatHTTPResponse(
          body: String(
            decoding: try JSONSerialization.data(withJSONObject: [
              "chatThreads": threads, "latestEventId": NSNull(), "latestSeqId": 0,
            ]), as: UTF8.self))
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{},\"unreadAt\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  private static func row(
    id: String, title: String, day: Int, agent: String, archived: Bool = false,
    hidden: Bool = false, pinOrder: String? = nil
  ) -> [String: Any] {
    let date = String(format: "2026-10-%02dT10:00:00Z", day)
    return [
      "id": id, "agentId": agent, "title": title, "createdAt": date, "updatedAt": date,
      "sortAt": date,
      "archived": archived, "hidden": hidden, "pinnedAt": pinOrder == nil ? NSNull() : date as Any,
      "pinOrder": pinOrder as Any? ?? NSNull(),
    ]
  }

  @MainActor func workspace() async throws -> WorkspaceStore {
    let store = WorkspaceStore(client: http.client, webURL: http.baseURL)
    await store.refreshNavigation()
    await store.list.refresh()
    XCTAssertNil(store.list.navigationError)
    XCTAssertNil(store.list.error)
    return store
  }
}

final class MentionRequestLog: Sendable { let value = Mutex<[String]>([]) }

@MainActor
extension WorkspaceStore {
  var mentionTestSource: ComposerMentionSource {
    ComposerMentionSource(agentID: selectedAgentID, agents: list.agents, threads: list.threads)
  }
}

struct MentionComposerHarness: View {
  let workspace: WorkspaceStore?
  let state: ComposerDraftStore
  let conversation: ConversationStore?
  let source: ComposerMentionSource?
  var sent: ChatMessage?

  init(workspace: WorkspaceStore, source: ComposerMentionSource? = nil) {
    self.workspace = workspace
    state = workspace.newComposer
    conversation = nil
    self.source = source
  }
  init(conversation: ConversationStore, source: ComposerMentionSource, sent: ChatMessage? = nil) {
    workspace = nil
    self.conversation = conversation
    state = conversation.composer
    self.source = source
    self.sent = sent
  }
  init(state: ComposerDraftStore, source: ComposerMentionSource? = nil) {
    workspace = nil
    conversation = nil
    self.state = state
    self.source = source
  }

  var body: some View {
    VStack(alignment: .leading) {
      Text("Okou").font(.title2.weight(.semibold)).padding()
      if let sent, let conversation {
        UserMessageView(
          message: sent, webURL: conversation.webURL, viewer: conversation.attachmentViewer,
          loadsAttachments: false
        )
        .padding()
      }
      Spacer(minLength: 0)
    }
    .safeAreaBar(edge: .bottom, spacing: 0) {
      let composer = workspace?.newComposer ?? state
      ChatComposerView(
        draft: Binding(get: { composer.text }, set: { composer.text = $0 }),
        isBusy: false, showsProgress: false, canStop: false, needsUpgrade: false, error: nil,
        attachmentURL: URL(string: "https://example.invalid")!, attachments: composer.attachments,
        draftState: composer,
        submit: {
          if let workspace { await workspace.sendNewChat() } else { await conversation?.send() }
        }, refresh: nil, mentionSource: source ?? workspace?.mentionTestSource)
    }
  }
}

@MainActor
func mentionInputs(in view: UIView) -> [ComposerTextView] {
  if let view = view as? ComposerTextView { return [view] }
  return view.subviews.flatMap { mentionInputs(in: $0) }
}

@MainActor
func focusMentionInput(_ input: ComposerTextView) async throws {
  input.becomeFirstResponder()
  try await eventually(
    message:
      "Native composer focus/expansion: \(input.isFirstResponder), \(input.bounds); "
      + "window: \(input.window != nil); current: \(input.isCurrent())"
  ) {
    input.isFirstResponder && input.bounds.height >= (input.font?.lineHeight ?? 20) * 2 - 1
  }
}

@MainActor
func mentionTable(in view: UIView) -> UITableView? {
  if let table = view as? UITableView, table.accessibilityIdentifier == "mention-suggestions" {
    return table
  }
  return view.subviews.lazy.compactMap { mentionTable(in: $0) }.first
}

@MainActor
func mountMentionHost<V: View>(_ host: UIHostingController<V>) async throws -> UIWindow {
  let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
  let window = UIWindow(windowScene: scene)
  window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
  window.rootViewController = host
  window.makeKeyAndVisible()
  host.view.layoutIfNeeded()
  try await eventually {
    guard let input = mentionInputs(in: host.view).first else { return false }
    return input.window === window && !input.bounds.isEmpty
  }
  // Native focus must follow the initial hosting transaction's presented frame.
  await hostingPresentationFrame()
  return window
}

@MainActor
func attachMention(_ window: UIWindow, name: String) {
  let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
  }
  let attachment = XCTAttachment(image: image)
  attachment.name = name
  attachment.lifetime = .keepAlways
  XCTContext.runActivity(named: name) { $0.add(attachment) }
}
