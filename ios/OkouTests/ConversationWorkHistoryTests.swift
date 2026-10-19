import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ConversationWorkHistoryTests: XCTestCase {
  func testNativeTranscriptFoldsWorkAndPreservesItsControlDuringExpansionAndRefresh() async throws {
    let fixture = ConversationHistoryFixture(rows: [
      try row(1, type: "input.prompt", text: "Review the release"),
      try row(
        2, text: "Collected the requirements.\n\n" + String(repeating: "Earlier work. ", count: 60)),
      try row(3, text: "Checked the release checks."),
      try row(
        4, text: "## Result\n\n" + String(repeating: "The result remains visible.\n\n", count: 30)),
    ])
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertNil(conversation.error)
    let section = try XCTUnwrap(conversation.history?.workSections.first)
    let position = ConversationReadingPosition(messageID: section.id, offset: 0)
    conversation.rememberReadingPosition(position)
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    let collection = try XCTUnwrap(
      markers(in: host.view).first?.enclosingScrollView as? UICollectionView)
    try await eventually { abs(offset(of: section.id, in: host.view) ?? .infinity) < 1 }
    XCTAssertEqual(
      try rowIDs(collection),
      [
        ConversationHistoryFixture.id(1), section.id, ConversationHistoryFixture.id(4),
        "conversation-bottom",
      ])

    conversation.toggleWorkHistory(section.id)
    try await eventually {
      (try? self.rowIDs(collection).contains(ConversationHistoryFixture.id(2))) == true
    }
    try await savedReadingPositionMatchesViewport(conversation, in: host.view)
    XCTAssertEqual(offset(of: section.id, in: host.view) ?? .infinity, 0, accuracy: 1)

    fixture.append(
      try row(5, text: "## Updated result\n\n" + String(repeating: "New result.\n\n", count: 30)))
    await conversation.refresh()
    try await eventually {
      (try? self.rowIDs(collection).contains(ConversationHistoryFixture.id(5))) == true
    }
    XCTAssertTrue(try rowIDs(collection).contains(ConversationHistoryFixture.id(2)))
    try await savedReadingPositionMatchesViewport(conversation, in: host.view)

    conversation.toggleWorkHistory(section.id)
    try await eventually {
      (try? self.rowIDs(collection).contains(ConversationHistoryFixture.id(2))) == false
    }
    XCTAssertFalse(try rowIDs(collection).contains(ConversationHistoryFixture.id(4)))
    XCTAssertTrue(try rowIDs(collection).contains(ConversationHistoryFixture.id(5)))
    try await savedReadingPositionMatchesViewport(conversation, in: host.view)
    XCTAssertEqual(offset(of: section.id, in: host.view) ?? .infinity, 0, accuracy: 1)
  }

  func testStoppingProducesOneInlineOutcomeOutsideFoldedWork() async throws {
    let fixture = ConversationHistoryFixture(rows: [
      try row(1, type: "input.prompt", text: "Review the release"),
      try row(2, text: "Checking dependencies"),
      try row(3, text: "Here is the partial result"),
      try row(4, type: "run.cancelled"),
    ])
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    let section = try XCTUnwrap(conversation.history?.workSections.first)
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    let collection = try XCTUnwrap(
      markers(in: host.view).first?.enclosingScrollView as? UICollectionView)
    try await eventually {
      (try? self.rowIDs(collection).contains(ConversationHistoryFixture.id(4))) == true
    }
    XCTAssertFalse(try rowIDs(collection).contains(ConversationHistoryFixture.id(2)))
    XCTAssertTrue(try rowIDs(collection).contains(section.id))
    XCTAssertEqual(
      conversation.visibleMessages.filter { $0.role == .system }.map(\.text), ["Task stopped."])
  }

  private func rowIDs(_ collection: UICollectionView) throws -> [String] {
    let dataSource = try XCTUnwrap(
      collection.dataSource as? UICollectionViewDiffableDataSource<Int, String>)
    return dataSource.snapshot().itemIdentifiers
  }

  private func row(_ sequence: Int, type: String = "output.message", text: String = "") throws
    -> String
  {
    let payload: String
    if type == "input.prompt" {
      let encodedText = String(decoding: try JSONEncoder().encode(text), as: UTF8.self)
      payload =
        "{\"userMessage\":{\"version\":1,\"parts\":[{\"type\":\"text\",\"text\":\(encodedText)}]}}"
    } else {
      payload = String(decoding: try JSONEncoder().encode(["content": text]), as: UTF8.self)
    }
    return """
      {"id":"\(ConversationHistoryFixture.id(sequence))","chatThreadId":"\(ConversationHistoryFixture.threadID)","runId":"70000000-0000-4000-8000-000000000001","seqId":\(sequence),"createdAt":"2026-10-19T00:00:\(String(format: "%02d", sequence)).000Z","eventType":"\(type)","payload":\(payload)}
      """
  }
}
