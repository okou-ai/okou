import CoreFoundation
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
func hostingPresentationFrame() async {
  // Display-link callbacks prepare upcoming frames. Span a complete presented frame
  // before interacting with native controls on CI.
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
  window.endEditing(true)
  window.isHidden = true
  window.rootViewController = nil
}

@MainActor
private enum NativePredicatePolling {
  static let usesRunLoop: Bool = {
    let enabled = ProcessInfo.processInfo.environment["IOS_NATIVE_RUN_LOOP_POLLING"] == "true"
    if enabled { print("iOS native predicate polling: main run loop") }
    return enabled
  }()
}

@MainActor
private func nativeObservationTurn() async {
  await withCheckedContinuation { continuation in
    // Observe after the current main-loop work, without awaiting GPU presentation.
    let observer = CFRunLoopObserverCreateWithHandler(
      kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, false, CFIndex.max
    ) { _, _ in
      continuation.resume()
    }
    precondition(observer != nil, "Unable to observe the main run loop")
    CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
  }
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
  while !predicate() && ContinuousClock.now < deadline {
    if NativePredicatePolling.usesRunLoop {
      await nativeObservationTurn()
    } else {
      await hostingPresentationFrame()
    }
  }
  _ = try XCTUnwrap(predicate() ? true : nil, message(), file: file, line: line)
}
