import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ConversationSendTransitionTests: XCTestCase {
  func testSendingCommitsMarkedTextToTheRequestAndEndsNativeEditing() async throws {
    let fixture = SendTransitionFixture()
    defer { fixture.close() }
    try await fixture.mount()
    let input = try XCTUnwrap(fixture.inputs.first)
    try await focusMentionInput(input)
    input.insertText("A multiline message\nwith a second line")
    try await eventually { input.isFirstResponder }
    input.setMarkedText("待确认", selectedRange: NSRange(location: 3, length: 0))
    try await eventually { input.markedTextRange != nil }
    await fixture.conversation.send()
    let data = try XCTUnwrap(fixture.remote.requests.sentMessages.withLock { $0.first })
    let message = try JSONDecoder().decode(CapturedSend.self, from: data)
    XCTAssertTrue(message.userMessage.text.contains("A multiline message"))
    XCTAssertTrue(message.userMessage.text.contains("待确认"))
    try await eventually {
      fixture.inputs.first?.text.isEmpty == true
        && !fixture.inputs.contains(where: \.isFirstResponder)
    }
  }

  private struct CapturedSend: Decodable { let userMessage: ChatDraftDocument }

}

@MainActor
private final class SendTransitionFixture {
  let remote = ConversationHistoryFixture(count: 30)
  let conversation: ConversationStore
  let host: UIHostingController<SendTransitionProbe>
  private(set) var window: UIWindow?

  init() {
    let conversation = remote.conversation()
    self.conversation = conversation
    host = UIHostingController(rootView: SendTransitionProbe(conversation: conversation))
  }

  var inputs: [ComposerTextView] { mentionInputs(in: host.view) }

  func mount() async throws {
    await conversation.refresh()
    window = try await mountNativeHost(host) { window in
      self.inputs.first?.window === window
    }
  }

  func close() {
    if let window { unmount(window) }
    conversation.close()
  }
}

private struct SendTransitionProbe: View {
  let conversation: ConversationStore

  var body: some View {
    ChatComposerView(
      draft: Binding(get: { conversation.draft }, set: { conversation.draft = $0 }),
      isBusy: conversation.isSending, showsProgress: false, canStop: false, needsUpgrade: false,
      error: conversation.error, attachmentURL: conversation.webURL,
      attachments: conversation.attachmentDraft, draftState: conversation.composer,
      submit: { await conversation.send() }, refresh: nil
    )
    .frame(maxHeight: .infinity, alignment: .bottom)
  }
}
