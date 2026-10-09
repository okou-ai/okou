import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
func savedReadingPositionMatchesViewport(_ conversation: ConversationStore, in view: UIView)
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
func enclosingCell(_ view: UIView) -> UICollectionViewCell? {
  var ancestor = view.superview
  while let parent = ancestor {
    if let cell = parent as? UICollectionViewCell { return cell }
    ancestor = parent.superview
  }
  return nil
}

@MainActor
func mountConversationHost<V: View>(_ host: UIHostingController<V>) async throws -> UIWindow {
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
func stableHostingGeometry(_ view: UIView) async {
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
func unmount(_ window: UIWindow) {
  window.isHidden = true
  window.rootViewController = nil
}

@MainActor
func markers(in view: UIView) -> [ConversationRowMarker] {
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
func offset(of id: String, in view: UIView) -> CGFloat? {
  let matching = markers(in: view).filter { $0.messageID == id }
  guard matching.count == 1, let row = matching.first,
    let scroll = row.enclosingScrollView
  else { return nil }
  return row.convert(row.bounds, to: scroll).minY - scroll.bounds.minY
    - scroll.adjustedContentInset.top
}

@MainActor
func readingDescription(_ id: String, conversation: ConversationStore, view: UIView)
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
func eventually(
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
