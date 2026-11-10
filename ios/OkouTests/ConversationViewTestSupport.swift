import SwiftUI
import XCTest

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
func unmount(_ window: UIWindow) {
  window.endEditing(true)
  window.isHidden = true
  window.rootViewController = nil
}

@MainActor
func eventually(
  timeout: Duration = .seconds(3), file: StaticString = #filePath, line: UInt = #line,
  message: @autoclosure () -> String = "",
  _ predicate: @escaping @MainActor () -> Bool
) async throws {
  try Task.checkCancellation()
  if predicate() { return }
  let duration = timeout.components
  let seconds = Double(duration.seconds) + Double(duration.attoseconds) / 1e18
  let result: XCTWaiter.Result
  if timeout > .zero {
    // XCTest evaluates on the creating main run loop. Observe native readiness
    // without requiring rendering or repeating the action under test.
    let ready = XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in MainActor.assumeIsolated { predicate() } })
    result = await XCTWaiter.fulfillment(of: [ready], timeout: seconds)
  } else {
    result = .timedOut
  }
  try Task.checkCancellation()
  _ = try XCTUnwrap(
    result == .completed && predicate() ? true : nil, message(), file: file, line: line)
}
