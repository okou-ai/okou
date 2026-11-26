import CCStateSwiftUI
import SwiftUI
import XCTest

@testable import Okou

/// Manual simulator capture, kept on the one-off QA ref.
@MainActor
final class ThreadPresentationCapture: XCTestCase {
  func testCaptureThread() async throws {
    guard Locale.preferredLanguages.first?.hasPrefix("zh") == true else { return }
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: .now)
    let yesterday = try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: today))
    let evening = yesterday.addingTimeInterval(19 * 3600 + 15 * 60)
    let morning = today.addingTimeInterval(9 * 3600 + 40 * 60)
    let first = ConversationHistoryFixture.id(201)
    let second = ConversationHistoryFixture.id(202)
    let fixture = ConversationHistoryFixture(rows: [
      try event(1, "input.prompt", "明天晨会几点开始？", first, evening),
      try event(2, "output.message", "早上九点半开始，在二楼会议室。", first, evening.addingTimeInterval(2)),
      try event(3, "run.completed", "", first, evening.addingTimeInterval(4)),
      try event(4, "input.prompt", "把晨会的两个要点发我。", second, morning),
      try event(5, "output.message", "先确认本周排期，再核对上线前的检查项。", second, morning.addingTimeInterval(4)),
      try event(6, "run.completed", "", second, morning.addingTimeInterval(8))
    ])
    let workspace = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { workspace.close() }
    await workspace.refresh()
    workspace.selectChat(ConversationHistoryFixture.threadID)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    window.overrideUserInterfaceStyle = .light
    let host = UIHostingController(
      rootView: StoreProvider(conversation.graph) {
        ChatDetailView(conversation: conversation, topContentInset: 44)
          .safeAreaBar(edge: .top, spacing: 0) {
            ChatWorkspaceHeader(store: workspace, height: 44)
          }
          .background { OkouColor.background.ignoresSafeArea() }
      })
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { unmount(window) }
    window.layoutIfNeeded()
    try await eventually(timeout: .seconds(12)) {
      nativeViews(in: window).compactMap { $0 as? MessageSelectionCell }.contains {
        $0.representedRowID == "conversation-finished"
      }
    }
    let destination = try XCTUnwrap(
      FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    )
    .appendingPathComponent("thread-parity-51170")
    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
    try Data("ready".utf8).write(to: destination.appendingPathComponent("ready"))
    // Keep the real screen presented while simctl takes consecutive full-device frames.
    try await eventually(timeout: .seconds(38)) {
      FileManager.default.fileExists(atPath: destination.appendingPathComponent("captured").path)
    }
  }

  private func event(_ sequence: Int, _ type: String, _ text: String, _ run: String, _ date: Date)
    throws -> String
  {
    let payload: [String: Any] =
      type == "input.prompt"
      ? ["userMessage": ["version": 1, "parts": [["type": "text", "text": text]]]]
      : ["content": text]
    return try JSONSerialization.string(withJSONObject: [
      "id": ConversationHistoryFixture.id(sequence),
      "chatThreadId": ConversationHistoryFixture.threadID,
      "seqId": sequence, "eventType": type, "runId": run,
      "createdAt": date.ISO8601Format(), "payload": payload
    ])
  }
}
