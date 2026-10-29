import BeautifulMermaid
import UIKit

/// Serial native layout and a bounded, workspace-owned image cache. No JavaScript or WebView.
actor MessageMermaidRenderer {
  private struct Key: Hashable {
    let code: String
    let dark: Bool
  }

  private var images: [Key: Data] = [:]
  private var order: [Key] = []
  private var cost = 0
  private let costLimit = 16 * 1024 * 1024

  func image(for code: String, dark: Bool) throws -> Data? {
    try Task.checkCancellation()
    let key = Key(code: code, dark: dark)
    if let image = images[key] { return image }
    // Oversized or unsupported diagrams retain their full, copyable source instead of
    // blocking the conversation or allocating an unbounded bitmap.
    guard code.utf8.count <= 50_000, code.split(separator: "\n").count <= 500 else { return nil }
    let renderer = MermaidImageRenderer(theme: dark ? .zincDark : .zincLight)
    guard let prepared = try renderer.prepare(from: code) else { return nil }
    let bounds = prepared.bounds
    guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0 else {
      return nil
    }
    let scale = min(
      2, 4096 / max(bounds.width, bounds.height), sqrt(4_000_000 / (bounds.width * bounds.height)))
    let size = CGSize(width: ceil(bounds.width * scale), height: ceil(bounds.height * scale))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
      context.cgContext.scaleBy(x: scale, y: scale)
      prepared.render(context.cgContext, bounds)
    }
    try Task.checkCancellation()
    guard let data = image.pngData() else { return nil }
    while !order.isEmpty && (cost + data.count > costLimit || order.count >= 64) {
      let oldest = order.removeFirst()
      cost -= images.removeValue(forKey: oldest)?.count ?? 0
    }
    if data.count <= costLimit {
      images[key] = data
      order.append(key)
      cost += data.count
    }
    return data
  }
}
