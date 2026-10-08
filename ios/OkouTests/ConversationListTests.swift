import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ConversationListTests: XCTestCase {
  func testReadingPositionUpdatesWhenMarkersAppearAfterScrollingSettles() async throws {
    let anchor = ConversationScrollAnchor()
    let model = LateMarkerProbeModel()
    let host = UIHostingController(rootView: LateMarkerProbe(model: model, anchor: anchor))
    let window = try await mount(host)
    defer {
      anchor.readingPositionDidChange = nil
      anchor.cancel()
      unmount(window)
    }
    let scroll = try XCTUnwrap(markers(in: host.view).first?.enclosingScrollView)
    let initialBounds = scroll.bounds
    let initialSize = scroll.contentSize
    var reportedPosition = anchor.capture()
    XCTAssertEqual(reportedPosition?.messageID, "1")
    XCTAssertNil(anchor.preservedPosition)
    anchor.readingPositionDidChange = { reportedPosition = $0 }
    model.showsFirstMarker = true
    try await eventually { reportedPosition?.messageID == "0" }
    XCTAssertEqual(scroll.bounds, initialBounds)
    XCTAssertEqual(scroll.contentSize, initialSize)
    XCTAssertEqual(reportedPosition, anchor.capture())
  }

  func testReadingCaptureWaitsForMeasurementsMatchingTheNativeViewport() async throws {
    let anchor = ConversationScrollAnchor()
    let scroll = ConversationCollectionScroll()
    let rows = (0..<6).map { index in
      ConversationCollectionRow.message(
        ChatMessage(
          id: "viewport-\(index)", role: .user, text: "Message \(index)", createdAt: .distantPast,
          runID: nil, isQueued: false, isError: false),
        showsAvatar: false, topSpacing: 0, pendingRetry: nil, isSending: false)
    }
    let markdown = MessageMarkdownCache(
      baseURL: try XCTUnwrap(URL(string: "https://app.example.invalid")))
    let host = UIHostingController(
      rootView: ConversationCollectionView(
        rows: rows, markdown: markdown, anchor: anchor, scroll: scroll, followsBottom: false,
        phaseChanged: { _ in }, metricsChanged: { _ in }, refresh: {}
      ) { row, anchor in
        if let message = row.message {
          Text(message.text)
            .frame(maxWidth: .infinity, minHeight: 180, maxHeight: 180)
            .background {
              if let anchor { ConversationRowAnchor(messageID: message.id, anchor: anchor) }
            }
        }
      })
    let window = try await mount(host)
    defer { unmount(window) }
    let collection = try XCTUnwrap(
      markers(in: host.view).first?.enclosingScrollView as? UICollectionView)
    XCTAssertNotNil(anchor.capture())
    // Native bounds can update before the controller commits measured rows for
    // the new width. That intermediate geometry must not become a saved reading.
    let originalBounds = collection.bounds
    collection.bounds.size.width = 520
    XCTAssertNil(anchor.capture())
    collection.bounds = originalBounds
    window.frame.size.width = 520
    host.view.setNeedsLayout()
    host.view.layoutIfNeeded()
    try await eventually { anchor.capture() != nil }
    XCTAssertEqual(collection.bounds.width, 520)
  }

  func testConversationKeepsMeasuredSizesAcrossReusedMarkdownRows() async throws {
    let fixture = ConversationHistoryFixture(count: 30)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    while conversation.hasEarlierMessages { await conversation.loadEarlierMessages() }
    conversation.rememberReadingPosition(
      ConversationReadingPosition(
        messageID: ConversationHistoryFixture.id(25), offset: -42))
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mount(host)
    defer { unmount(window) }
    let scroll = try XCTUnwrap(markers(in: host.view).first?.enclosingScrollView)
    XCTAssertTrue(scroll.accessibilityScroll(.up))
    try await eventually {
      conversation.readingPosition?.messageID != ConversationHistoryFixture.id(25)
    }
    await stableHostingGeometry(host.view)
    let height = scroll.contentSize.height
    var measured: [String: CGFloat] = [:]
    let directions: [UIAccessibilityScrollDirection] = [
      .up, .up, .up, .up, .down, .down, .down, .down, .up,
    ]
    for direction in directions {
      let before = scroll.contentOffset.y
      XCTAssertTrue(scroll.accessibilityScroll(direction))
      try await eventually { abs(scroll.contentOffset.y - before) > 1 }
      await stableHostingGeometry(host.view)
      // Stable geometry can precede the scroll delegate's completion on a cold
      // renderer. Wait for the saved reading position to match the viewport
      // before starting another action or changing its width/font.
      try await savedReadingPositionMatchesViewport(conversation, in: host.view)
      XCTAssertEqual(scroll.contentSize.height, height, accuracy: 1)
      for row in markers(in: host.view) where row.window != nil {
        guard let cell = enclosingCell(row), cell.frame.intersects(scroll.bounds) else { continue }
        if let previous = measured[row.messageID] {
          XCTAssertEqual(cell.bounds.height, previous, accuracy: 1, row.messageID)
        }
        measured[row.messageID] = cell.bounds.height
      }
    }
    XCTAssertGreaterThan(measured.count, 10)

    let position = try XCTUnwrap(conversation.readingPosition)
    let originalWidth = scroll.bounds.width
    window.frame.size.width = 520
    host.view.setNeedsLayout()
    host.view.layoutIfNeeded()
    try await eventually {
      scroll.bounds.width != originalWidth && scroll.contentSize.height != height
    }
    await stableHostingGeometry(host.view)
    try await eventually(
      message: readingDescription(position.messageID, conversation: conversation, view: host.view)
    ) {
      abs((offset(of: position.messageID, in: host.view) ?? .infinity) - position.offset) < 1
    }
    XCTAssertEqual(
      offset(of: position.messageID, in: host.view) ?? .infinity, position.offset, accuracy: 1)
    let resizedHeight = scroll.contentSize.height
    XCTAssertNotEqual(resizedHeight, height)
    let before = scroll.contentOffset.y
    XCTAssertTrue(scroll.accessibilityScroll(.up))
    try await eventually { abs(scroll.contentOffset.y - before) > 1 }
    await stableHostingGeometry(host.view)
    try await savedReadingPositionMatchesViewport(conversation, in: host.view)
    XCTAssertEqual(scroll.contentSize.height, resizedHeight, accuracy: 1)

    let resizedPosition = try XCTUnwrap(conversation.readingPosition)
    host.traitOverrides.preferredContentSizeCategory = .extraExtraExtraLarge
    try await eventually { scroll.contentSize.height != resizedHeight }
    await stableHostingGeometry(host.view)
    try await eventually(
      message: readingDescription(
        resizedPosition.messageID, conversation: conversation, view: host.view)
    ) {
      abs(
        (offset(of: resizedPosition.messageID, in: host.view) ?? .infinity) - resizedPosition.offset
      )
        < 1
    }
    XCTAssertEqual(
      offset(of: resizedPosition.messageID, in: host.view) ?? .infinity,
      resizedPosition.offset, accuracy: 1)
  }

  func testNativeListPreservesPartialRowAcrossPrependAndHeightChanges() async throws {
    let model = ListProbeModel()
    let anchor = ConversationScrollAnchor()
    let host = UIHostingController(rootView: ListProbe(model: model, anchor: anchor))
    let window = try await mount(host)
    defer { unmount(window) }
    try await eventually { anchor.capture() != nil }
    let scroll = try XCTUnwrap(markers(in: host.view).first?.enclosingScrollView)
    scroll.setContentOffset(CGPoint(x: 0, y: 140), animated: false)
    try await eventually { anchor.capture()?.offset ?? 0 < -20 }
    let position = try XCTUnwrap(anchor.capture())
    let initialHeight = scroll.contentSize.height
    anchor.preserve(position)
    model.ids = Array(0..<40)
    try await eventually {
      scroll.contentSize.height > initialHeight
        && anchor.capture()?.messageID == position.messageID
        && abs((anchor.capture()?.offset ?? .infinity) - position.offset) < 1
    }
    XCTAssertEqual(anchor.capture()?.messageID, position.messageID)
    model.extraHeight = 60
    try await eventually {
      let row = markers(in: host.view).first { $0.messageID == position.messageID }
      return row?.bounds.height ?? 0 > 150
        && abs((anchor.capture()?.offset ?? .infinity) - position.offset) < 1
    }
    XCTAssertEqual(anchor.capture()?.messageID, position.messageID)
    anchor.cancel()
    scroll.setContentOffset(CGPoint(x: 0, y: scroll.contentOffset.y + 100), animated: false)
    try await eventually { anchor.capture() != position }
  }

  func testConversationRestoresResidentReadingPositionAndPreservesItDuringExpansionAndRefresh()
    async throws
  {
    let fixture = ConversationHistoryFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    let position = ConversationReadingPosition(
      messageID: ConversationHistoryFixture.id(95), offset: -42)
    conversation.rememberReadingPosition(position)
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mount(host)
    defer { unmount(window) }
    try await eventually(
      message: readingDescription(position.messageID, conversation: conversation, view: host.view)
    ) {
      abs((offset(of: position.messageID, in: host.view) ?? .infinity) - position.offset) < 1
    }
    await conversation.loadEarlierMessages()
    try await eventually(
      message: readingDescription(position.messageID, conversation: conversation, view: host.view)
    ) {
      conversation.visibleMessages.first?.id == ConversationHistoryFixture.id(81)
        && abs((offset(of: position.messageID, in: host.view) ?? .infinity) - position.offset) < 1
    }
    fixture.appendMessage()
    await conversation.refresh()
    try await eventually(
      message: readingDescription(position.messageID, conversation: conversation, view: host.view)
    ) {
      abs((offset(of: position.messageID, in: host.view) ?? .infinity) - position.offset) < 1
    }
    XCTAssertEqual(conversation.messages.count, 101)
    XCTAssertEqual(conversation.visibleMessages.count, 21)
    XCTAssertEqual(conversation.readingPosition, position)

    // Recreate the detail view as navigation does, while retaining its conversation store.
    unmount(window)
    let reopened = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let reopenedWindow = try await mount(reopened)
    defer { unmount(reopenedWindow) }
    try await eventually(
      message: readingDescription(
        position.messageID, conversation: conversation, view: reopened.view)
    ) {
      abs((offset(of: position.messageID, in: reopened.view) ?? .infinity) - position.offset) < 1
    }
    XCTAssertEqual(conversation.visibleMessages.count, 21)

    fixture.revoke(95)
    await conversation.refresh()
    try await eventually(
      message: readingDescription(
        ConversationHistoryFixture.id(96), conversation: conversation, view: reopened.view)
    ) {
      abs(
        (offset(of: ConversationHistoryFixture.id(96), in: reopened.view) ?? .infinity)
          - position.offset) < 1
    }
    conversation.draft = "My next message"
    await conversation.send()
    let pending = try XCTUnwrap(conversation.pending.first)
    try await eventually {
      guard let y = offset(of: pending.id, in: reopened.view) else { return false }
      return y >= 0 && y < reopened.view.bounds.height
    }
    XCTAssertTrue(pending.needsRetry)
    XCTAssertNil(conversation.readingPosition)
    try await eventually {
      guard let scroll = markers(in: reopened.view).first?.enclosingScrollView else { return false }
      return scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.maxY
        <= 20
    }
    let scroll = try XCTUnwrap(markers(in: reopened.view).first?.enclosingScrollView)
    let viewportHeight = scroll.bounds.height
    reopenedWindow.frame.size.height = 620
    reopened.view.setNeedsLayout()
    reopened.view.layoutIfNeeded()
    try await eventually {
      scroll.bounds.height < viewportHeight
        && scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.maxY <= 20
    }
    conversation.resetRenderWindowToLatest()
    XCTAssertEqual(
      conversation.visibleMessages.map(\.id),
      (90...101).filter { $0 != 95 }.map(ConversationHistoryFixture.id) + [pending.id])
    try await eventually {
      guard let y = offset(of: pending.id, in: reopened.view) else { return false }
      return y >= 0 && y < reopened.view.bounds.height
    }
  }
}

