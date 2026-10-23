import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ConversationSendTransitionTests: XCTestCase {
  func testSendingCommitsMarkedTextToTheRequestAndEndsNativeEditing() async throws {
    let fixture = SendTransitionFixture()
    _ = try await fixture.mount()
    defer { fixture.close() }
    let input = try XCTUnwrap(fixture.inputs.first)
    input.becomeFirstResponder()
    input.insertText("A multiline message\nwith a second line")
    try await eventually { input.isFirstResponder }
    input.setMarkedText("待确认", selectedRange: NSRange(location: 3, length: 0))
    try await eventually { input.markedTextRange != nil }
    await fixture.scrolling.send()
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
private func presentedOffset(_ collection: UICollectionView) -> CGFloat {
  collection.layer.presentation()?.bounds.minY ?? collection.bounds.minY
}

@MainActor
private final class SendMotionRecorder: NSObject {
  private weak var collection: UICollectionView?
  private var displayLink: CADisplayLink?
  private(set) var offsets: [CGFloat] = []
  private(set) var nativeOffsets: [CGFloat] = []
  private(set) var bottomTargets: [CGFloat] = []
  private(set) var frameTimes: [CFTimeInterval] = []
  private var firstFrame: CFTimeInterval?

  init(_ collection: UICollectionView) {
    self.collection = collection
    super.init()
    let link = CADisplayLink(target: self, selector: #selector(sample(_:)))
    displayLink = link
    link.add(to: .main, forMode: .common)
  }

  @objc private func sample(_ link: CADisplayLink) {
    guard let collection else {
      stop()
      return
    }
    offsets.append(presentedOffset(collection))
    nativeOffsets.append(collection.contentOffset.y)
    bottomTargets.append(
      collection.contentSize.height + collection.adjustedContentInset.bottom
        - collection.bounds.height)
    let origin = firstFrame ?? link.timestamp
    firstFrame = origin
    frameTimes.append(link.timestamp - origin)
  }

  func stop() {
    displayLink?.invalidate()
    displayLink = nil
  }
}

@MainActor
private final class SendTransitionFixture {
  let remote = ConversationHistoryFixture(count: 30)
  let conversation: ConversationStore
  let scrolling: ConversationScrollCoordinator
  let host: UIHostingController<SendTransitionProbe>
  private(set) var window: UIWindow?

  init() {
    let conversation = remote.conversation()
    self.conversation = conversation
    let scrolling = ConversationScrollCoordinator(conversation: conversation)
    self.scrolling = scrolling
    host = UIHostingController(
      rootView: SendTransitionProbe(conversation: conversation, scrolling: scrolling))
  }

  var inputs: [ComposerTextView] { textInputs(in: host.view) }

  func mount() async throws -> UICollectionView {
    await conversation.refresh()
    window = try await mountConversationHost(host)
    let collection = try XCTUnwrap(
      markers(in: host.view).first?.enclosingScrollView as? UICollectionView)
    try await eventually {
      collection.contentSize.height + collection.adjustedContentInset.bottom
        - collection.bounds.maxY <= 1
    }
    return collection
  }

  func contains(_ id: String, in collection: UICollectionView) -> Bool {
    (collection.dataSource as? UICollectionViewDiffableDataSource<Int, String>)?
      .indexPath(for: id) != nil
  }

  func assertFinished(_ id: String, in collection: UICollectionView) async throws {
    try await eventually {
      self.contains(id, in: collection)
        && abs(
          collection.contentSize.height + collection.adjustedContentInset.bottom
            - collection.bounds.maxY) <= 1
        && abs(presentedOffset(collection) - collection.contentOffset.y) < 1
    }
    try await eventually {
      guard let row = markers(in: self.host.view).first(where: { $0.messageID == id }) else {
        return false
      }
      let rect = row.convert(row.bounds, to: collection)
      return rect.maxY > collection.bounds.minY + collection.adjustedContentInset.top
        && rect.minY < collection.bounds.maxY - collection.adjustedContentInset.bottom
    }
  }

  func close() {
    if let window { unmount(window) }
    conversation.close()
  }

  private func textInputs(in view: UIView) -> [ComposerTextView] {
    if let input = view as? ComposerTextView { return [input] }
    return view.subviews.flatMap { textInputs(in: $0) }
  }
}

private struct SendTransitionProbe: View {
  let conversation: ConversationStore
  let scrolling: ConversationScrollCoordinator
  @State private var composerHeight: CGFloat = 0

  var body: some View {
    let rows =
      conversation.visibleMessages.map {
        ConversationCollectionRow.message(
          $0, showsAvatar: false, topSpacing: 0, pendingRetry: nil, isSending: false)
      } + [.footer(.idle)]
    ConversationCollectionView(
      rows: rows, markdown: conversation.messageMarkdown,
      contentInsets: EdgeInsets(top: 0, leading: 0, bottom: composerHeight, trailing: 0),
      anchor: scrolling.anchor, scroll: scrolling.scroll, followsBottom: scrolling.followsBottom,
      sendTransition: scrolling.sendTransition,
      phaseChanged: scrolling.phaseChanged, metricsChanged: scrolling.metricsChanged,
      refresh: { await conversation.refresh() }
    ) { row, anchor in
      if let message = row.message {
        Text(message.text)
          .frame(maxWidth: .infinity, minHeight: 120)
          .background {
            if let anchor { ConversationRowAnchor(messageID: message.id, anchor: anchor) }
          }
      } else {
        Color.clear.frame(height: 20)
      }
    }
    .ignoresSafeArea(.container, edges: .vertical)
    .safeAreaBar(edge: .bottom, spacing: 0) {
      ChatComposerView(
        draft: Binding(get: { conversation.draft }, set: { conversation.draft = $0 }),
        isBusy: conversation.isSending, showsProgress: false, canStop: false, needsUpgrade: false,
        error: conversation.error, attachmentURL: conversation.webURL,
        attachments: conversation.attachmentDraft, draftState: conversation.composer,
        submit: { await scrolling.send() }, refresh: nil, sendTransition: scrolling.sendTransition
      )
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        composerHeight = $0
      }
    }
    .onAppear { scrolling.activate(reduceMotion: false) }
    .task(id: conversation.visibleMessages.last) { await scrolling.latestMessageChanged() }
    .onChange(of: conversation.visibleMessages) { _, _ in scrolling.messagesChanged() }
    .onDisappear { scrolling.deactivate() }
  }
}
