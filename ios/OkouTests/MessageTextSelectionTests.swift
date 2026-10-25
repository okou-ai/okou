import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class MessageTextSelectionTests: XCTestCase {

  func testQuoteActionOnlyAppearsForAValidAssistantSelectionAndKeepsSystemActions() async throws {
    for role in [ChatMessage.Role.assistant, .user, .system] {
      let message = ChatMessage(
        id: "event", role: role, text: "  Passage  ", createdAt: Date(),
        isQueued: false, isError: role == .system)
      let host = UIHostingController(
        rootView: MessageTextSelectionSheet(
          text: message.copyText, message: message, quote: { _ in }))
      let window = try await mount(host)
      defer { unmount(window) }
      let input = try XCTUnwrap(textView(in: host.view))
      let copy = UIAction(title: "System Copy") { _ in }
      for range in [NSRange(location: 0, length: 2), NSRange(location: 2, length: 7)] {
        input.selectedRange = range
        let menu = try XCTUnwrap(
          input.delegate?.textView?(
            input, editMenuForTextIn: range, suggestedActions: [copy]))
        XCTAssertTrue(menu.children.contains { $0 === copy })
        XCTAssertEqual(
          menu.children.compactMap { $0 as? UIAction }.contains { $0.title == "Quote" },
          role == .assistant && range.location == 2)
      }
    }
  }

  private func mount<V: View>(_ host: UIHostingController<V>) async throws -> UIWindow {
    let window = try await mountNativeHost(host) { window in
      guard let input = self.textView(in: host.view) else { return false }
      return input.window === window
    }
    return window
  }

  private func textView(in view: UIView) -> UITextView? {
    if let input = view as? UITextView { return input }
    return view.subviews.lazy.compactMap { self.textView(in: $0) }.first
  }
}
