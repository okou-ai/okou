import SwiftUI
import XCTest

@testable import Okou

@MainActor
func nativeViews(in view: UIView) -> [UIView] {
  [view] + view.subviews.flatMap { nativeViews(in: $0) }
}

@MainActor
func mountNativeHost<V: View>(
  _ host: UIHostingController<V>, timeout: Duration = .seconds(3),
  ready: @MainActor (UIWindow) -> Bool = { _ in true }
) async throws -> UIWindow {
  let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
  let window = UIWindow(windowScene: scene)
  window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
  window.rootViewController = host
  window.makeKeyAndVisible()
  host.view.backgroundColor = .systemBackground
  host.view.layoutIfNeeded()
  await hostingPresentationFrame()
  do {
    try await eventually(timeout: timeout, message: "The native host did not become ready") {
      ready(window)
    }
  } catch {
    unmount(window)
    throw error
  }
  return window
}

/// A test restores the pasteboard it acquired, including when an assertion throws.
@MainActor
func preserveNativePasteboard(for test: XCTestCase) {
  let previous = UIPasteboard.general.items
  test.addTeardownBlock { @MainActor in UIPasteboard.general.items = previous }
}
