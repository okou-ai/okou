import ChatDomain
import Foundation
import XCTest

final class ChatUserMessageTests: XCTestCase {
  func testVisiblePartsKeepTheirInlineOrderAndSnapshotsWithoutPrivateContext() throws {
    let document = ChatUserMessage(parts: [
      .init(type: "text", text: "Ask "),
      .init(type: "agent", nameSnapshot: "Release Scout", agentId: identity(20)),
      .init(type: "text", text: " about "),
      .init(type: "chat_thread", titleSnapshot: "The release", threadId: identity(21)),
      .init(type: "text", text: " using "),
      .init(type: "template", titleSnapshot: "Original style"),
      .init(type: "additional_info", text: "Private machine context"),
      .init(type: "source", kind: "slack", href: "https://example.slack.com/archives/C1/p1"),
      .init(type: "model", selectedModel: "model-a"),
    ])
    let message = try XCTUnwrap(history([document]).messages.first)
    XCTAssertEqual(message.text, "Ask Release Scout about The release using Original style")
    XCTAssertEqual(message.userMessage, document)
    XCTAssertEqual(message.userMessage?.annotation?.kind, "slack")
    XCTAssertEqual(message.userMessage?.bodyParts.count, 6)
    XCTAssertFalse(message.text.contains("Private machine context"))
  }

  func testSourceOnlyMessagesAndAutomationBriefsRemainVisible() throws {
    let source = ChatUserMessage(parts: [.init(type: "source", kind: "mcp", clientName: "Research")]
    )
    let automation = ChatUserMessage(parts: [
      .init(
        type: "automation", workflowName: "Morning brief", workflowId: identity(30),
        automationBrief: "  A new matching email arrived.  ")
    ])
    let result = try history([source, automation])
    XCTAssertEqual(result.messages.count, 2)
    XCTAssertEqual(result.messages[0].text, "")
    XCTAssertEqual(result.messages[0].userMessage?.annotation?.clientName, "Research")
    XCTAssertEqual(result.messages[1].text, "A new matching email arrived.")
    XCTAssertEqual(result.messages[1].userMessage?.annotation?.workflowId, identity(30))
    XCTAssertEqual(result.messages[1].userMessage?.annotation?.workflowName, "Morning brief")
  }

  func testExplicitAutomationBodyTakesPrecedenceOverTheTriggerBrief() throws {
    let document = ChatUserMessage(parts: [
      .init(type: "text", text: "Review the release"),
      .init(type: "automation", workflowName: "Nightly review", automationBrief: "Trigger context"),
    ])
    XCTAssertEqual(try history([document]).messages.first?.text, "Review the release")
  }

  func testFeedbackAndTemplateOnlyMessagesAreNotDropped() throws {
    let quote = ChatUserMessage(parts: [
      .init(
        type: "feedback", quote: "The selected passage",
        note: [
          .init(type: "text", text: "Compare with "),
          .init(type: "chat_thread", titleSnapshot: "Earlier plan", threadId: identity(32)),
        ])
    ])
    let template = ChatUserMessage(parts: [.init(type: "template", titleSnapshot: "Editorial")])
    let messages = try history([quote, template]).messages
    XCTAssertEqual(messages.count, 2)
    XCTAssertTrue(messages[0].text.contains("The selected passage"))
    XCTAssertTrue(messages[0].text.contains("Compare with Earlier plan"))
    XCTAssertEqual(messages[0].userMessage?.bodyParts.first?.note?.last?.threadId, identity(32))
    XCTAssertEqual(messages[1].text, "Editorial")
  }

  func testHiddenContextAloneDoesNotProduceAUserBubble() throws {
    let document = ChatUserMessage(parts: [
      .init(type: "additional_info", text: "Private context"),
      .init(type: "model", selectedModel: "model-a"),
    ])
    XCTAssertTrue(try history([document]).messages.isEmpty)
  }

  func testAnnotatedFilesKeepTheOriginalIdentityAndUseTheRenderedDerivative() throws {
    let document = ChatUserMessage(parts: [
      .init(
        type: "file", fileId: "original-file", contentType: "image/jpeg",
        filenameSnapshot: "marked-photo.jpg", annotatedFileId: "annotated-file")
    ])
    let attachment = try XCTUnwrap(history([document]).messages.first?.attachments.first)
    XCTAssertEqual(attachment.id, "original-file")
    XCTAssertEqual(attachment.downloadID, "annotated-file")
    XCTAssertEqual(attachment.contentType, "image/png")
    XCTAssertEqual(attachment.filename, "marked-photo.jpg")
  }

  func testModelAndFastModeChangesFollowNewRunBoundaries() throws {
    func row(_ index: Int, model: String, tier: String? = nil, run: Int) -> ChatEvent {
      ChatEvent(
        id: identity(index), runId: identity(run), createdAt: .now, eventType: .inputPrompt,
        payload: .init(
          userMessage: .init(parts: [
            .init(type: "text", text: "Message \(index)"),
            .init(type: "model", selectedModel: model, serviceTier: tier),
          ])))
    }
    let messages = try ChatEventProjection.history(
      rows: [
        row(1, model: "model-a", run: 10),
        row(2, model: "model-b", run: 10),
        row(3, model: "model-a", tier: "priority", run: 11),
        row(4, model: "model-b", tier: "priority", run: 12),
        row(5, model: "model-b", tier: "ultrafast", run: 13),
      ], recovering: false
    ).messages
    XCTAssertNil(messages[0].modelChange)
    XCTAssertNil(messages[1].modelChange)
    XCTAssertEqual(messages[2].modelChange, .fastMode(true))
    guard case .model(let changed) = messages[3].modelChange else {
      return XCTFail("A new run must expose its model change")
    }
    XCTAssertEqual(changed.id, "model-b")
    XCTAssertTrue(changed.isFast)
    XCTAssertEqual(messages[4].modelChange, .fastMode(false))
  }

  func testRejectedInputKeepsItsDocumentAndSeparatesItsError() throws {
    let document = ChatUserMessage(parts: [.init(type: "template", titleSnapshot: "The template")])
    let result = try ChatEventProjection.history(
      rows: [
        .init(
          id: identity(1), createdAt: .now, eventType: .inputRejected,
          payload: .init(error: "Unavailable", userMessage: document))
      ], recovering: false)
    let message = try XCTUnwrap(result.messages.first)
    XCTAssertEqual(message.userMessage, document)
    XCTAssertEqual(message.inputError, "Unavailable")
    XCTAssertTrue(message.isError)
  }

  func testCapturedAutoAliasesDoNotIntroduceAnExtraModelChange() throws {
    let documents = ["auto", "okou-1.0", "auto"].map { id in
      ChatUserMessage(parts: [
        .init(type: "text", text: "Continue"), .init(type: "model", selectedModel: id),
      ])
    }
    XCTAssertTrue(try history(documents).messages.allSatisfy { $0.modelChange == nil })
  }

  private func history(_ documents: [ChatUserMessage]) throws -> ChatHistory {
    try ChatEventProjection.history(
      rows: documents.enumerated().map { index, document in
        ChatEvent(
          id: identity(index + 1), createdAt: .now, eventType: .inputPrompt,
          payload: .init(userMessage: document))
      }, recovering: false)
  }

  private func identity(_ index: Int) -> String {
    String(format: "40000000-0000-4000-8000-%012d", index)
  }
}
