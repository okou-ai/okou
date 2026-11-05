import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ConversationCollectionTests: XCTestCase {
  func testInitialInsetsAllowAnEmptyTranscriptToPresentItsFirstMessage() async throws {
    let measurements = ConversationMeasurementCache()
    let emptyPresented = expectation(description: "The empty transcript is ready")
    let host = UIHostingController(
      rootView: transcript(rows: [], measurements: measurements) { id in
        XCTAssertNil(id)
        emptyPresented.fulfill()
      })
    let window = try await mountNativeHost(host)
    defer { unmount(window) }
    await fulfillment(of: [emptyPresented], timeout: 3)

    let message = message()
    let messagePresented = expectation(description: "The first message is presented")
    host.rootView = transcript(rows: [row(message)], measurements: measurements) { id in
      XCTAssertEqual(id, message.id)
      messagePresented.fulfill()
    }
    await fulfillment(of: [messagePresented], timeout: 3)
  }

  func testReopeningAMeasuredTranscriptWithInsetsPresentsItsMessage() async throws {
    let measurements = ConversationMeasurementCache()
    let message = message()
    let rows = [row(message)]
    let initiallyPresented = expectation(description: "The message is initially presented")
    let original = UIHostingController(
      rootView: transcript(rows: rows, measurements: measurements) { id in
        XCTAssertEqual(id, message.id)
        initiallyPresented.fulfill()
      })
    let originalWindow = try await mountNativeHost(original)
    defer { unmount(originalWindow) }
    await fulfillment(of: [initiallyPresented], timeout: 3)
    unmount(originalWindow)

    // Real presentation populates the conversation-owned measurements reused by a new list.
    let reopenedPresented = expectation(description: "The reopened message is presented")
    let reopened = UIHostingController(
      rootView: transcript(rows: rows, measurements: measurements) { id in
        XCTAssertEqual(id, message.id)
        reopenedPresented.fulfill()
      })
    let reopenedWindow = try await mountNativeHost(reopened)
    defer { unmount(reopenedWindow) }
    await fulfillment(of: [reopenedPresented], timeout: 3)
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
      rowsPresented: rowsPresented, refresh: {}
    ) { row, _ in
      Text(row.message?.text ?? "")
    }
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
