import Foundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// An image document lets WebKit tile large originals and play animated images without allocating
/// a full bitmap in the app. The document can read only its own directory and has no network access.
final class LocalImageDocument: Sendable {
  let directory: URL
  let page: URL

  nonisolated init?(image: URL) throws {
    // A downloaded attachment keeps its display name, which may have no extension.
    let source = CGImageSourceCreateWithURL(image as CFURL, nil)
    let detectedType = source.flatMap { CGImageSourceGetType($0) }.flatMap { UTType($0 as String) }
    let ext = detectedType?.preferredFilenameExtension ?? image.pathExtension.lowercased()
    let types = [
      "png", "apng", "jpg", "jpeg", "gif", "webp", "avif", "heic", "heif", "svg", "bmp", "tiff",
      "tif", "ico"
    ]
    guard types.contains(ext) else { return nil }
    let files = FileManager.default
    directory = files.temporaryDirectory.appendingPathComponent(
      UUID().uuidString, isDirectory: true)
    page = directory.appendingPathComponent("index.html")
    try files.createDirectory(at: directory, withIntermediateDirectories: true)
    do {
      let name = "image.\(ext)"
      let asset = directory.appendingPathComponent(name)
      // Both the import and the download cache are app-owned local files. A hard link retains the
      // original without copying a large attachment or widening WebKit's file access.
      try files.linkItem(at: image, to: asset)
      let label = String(localized: "Image. Pinch to zoom, or double tap.")
      let html = """
        <!doctype html><html><head>
        <meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=8">
        <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'">
        <style>html,body,img{width:100%;height:100%;margin:0}img{display:block;object-fit:contain}</style>
        </head><body><img src="\(name)" alt="\(label)"></body></html>
        """
      try html.write(to: page, atomically: true, encoding: .utf8)
    } catch {
      try? files.removeItem(at: directory)
      throw error
    }
  }

  deinit { try? FileManager.default.removeItem(at: directory) }
}

struct MessageWebImage: UIViewRepresentable {
  let document: LocalImageDocument

  func makeUIView(context: Context) -> MessageImageWebView {
    MessageImageWebView(document: document)
  }

  func updateUIView(_ view: MessageImageWebView, context: Context) {
    view.handlePan = context.environment.imagePreviewPan
  }
}

/// WebKit owns pinch and pan inside the image. Observe the same native scroll view for dismissal.
final class MessageImageWebView: WKWebView {
  var handlePan: (@MainActor (UIPanGestureRecognizer) -> Void)?
  private let panDelegate = ImagePreviewPan.Coordinator()

  init(document: LocalImageDocument) {
    let configuration = WKWebViewConfiguration()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = false
    configuration.websiteDataStore = .nonPersistent()
    super.init(frame: .zero, configuration: configuration)
    isOpaque = false
    backgroundColor = .clear
    scrollView.backgroundColor = .clear
    scrollView.contentInsetAdjustmentBehavior = .never
    let pan = UIPanGestureRecognizer(target: self, action: #selector(didPan(_:)))
    panDelegate.configure(pan)
    scrollView.addGestureRecognizer(pan)
    scrollView.panGestureRecognizer.require(toFail: pan)
    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
    doubleTap.numberOfTapsRequired = 2
    scrollView.addGestureRecognizer(doubleTap)
    loadFileURL(document.page, allowingReadAccessTo: document.directory)
  }

  required init?(coder: NSCoder) { nil }

  @objc private func didPan(_ pan: UIPanGestureRecognizer) { handlePan?(pan) }

  @objc private func toggleZoom(_ tap: UITapGestureRecognizer) {
    let fit = scrollView.minimumZoomScale
    if scrollView.zoomScale > fit * 1.01 {
      scrollView.setZoomScale(fit, animated: true)
    } else {
      let scale = min(scrollView.maximumZoomScale, fit * 3)
      let point = tap.location(in: scrollView)
      let width = bounds.width / scale
      let height = bounds.height / scale
      scrollView.zoom(
        to: CGRect(x: point.x - width / 2, y: point.y - height / 2, width: width, height: height),
        animated: true)
    }
  }
}