@MainActor
private func savedReadingPositionMatchesViewport(_ conversation: ConversationStore, in view: UIView)
  async throws
{
  try await eventually(
    message: readingDescription(
      conversation.readingPosition?.messageID ?? "<missing>", conversation: conversation, view: view
    )
  ) {
    guard let saved = conversation.readingPosition,
      let actual = offset(of: saved.messageID, in: view)
    else { return false }
    return abs(actual - saved.offset) < 1
  }
}

@MainActor
private func enclosingCell(_ view: UIView) -> UICollectionViewCell? {
  var ancestor = view.superview
  while let parent = ancestor {
    if let cell = parent as? UICollectionViewCell { return cell }
    ancestor = parent.superview
  }
  return nil
}

@MainActor
private func mount<V: View>(_ host: UIHostingController<V>) async throws -> UIWindow {
  let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
  let window = UIWindow(windowScene: scene)
  window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
  window.rootViewController = host
  window.makeKeyAndVisible()
  host.view.layoutIfNeeded()
  await stableHostingGeometry(host.view)
  return window
}

@MainActor
private func stableHostingGeometry(_ view: UIView) async {
  var previous: [CGRect] = []
  var stableSamples = 0
  for _ in 0..<120 {
    await hostingPresentationFrame()
    let rows = markers(in: view).filter { $0.window != nil }
    guard let scroll = rows.first?.enclosingScrollView, !scroll.bounds.isEmpty else { continue }
    let geometry =
      [scroll.bounds, CGRect(origin: .zero, size: scroll.contentSize)]
      + rows.sorted { $0.messageID < $1.messageID }.map { $0.convert($0.bounds, to: scroll) }
    stableSamples = geometry == previous ? stableSamples + 1 : 0
    previous = geometry
    if stableSamples >= 2 { return }
  }
  XCTFail("Native hosting geometry did not settle within 120 presentation frames")
}

