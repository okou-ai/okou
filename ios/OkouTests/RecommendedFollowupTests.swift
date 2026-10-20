import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class RecommendedFollowupTests: XCTestCase {
  func testNativeButtonsAppendSelectAndFocusWithoutSendingOrGenerating() async throws {
    let fixture = try fixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    conversation.draft = "Keep the context 🧭"
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    try await eventually { self.rail(in: host.view)?.subviews.contains { $0 is UIButton } == true }
    let rail = try XCTUnwrap(rail(in: host.view))
    let buttons = rail.subviews.compactMap { $0 as? UIButton }
    XCTAssertEqual(buttons.count, 5)
    XCTAssertEqual(buttons.map(\.accessibilityLabel), prompts)
    XCTAssertTrue(
      buttons.allSatisfy {
        $0.bounds.height >= 44 && $0.bounds.width <= rail.bounds.width * 0.72 + 1
      })
    XCTAssertGreaterThan(rail.contentSize.width, rail.bounds.width)
    let input = try XCTUnwrap(input(in: host.view))
    buttons[0].sendActions(for: .touchUpInside)
    try await eventually {
      conversation.draft == "Keep the context 🧭\n" + self.prompts[0] && input.isFirstResponder
    }
    XCTAssertEqual(input.selectedRange.length, 0)
    XCTAssertTrue(buttons[0].accessibilityActivate())
    try await eventually {
      (input.text as NSString).substring(with: input.selectedRange) == self.prompts[0]
    }
    XCTAssertEqual(conversation.draft, "Keep the context 🧭\n" + prompts[0])

    // A different recommendation appends at the end, preserving the selected one.
    buttons[1].sendActions(for: .touchUpInside)
    try await eventually { conversation.draft.hasSuffix(self.prompts[0] + "\n" + self.prompts[1]) }
    // Existing text anywhere in the draft is selected rather than rewritten.
    conversation.draft = "Before " + prompts[1] + " after " + prompts[1]
    try await eventually { input.text == conversation.draft }
    buttons[1].sendActions(for: .touchUpInside)
    XCTAssertEqual(
      input.selectedRange, NSRange(location: 7, length: (prompts[1] as NSString).length))
    XCTAssertTrue(input.isFirstResponder)
    input.undoManager?.removeAllActions()
    input.selectedRange = NSRange(location: (input.text as NSString).length, length: 0)
    let longPrompt = prompts[4].trimmingCharacters(in: .whitespacesAndNewlines)
    buttons[4].sendActions(for: .touchUpInside)
    try await eventually { conversation.draft.hasSuffix(longPrompt) }
    input.undoManager?.undo()
    try await eventually { !conversation.draft.hasSuffix(longPrompt) }
    conversation.draft = ""
    try await eventually { input.text.isEmpty }
    buttons[0].sendActions(for: .touchUpInside)
    try await eventually { conversation.draft == self.prompts[0] }
    conversation.draft = "Keep the trailing paragraph\n   "
    try await eventually { input.text == conversation.draft }
    buttons[0].sendActions(for: .touchUpInside)
    try await eventually {
      conversation.draft == "Keep the trailing paragraph\n   " + self.prompts[0]
    }
    XCTAssertFalse(
      fixture.requests.values.withLock {
        $0.contains { $0.contains("/api/chat/events") || $0.contains("generat") }
      })
    attach(window, name: "Native recommendation selection and composer focus")
  }

  func testLateRecommendationsRemeasureAndKeepHistoryPositionAcrossRefresh() async throws {
    let fixture = try fixture(includeFollowups: false, messages: 30)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    while conversation.hasEarlierMessages { await conversation.loadEarlierMessages() }
    let position = ConversationReadingPosition(
      messageID: ConversationHistoryFixture.id(39), offset: -24)
    conversation.rememberReadingPosition(position)
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    try await eventually {
      abs((offset(of: position.messageID, in: host.view) ?? .infinity) - position.offset) < 1
    }
    fixture.append(try followupRow(61))
    await conversation.refresh()
    await stableHostingGeometry(host.view)
    XCTAssertNotNil(conversation.history?.recommendedFollowups)
    XCTAssertEqual(
      offset(of: position.messageID, in: host.view) ?? .infinity, position.offset, accuracy: 1)
    fixture.append(try row(62, type: "output.message", content: "A newer answer"))
    fixture.append(try row(63, type: "run.completed"))
    await conversation.refresh()
    XCTAssertNil(conversation.history?.recommendedFollowups)
    await stableHostingGeometry(host.view)
    XCTAssertEqual(
      offset(of: position.messageID, in: host.view) ?? .infinity, position.offset, accuracy: 1)
  }

  func testNativeRailFitsDynamicTypeAndRemeasuresChangedSourceAtBottom() async throws {
    let fixture = try fixture(includeFollowups: false)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    fixture.append(try followupRow(3))
    await conversation.refresh()
    try await eventually { self.rail(in: host.view)?.bounds.height ?? 0 > 44 }
    let scroll = try XCTUnwrap(markers(in: host.view).first?.enclosingScrollView)
    let rail = try XCTUnwrap(rail(in: host.view))
    let height = rail.bounds.height
    XCTAssertLessThan(
      rail.convert(rail.bounds, to: window).maxY,
      input(in: host.view)?.convert(input(in: host.view)!.bounds, to: window).minY ?? 0)
    attach(window, name: "Native recommendation rail")
    host.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
    try await eventually { self.rail(in: host.view)?.bounds.height ?? 0 > height }
    await stableHostingGeometry(host.view)
    let large = try XCTUnwrap(self.rail(in: host.view))
    for button in large.subviews.compactMap({ $0 as? UIButton }) {
      let title = try XCTUnwrap(
        button.subviews.compactMap { $0 as? UILabel }.first { $0.text?.isEmpty == false })
      XCTAssertEqual(title.numberOfLines, 2)
      XCTAssertLessThanOrEqual(
        title.frame.maxY, button.bounds.height - 11,
        "Title \(title.frame), font \(title.font.pointSize), button \(button.bounds)")
      XCTAssertEqual(button.bounds.height, large.bounds.height, accuracy: 1)
      XCTAssertLessThanOrEqual(button.bounds.width, large.bounds.width * 0.72 + 1)
      XCTAssertNotNil(button.accessibilityLabel)
    }
    XCTAssertLessThanOrEqual(
      scroll.contentSize.height - scroll.contentOffset.y - scroll.bounds.height
        + scroll.adjustedContentInset.bottom, 2)
    attach(window, name: "Accessibility Dynamic Type recommendation rail")
    let previousWidth = large.bounds.width
    window.frame.size.width = 520
    host.view.setNeedsLayout()
    host.view.layoutIfNeeded()
    try await eventually { self.rail(in: host.view)?.bounds.width != previousWidth }
    await stableHostingGeometry(host.view)
    let resized = try XCTUnwrap(self.rail(in: host.view))
    for button in resized.subviews.compactMap({ $0 as? UIButton }) {
      let title = try XCTUnwrap(
        button.subviews.compactMap { $0 as? UILabel }.first { $0.text?.isEmpty == false })
      XCTAssertLessThanOrEqual(title.frame.maxY, button.bounds.height - 11)
    }
  }

  private var prompts: [String] {
    [
      "Create a presentation outline", "Create an image with the approved direction",
      "Build a website for the launch", "Package the remaining launch artifacts",
      "What risks should we discuss next? "
        + String(repeating: "Long suggestion text. ", count: 20),
    ]
  }

  private func fixture(includeFollowups: Bool = true, messages: Int = 1) throws
    -> ConversationHistoryFixture
  {
    var rows: [String] = []
    for index in 1...messages {
      let run = index == messages ? "run" : "run-\(index)"
      rows.append(
        try row(
          index * 2 - 1, type: "output.message",
          content: "Answer \(index)\n\n" + String(repeating: "Context to read. ", count: 12),
          run: run))
      rows.append(try row(index * 2, type: "run.completed", run: run))
    }
    if includeFollowups { rows.append(try followupRow(messages * 2 + 1)) }
    return ConversationHistoryFixture(rows: rows)
  }

  private func followupRow(_ seq: Int) throws -> String {
    let followups: [[String: String]] = zip(
      prompts, ["presentation", "image", "website", "", "talk"]
    ).map { prompt, type in
      var item = ["prompt": prompt, "kind": type == "talk" ? "talk" : "generate"]
      if type != "talk" && !type.isEmpty { item["generationType"] = type }
      return item
    }
    let content = String(
      decoding: try JSONSerialization.data(withJSONObject: ["version": 1, "followups": followups]),
      as: UTF8.self)
    return try row(seq, type: "output.followups", content: content)
  }

  private func row(_ seq: Int, type: String, content: String? = nil, run: String = "run") throws
    -> String
  {
    let data = try JSONSerialization.data(withJSONObject: [
      "id": ConversationHistoryFixture.id(seq), "chatThreadId": ConversationHistoryFixture.threadID,
      "runId": run, "seqId": seq, "createdAt": "2026-10-20T00:00:00Z", "eventType": type,
      "payload": content.map { ["content": $0] } ?? [:],
    ])
    return String(decoding: data, as: UTF8.self)
  }

  private func rail(in view: UIView) -> RecommendedFollowupRailView? {
    if let rail = view as? RecommendedFollowupRailView, enclosingCell(rail) != nil { return rail }
    return view.subviews.lazy.compactMap { self.rail(in: $0) }.first
  }

  private func input(in view: UIView) -> ComposerTextView? {
    (view as? ComposerTextView) ?? view.subviews.lazy.compactMap { self.input(in: $0) }.first
  }

  private func attach(_ window: UIWindow, name: String) {
    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
