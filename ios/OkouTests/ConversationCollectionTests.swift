import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ConversationCollectionTests: XCTestCase {
  func testInitialInsetsAllowAnEmptyTranscriptToPresentItsFirstMessage() async throws {
    let measurements = ConversationMeasurementCache()
    var emptyPresented = false
    let host = UIHostingController(
      rootView: transcript(rows: [], measurements: measurements) { id in
        emptyPresented = id == nil
      })
    let window = try await mountNativeHost(host) { _ in emptyPresented }
    defer { unmount(window) }

    let message = message()
    var presentedID: String?
    host.rootView = transcript(rows: [row(message)], measurements: measurements) { id in
      presentedID = id
    }
    try await eventually { presentedID == message.id }
  }

  func testReopeningAMeasuredTranscriptWithInsetsPresentsItsMessage() async throws {
    let measurements = ConversationMeasurementCache()
    let message = message()
    let rows = [row(message)]
    var presentedID: String?
    let original = UIHostingController(
      rootView: transcript(rows: rows, measurements: measurements) { id in
        presentedID = id
      })
    let originalWindow = try await mountNativeHost(original) { _ in presentedID == message.id }
    defer { unmount(originalWindow) }
    unmount(originalWindow)

    // Real presentation populates the conversation-owned measurements reused by a new list.
    var reopenedID: String?
    let reopened = UIHostingController(
      rootView: transcript(rows: rows, measurements: measurements) { id in
        reopenedID = id
      })
    let reopenedWindow = try await mountNativeHost(reopened) { _ in reopenedID == message.id }
    defer { unmount(reopenedWindow) }
  }

  private func transcript(
    rows: [ConversationCollectionRow], measurements: ConversationMeasurementCache,
    rowsPresented: @escaping (String?) -> Void
  ) -> ConversationCollectionView<Text> {
    let origin = URL(string: "https://conversation-layout.invalid")!
    return ConversationCollectionView(
      rows: rows, markdown: MessageMarkdownCache(baseURL: origin),
      renderContext: { _ in
        MessageRenderPlan.Context(
          webURL: origin, action: nil, permissionsEnabled: false, artifacts: nil)
      },
      measurements: measurements,
      contentInsets: EdgeInsets(top: 64, leading: 0, bottom: 80, trailing: 0),
      anchor: ConversationScrollAnchor(), scroll: ConversationCollectionScroll(),
      followsBottom: false, phaseChanged: { _ in }, metricsChanged: { _ in },
      rowsPresented: rowsPresented, refresh: {},
      content: { row, _ in
        Text(row.message?.text ?? "")
      })
  }

  private func message() -> ChatMessage {
    ChatMessage(
      id: UUID().uuidString, role: .user, text: "A message that survives reopening the chat.",
      createdAt: .now, isQueued: false, isError: false)
  }

  private func row(_ message: ChatMessage) -> ConversationCollectionRow {
    .message(
      message, showsAvatar: false, topSpacing: 20, pendingRetry: nil, isSending: false)
  }
}
