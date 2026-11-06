import UIKit
import WebKit

/// A website's first screen as a still, for a result card's cover when the server has no
/// preview image: the web's card shows the live page scaled into the frame; the app draws the
/// page once off screen at a desktop width and keeps the picture and the page's title.
/// One page at a time, in a private data store, so many cards never load many sites at once.
@MainActor
final class SitePreviewSnapshotter: NSObject, WKNavigationDelegate {
  struct Snapshot: Sendable {
    let image: Data?
    let title: String?
  }

  static let shared = SitePreviewSnapshotter()

  /// The page is laid out as a laptop shows it, in the card's 16:9.
  private static let viewport = CGSize(width: 1_280, height: 720)
  private static let settleDelay: Duration = .milliseconds(800)
  private static let timeout: Duration = .seconds(12)

  private var webView: WKWebView?
  private var finished: CheckedContinuation<Bool, Never>?
  /// The page being drawn: callbacks for an earlier page (or the blank page that clears it)
  /// and a timeout that outlived its page are ignored.
  private var navigation: ObjectIdentifier?
  private var attempt = 0
  private var queue: [CheckedContinuation<Void, Never>] = []
  private var busy = false

  func snapshot(_ url: URL) async -> Snapshot? {
    await acquire()
    defer { release() }
    guard !Task.isCancelled, let webView = prepareWebView() else { return nil }
    attempt += 1
    let current = attempt
    let loaded = await withCheckedContinuation { continuation in
      finished = continuation
      navigation = webView.load(URLRequest(url: url, timeoutInterval: 10)).map(
        ObjectIdentifier.init)
      Task { [weak self] in
        try? await Task.sleep(for: Self.timeout)
        guard let self, self.attempt == current else { return }
        self.finish(false, nil)
      }
    }
    navigation = nil
    guard loaded, !Task.isCancelled else {
      webView.stopLoading()
      return nil
    }
    // Web fonts, hero images and entrance animations land just after `load`.
    try? await Task.sleep(for: Self.settleDelay)
    let configuration = WKSnapshotConfiguration()
    configuration.rect = CGRect(origin: .zero, size: Self.viewport)
    configuration.snapshotWidth = 800
    let image = try? await webView.takeSnapshot(configuration: configuration)
    let title = webView.title?.trimmingCharacters(in: .whitespacesAndNewlines)
    webView.loadHTMLString("", baseURL: nil)
    return Snapshot(
      image: image?.jpegData(compressionQuality: 0.85),
      title: title?.isEmpty == false ? title : nil)
  }

  nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    let id = navigation.map(ObjectIdentifier.init)
    MainActor.assumeIsolated { finish(true, id) }
  }

  nonisolated func webView(
    _ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error
  ) {
    let id = navigation.map(ObjectIdentifier.init)
    MainActor.assumeIsolated { finish(false, id) }
  }

  nonisolated func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    let id = navigation.map(ObjectIdentifier.init)
    MainActor.assumeIsolated { finish(false, id) }
  }

  /// `navigation` nil is the timeout, which always ends the current page.
  private func finish(_ loaded: Bool, _ navigation: ObjectIdentifier?) {
    if let navigation, navigation != self.navigation { return }
    finished?.resume(returning: loaded)
    finished = nil
  }

  /// A web view only paints inside a window, so it sits in the key window beyond its left
  /// edge, never taking touches or accessibility focus. It stays opaque: a snapshot keeps the
  /// view's own transparency.
  private func prepareWebView() -> WKWebView? {
    if let webView { return webView }
    guard
      let window = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow)
    else { return nil }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.mediaTypesRequiringUserActionForPlayback = .all
    let view = WKWebView(
      frame: CGRect(origin: CGPoint(x: -Self.viewport.width * 2, y: 0), size: Self.viewport),
      configuration: configuration)
    view.navigationDelegate = self
    view.isUserInteractionEnabled = false
    view.accessibilityElementsHidden = true
    window.addSubview(view)
    webView = view
    return view
  }

  private func acquire() async {
    guard busy else {
      busy = true
      return
    }
    await withCheckedContinuation { queue.append($0) }
  }

  private func release() {
    if queue.isEmpty {
      busy = false
    } else {
      queue.removeFirst().resume()
    }
  }
}
