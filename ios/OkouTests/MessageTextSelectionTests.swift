import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class MessageTextSelectionTests: XCTestCase {
  func testNativeSelectionCopiesOnlyTheSelectedPassageAcrossParagraphs() async throws {
    let passage = "第二段 👋 要复制的文字。\n\n第三段也在选区中。"
    let text = "第一段保留。\n\n" + passage + "\n\n最后一段不复制。"
    let host = UIHostingController(
      rootView: MessageTextSelectionSheet(text: text).preferredColorScheme(.light))
    let window = try await mount(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(textView(in: host.view))
    input.becomeFirstResponder()
    try await eventually { input.isFirstResponder }
    input.selectedRange = (text as NSString).range(of: passage)
    XCTAssertTrue(
      input.canPerformAction(#selector(UIResponderStandardEditActions.copy(_:)), withSender: nil))
    input.copy(nil)
    defer { UIPasteboard.general.items = [] }
    XCTAssertEqual(UIPasteboard.general.string, passage)
    XCTAssertEqual(input.text, text)
    XCTAssertFalse(
      input.canPerformAction(#selector(UIResponderStandardEditActions.cut(_:)), withSender: nil))
    XCTAssertFalse(
      input.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil))

    host.rootView = MessageTextSelectionSheet(text: text).preferredColorScheme(.dark)
    try await eventually {
      self.textView(in: host.view)?.traitCollection.userInterfaceStyle == .dark
    }
    let current = try XCTUnwrap(textView(in: host.view))
    current.copy(nil)
    XCTAssertEqual(UIPasteboard.general.string, passage)
  }

  func testSelectAllKeepsLiteralTextAndCanScrollThroughALongMessage() async throws {
    let text = String(repeating: "**Literal text** 中文 👋\n\n", count: 120) + "Last line"
    let host = UIHostingController(rootView: MessageTextSelectionSheet(text: text))
    let window = try await mount(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(textView(in: host.view))
    XCTAssertGreaterThan(input.contentSize.height, input.bounds.height)
    input.becomeFirstResponder()
    try await eventually { input.isFirstResponder }
    input.selectAll(nil)
    input.copy(nil)
    defer { UIPasteboard.general.items = [] }
    XCTAssertEqual(UIPasteboard.general.string, text)
    input.scrollRangeToVisible((text as NSString).range(of: "Last line"))
    try await eventually { input.contentOffset.y > 0 }
    XCTAssertEqual(input.text, text)
  }

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
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    try await eventually {
      guard let input = self.textView(in: host.view) else { return false }
      return input.window != nil && input.bounds.height > 0 && input.contentSize.height > 0
    }
    return window
  }

  private func textView(in view: UIView) -> UITextView? {
    if let input = view as? UITextView { return input }
    return view.subviews.lazy.compactMap { self.textView(in: $0) }.first
  }
}
