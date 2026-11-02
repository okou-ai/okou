import SwiftUI
import WebKit

/// Generated HTML runs in its own ephemeral WebKit session, with no app tokens or native bridge.
struct ArtifactWebView: UIViewRepresentable {
  let url: URL
  let didFail: @MainActor (String, Int?) -> Void
  let loadingChanged: @MainActor (Bool) -> Void
  @Environment(\.openURL) private var openURL

  func makeCoordinator() -> Coordinator {
    Coordinator(url: url, openURL: openURL, didFail: didFail, loadingChanged: loadingChanged)
  }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.allowsInlineMediaPlayback = true
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.uiDelegate = context.coordinator
    view.allowsBackForwardNavigationGestures = true
    view.isInspectable = false
    view.accessibilityIdentifier = "artifact-html-preview"
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.httpShouldHandleCookies = false
    view.load(request)
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {}

  static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
    view.stopLoading()
    view.navigationDelegate = nil
    view.uiDelegate = nil
    view.loadHTMLString("", baseURL: nil)
  }

  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    let initialURL: URL
    let openURL: OpenURLAction
    let didFail: @MainActor (String, Int?) -> Void
    let loadingChanged: @MainActor (Bool) -> Void

    init(
      url: URL, openURL: OpenURLAction, didFail: @escaping @MainActor (String, Int?) -> Void,
      loadingChanged: @escaping @MainActor (Bool) -> Void
    ) {
      initialURL = url
      self.openURL = openURL
      self.didFail = didFail
      self.loadingChanged = loadingChanged
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async
      -> WKNavigationActionPolicy
    {
      guard let url = action.request.url else { return .cancel }
      let sameOrigin =
        url.scheme == initialURL.scheme && url.host == initialURL.host
        && (url.port ?? (url.scheme == "https" ? 443 : 80))
          == (initialURL.port ?? (initialURL.scheme == "https" ? 443 : 80))
      let isNetwork =
        url.scheme == "https"
        || (url.scheme == "http" && ["127.0.0.1", "localhost", "::1"].contains(url.host ?? ""))
      if action.targetFrame?.isMainFrame == false,
        isNetwork || url.absoluteString == "about:blank"
      {
        return .allow
      }
      // Keep slides, hashes, scripts and relative pages in the content's isolated origin.
      // An external link requires a user's link activation before handing off to the system browser.
      if isNetwork && sameOrigin && action.targetFrame != nil { return .allow }
      if action.navigationType == .linkActivated,
        ["https", "http", "mailto"].contains(url.scheme ?? "")
      {
        openURL(url)
      }
      loadingChanged(false)
      return .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async
      -> WKNavigationResponsePolicy
    {
      if let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
        loadingChanged(false)
        didFail(
          [401, 403].contains(http.statusCode)
            ? "This preview address expired or access changed. Retry to authorize it again."
            : "This page could not be loaded (\(http.statusCode)).", http.statusCode)
        return .cancel
      }
      if !response.canShowMIMEType {
        loadingChanged(false)
        didFail("This page cannot be displayed. Download it to share or save to Files.", nil)
        return .cancel
      }
      return .allow
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
      loadingChanged(true)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      loadingChanged(false)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
      report(error)
    }
    func webView(
      _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
      withError error: Error
    ) {
      report(error)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
      loadingChanged(false)
      didFail("The page stopped responding. Retry to reload it.", nil)
    }
    private func report(_ error: Error) {
      if (error as? URLError)?.code != .cancelled {
        loadingChanged(false)
        let failure = error as NSError
        didFail(
          failure.domain == "WebKitErrorDomain" && failure.code == 102
            ? "Page navigation was interrupted. Retry or open the page in your browser."
            : error.localizedDescription, nil)
      }
    }
  }
}
