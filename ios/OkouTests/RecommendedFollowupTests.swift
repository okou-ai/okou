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
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    try await eventually { self.rail(in: host.view)?.subviews.contains { $0 is UIButton } == true }
    let input = try XCTUnwrap(input(in: host.view))
    try await focusMentionInput(input)
    input.insertText("Keep the context 🧭")
    let rail = try XCTUnwrap(rail(in: host.view))
    let buttons = rail.subviews.compactMap { $0 as? UIButton }
    XCTAssertEqual(buttons.count, 5)
    XCTAssertEqual(buttons.map(\.accessibilityLabel), prompts)
    XCTAssertNotNil(buttons[0].window)
    buttons[0].sendActions(for: .touchUpInside)
    try await eventually {
      input.text == "Keep the context 🧭\n" + self.prompts[0] && input.isFirstResponder
    }
    XCTAssertEqual(input.selectedRange.length, 0)
    XCTAssertTrue(buttons[0].accessibilityActivate())
    try await eventually {
      (input.text as NSString).substring(with: input.selectedRange) == self.prompts[0]
    }
    XCTAssertEqual(input.text, "Keep the context 🧭\n" + prompts[0])

    // A different recommendation appends at the end, preserving the selected one.
    buttons[1].sendActions(for: .touchUpInside)
    try await eventually { (input.text ?? "").hasSuffix(self.prompts[0] + "\n" + self.prompts[1]) }
    // Existing text anywhere in the draft is selected rather than rewritten.
    replaceInput("Before " + prompts[1] + " after " + prompts[1], in: input)
    buttons[1].sendActions(for: .touchUpInside)
    XCTAssertEqual(
      input.selectedRange, NSRange(location: 7, length: (prompts[1] as NSString).length))
    XCTAssertTrue(input.isFirstResponder)
    input.undoManager?.removeAllActions()
    input.selectedRange = NSRange(location: (input.text as NSString).length, length: 0)
    let longPrompt = prompts[4].trimmingCharacters(in: .whitespacesAndNewlines)
    buttons[4].sendActions(for: .touchUpInside)
    try await eventually { (input.text ?? "").hasSuffix(longPrompt) }
    input.undoManager?.undo()
    try await eventually { !(input.text ?? "").hasSuffix(longPrompt) }
    replaceInput("", in: input)
    try await eventually { input.text.isEmpty }
    XCTAssertNotNil(buttons[0].window)
    buttons[0].sendActions(for: .touchUpInside)
    try await eventually { input.text == self.prompts[0] }
    replaceInput("Keep the trailing paragraph\n   ", in: input)
    XCTAssertNotNil(buttons[0].window)
    buttons[0].sendActions(for: .touchUpInside)
    try await eventually {
      input.text == "Keep the trailing paragraph\n   " + self.prompts[0]
    }
    XCTAssertFalse(
      fixture.requests.values.withLock {
        $0.contains { $0.contains("/api/chat/events") || $0.contains("generat") }
      })
  }

  private func replaceInput(_ text: String, in input: ComposerTextView) {
    input.selectedRange = NSRange(location: 0, length: input.text.utf16.count)
    if text.isEmpty { input.deleteBackward() } else { input.insertText(text) }
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
