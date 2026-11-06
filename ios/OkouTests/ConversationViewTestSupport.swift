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
func hostingPresentationFrame(
  timeout: Duration = .seconds(3), file: StaticString = #filePath, line: UInt = #line
) async throws {
  // Display-link callbacks prepare upcoming frames. Span a complete presented frame
  // before interacting with native controls, but let XCTest own the deadline.
  try Task.checkCancellation()
  let presented = XCTestExpectation(description: "The native host presented a frame")
  let target = HostingDisplayFrame(presented)
  let link = CADisplayLink(target: target, selector: #selector(HostingDisplayFrame.display(_:)))
  defer { link.invalidate() }
  link.add(to: .main, forMode: .common)
  let duration = timeout.components
  let seconds = Double(duration.seconds) + Double(duration.attoseconds) / 1e18
  let result: XCTWaiter.Result
  if timeout > .zero {
    result = await XCTWaiter.fulfillment(of: [presented], timeout: seconds)
  } else {
    result = .timedOut
  }
  try Task.checkCancellation()
  _ = try XCTUnwrap(
    result == .completed ? true : nil, "The native host did not present a frame",
    file: file, line: line)
}

@MainActor
private final class HostingDisplayFrame: NSObject {
  private let presented: XCTestExpectation
  private var remainingCallbacks = 2
  init(_ presented: XCTestExpectation) { self.presented = presented }
  @objc func display(_ link: CADisplayLink) {
    remainingCallbacks -= 1
    guard remainingCallbacks == 0 else { return }
    link.invalidate()
    let presented = presented
    DispatchQueue.main.async { presented.fulfill() }
  }
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
  _ predicate: () -> Bool
)
  async throws
{
  let deadline = ContinuousClock.now + timeout
  while !predicate() {
    try Task.checkCancellation()
    let remaining = ContinuousClock.now.duration(to: deadline)
    guard remaining > .zero else { break }
    try await hostingPresentationFrame(timeout: remaining, file: file, line: line)
  }
  _ = try XCTUnwrap(predicate() ? true : nil, message(), file: file, line: line)
}
