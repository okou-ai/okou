import UIKit
import WebKit

/// Partner logos come from the connector catalog CDN as PNG or SVG. UIKit decodes PNG;
/// SVG is rasterised once in an offscreen WebKit view. Results are cached in memory and on
/// disk, keyed by the content-addressed URL, so each logo renders at most once per install.
@MainActor
final class ConnectorIconLoader: NSObject, WKNavigationDelegate {
  static let shared = ConnectorIconLoader()

  private let memory = NSCache<NSURL, UIImage>()
  private var loads: [URL: Task<UIImage?, Never>] = [:]
  private var renders: Task<Void, Never>?
  private var renderer: WKWebView?
  private var navigation: CheckedContinuation<Void, Never>?
  private static let side: CGFloat = 64

  func cachedImage(for url: URL) -> UIImage? { memory.object(forKey: url as NSURL) }

  func image(for url: URL) async -> UIImage? {
    if let cached = cachedImage(for: url) { return cached }
    if let load = loads[url] { return await load.value }
    let load = Task { await self.load(url) }
    loads[url] = load
    let image = await load.value
    loads[url] = nil
    if let image { memory.setObject(image, forKey: url as NSURL) }
    return image
  }

  private func load(_ url: URL) async -> UIImage? {
    let file = Self.cacheFile(for: url)
    if let data = try? Data(contentsOf: file), let image = UIImage(data: data) { return image }
    guard let (data, response) = try? await URLSession.shared.data(from: url),
      (response as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    let image: UIImage?
    if url.pathExtension.lowercased() == "svg" {
      image = await rasterize(svg: data)
    } else {
      image = UIImage(data: data)
    }
    if let image, let png = image.pngData() {
      try? FileManager.default.createDirectory(
        at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? png.write(to: file, options: .atomic)
    }
    return image
  }

  /// One renderer, one logo at a time.
  private func rasterize(svg: Data) async -> UIImage? {
    let previous = renders
    let render = Task { () -> UIImage? in
      await previous?.value
      return await self.render(svg)
    }
    renders = Task { _ = await render.value }
    return await render.value
  }

  private func render(_ svg: Data) async -> UIImage? {
    let side = Self.side
    let web = renderer ?? makeRenderer(side: side)
    renderer = web
    let source = "data:image/svg+xml;base64,\(svg.base64EncodedString())"
    let html = """
      <html><head><meta name="viewport" content="width=\(Int(side)),initial-scale=1">
      <style>html,body{margin:0;padding:0;background:transparent}
      img{display:block;width:\(Int(side))px;height:\(Int(side))px;object-fit:contain}</style>
      </head><body><img src="\(source)"></body></html>
      """
    await withCheckedContinuation { continuation in
      navigation = continuation
      web.loadHTMLString(html, baseURL: nil)
    }
    let configuration = WKSnapshotConfiguration()
    configuration.rect = CGRect(x: 0, y: 0, width: side, height: side)
    configuration.afterScreenUpdates = true
    return try? await web.takeSnapshot(configuration: configuration)
  }

  private func makeRenderer(side: CGFloat) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let web = WKWebView(
      frame: CGRect(x: 0, y: 0, width: side, height: side), configuration: configuration)
    web.isOpaque = false
    web.backgroundColor = .clear
    web.scrollView.backgroundColor = .clear
    web.scrollView.isScrollEnabled = false
    web.navigationDelegate = self
    return web
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { resumeNavigation() }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    resumeNavigation()
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    resumeNavigation()
  }

  private func resumeNavigation() {
    navigation?.resume()
    navigation = nil
  }

  private static func cacheFile(for url: URL) -> URL {
    let name = url.lastPathComponent.replacingOccurrences(of: ".svg", with: "") + ".png"
    return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appending(path: "ConnectorIcons/\(name)")
  }
}