@MainActor
private func hostingPresentationFrame() async {
  // Display-link callbacks prepare upcoming frames. Span a complete presented frame
  // before sampling geometry, including cold SwiftUI pipeline compilation on CI.
  await withCheckedContinuation { continuation in
    let target = HostingDisplayFrame(continuation)
    let link = CADisplayLink(target: target, selector: #selector(HostingDisplayFrame.display(_:)))
    link.add(to: .main, forMode: .common)
  }
}

@MainActor
private final class HostingDisplayFrame: NSObject {
  private let continuation: CheckedContinuation<Void, Never>
  private var remainingCallbacks = 2
  init(_ continuation: CheckedContinuation<Void, Never>) { self.continuation = continuation }
  @objc func display(_ link: CADisplayLink) {
    remainingCallbacks -= 1
    guard remainingCallbacks == 0 else { return }
    link.invalidate()
    let continuation = continuation
    DispatchQueue.main.async { continuation.resume() }
  }
}

@MainActor
private func unmount(_ window: UIWindow) {
  window.isHidden = true
  window.rootViewController = nil
}

@MainActor
private func markers(in view: UIView) -> [ConversationRowMarker] {
  allMarkers(in: view).filter(isPresentedRow)
}

@MainActor
private func allMarkers(in view: UIView) -> [ConversationRowMarker] {
  (view as? ConversationRowMarker).map { [$0] } ?? view.subviews.flatMap { allMarkers(in: $0) }
}

@MainActor
private func isPresentedRow(_ row: ConversationRowMarker) -> Bool {
  guard row.window != nil else { return false }
  guard let collection = row.enclosingScrollView as? UICollectionView else { return true }
  // Reconfiguration can retain an old hosting cell in the hierarchy after its
  // replacement is presented. Sample the cell currently owned by the collection.
  guard let cell = enclosingCell(row), let indexPath = collection.indexPath(for: cell) else {
    return false
  }
  guard collection.cellForItem(at: indexPath) === cell,
    collection.visibleCells.contains(where: { $0 === cell }),
    row.convert(row.bounds, to: cell).intersects(cell.bounds)
  else { return false }
  if let dataSource = collection.dataSource as? UICollectionViewDiffableDataSource<Int, String> {
    return dataSource.itemIdentifier(for: indexPath) == row.messageID
  }
  return true
}

@MainActor
private func offset(of id: String, in view: UIView) -> CGFloat? {
  let matching = markers(in: view).filter { $0.messageID == id }
  guard matching.count == 1, let row = matching.first,
    let scroll = row.enclosingScrollView
  else { return nil }
  return row.convert(row.bounds, to: scroll).minY - scroll.bounds.minY
    - scroll.adjustedContentInset.top
}

@MainActor
private func readingDescription(_ id: String, conversation: ConversationStore, view: UIView)
  -> String
{
  let scroll = markers(in: view).first?.enclosingScrollView
  let matching = allMarkers(in: view).filter { $0.messageID == id }.map { row in
    let cell = enclosingCell(row)
    let collection = row.enclosingScrollView as? UICollectionView
    let item: String? =
      if let collection, let cell, let indexPath = collection.indexPath(for: cell),
        let dataSource = collection.dataSource as? UICollectionViewDiffableDataSource<Int, String>
      {
        dataSource.itemIdentifier(for: indexPath)
      } else { nil }
    let visible =
      cell.map { candidate in
        collection?.visibleCells.contains(where: { $0 === candidate }) ?? false
      } ?? false
    return "\(row.bounds); window: \(row.window != nil); hidden: \(row.isHidden); "
      + "presented cell: \(isPresentedRow(row)); "
      + "visible cell: \(visible); cell frame: \(String(describing: cell?.frame)); "
      + "native item: \(String(describing: item)); "
      + "cell rect: \(String(describing: cell.map { row.convert(row.bounds, to: $0) })); "
      + "rect: \(String(describing: scroll.map { row.convert(row.bounds, to: $0) }))"
  }
  return "Reading position: \(String(describing: conversation.readingPosition)); "
    + "row offset: \(String(describing: offset(of: id, in: view))); "
    + "viewport: \(String(describing: scroll?.bounds)); "
    + "content size: \(String(describing: scroll?.contentSize)); matches: \(matching)"
}

@MainActor
private func eventually(
  file: StaticString = #filePath, line: UInt = #line, message: @autoclosure () -> String = "",
  _ predicate: () -> Bool
)
  async throws
{
  let deadline = ContinuousClock.now + .seconds(3)
  while !predicate() && ContinuousClock.now < deadline {
    await hostingPresentationFrame()
  }
  XCTAssertTrue(predicate(), message(), file: file, line: line)
}

@MainActor @Observable
private final class LateMarkerProbeModel {
  var showsFirstMarker = false
}

private struct LateMarkerProbe: View {
  let model: LateMarkerProbeModel
  let anchor: ConversationScrollAnchor

  var body: some View {
    ScrollView {
      VStack(spacing: 0) {
        ForEach(0..<10) { index in
          Text("Message \(index)")
            .frame(maxWidth: .infinity, minHeight: 100, maxHeight: 100)
            .background {
              if index != 0 || model.showsFirstMarker {
                ConversationRowAnchor(messageID: String(index), anchor: anchor)
              }
            }
        }
      }
    }
  }
}

@MainActor @Observable
private final class ListProbeModel {
  var ids = Array(20..<40)
  var extraHeight: CGFloat = 0
}

private struct ListProbe: View {
  var model: ListProbeModel
  let anchor: ConversationScrollAnchor
  var body: some View {
    ScrollViewReader { proxy in
      List(model.ids.map(String.init), id: \.self) { messageID in
        let id = Int(messageID)!
        Text("Message \(id)")
          .frame(height: (id.isMultiple(of: 3) ? 170 : 95) + model.extraHeight)
          .background(ConversationRowAnchor(messageID: messageID, anchor: anchor))
      }.listStyle(.plain)
        .onAppear { anchor.revealRow = { proxy.scrollTo($0, anchor: .top) } }
        .onChange(of: model.ids) { _, _ in
          if let position = anchor.preservedPosition { anchor.restore(position) }
        }
        .onScrollGeometryChange(for: CGSize.self) {
          $0.contentSize
        } action: { _, _ in
          anchor.layoutDidChange()
        }
        .onDisappear {
          anchor.cancel()
          anchor.revealRow = nil
        }
    }
  }
}
