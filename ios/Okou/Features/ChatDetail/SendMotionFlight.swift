import SwiftUI
import UIKit

/// Moves outgoing text from the native editor to the collection's measured bubble.
@MainActor final class SendMotionFlight {
  weak var destination: UIView?
  weak var collection: UICollectionView?
  var messageFrame: CGRect?
  private weak var source: ComposerTextView?
  private weak var window: UIWindow?
  private let bubble = UIView()
  private let text = UILabel()
  private let origin: CGRect
  private let originalText: NSAttributedString
  private let originFont: UIFont
  private let targetFont: UIFont

  init?(source: ComposerTextView) {
    guard let window = source.window, source.bounds.width > 0 else { return nil }
    self.source = source
    self.window = window
    originalText = source.attributedText
    originFont = source.font ?? .systemFont(ofSize: 16)
    targetFont = .preferredFont(forTextStyle: .body, compatibleWith: source.traitCollection)
    let insets = source.textContainerInset
    let maxWidth = source.bounds.width - insets.left - insets.right
    let measured = source.attributedText.boundingRect(
      with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).integral
    let glyphs = CGRect(x: insets.left, y: insets.top - source.contentOffset.y,
      width: min(maxWidth, measured.width), height: min(source.bounds.height, measured.height))
    origin = source.convert(glyphs, to: window).insetBy(dx: -14, dy: -14)
    bubble.frame = origin
    bubble.backgroundColor = .clear
    bubble.layer.cornerRadius = 16
    bubble.layer.cornerCurve = .continuous
    bubble.isUserInteractionEnabled = false
    bubble.isAccessibilityElement = false
    bubble.accessibilityElementsHidden = true
    text.attributedText = source.attributedText
    text.numberOfLines = 0
    text.lineBreakMode = .byWordWrapping
    text.frame = bubble.bounds.insetBy(dx: 14, dy: 14)
    text.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    bubble.addSubview(text)
    window.addSubview(bubble)
    source.alpha = 0
  }

  func measuredBubbleSize(width: CGFloat) -> CGSize {
    let maxWidth = (width - 40) * 0.85
    let measured = NSAttributedString(string: originalText.string, attributes: [.font: targetFont])
      .boundingRect(with: CGSize(width: maxWidth - 28, height: .greatestFiniteMagnitude),
        options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).integral
    return CGSize(width: min(maxWidth, measured.width + 28), height: measured.height + 28)
  }

  func present(fraction: CGFloat, remainingScroll: CGFloat) {
    guard let window else { return }
    var target: CGRect
    if let destination, destination.window === window,
      destination.bounds.width > 0, destination.bounds.height > 0 {
      target = destination.convert(destination.bounds, to: window)
    } else if let collection, let messageFrame {
      let size = measuredBubbleSize(width: collection.bounds.width)
      let rect = CGRect(x: collection.bounds.width - 20 - size.width,
        y: messageFrame.minY, width: size.width, height: size.height)
      target = collection.convert(rect, to: window)
    } else {
      return
    }
    target.origin.y -= remainingScroll
    let p = fraction
    if source?.text.isEmpty == true { source?.alpha = 1 }
    let drawn = NSMutableAttributedString(attributedString: originalText)
    let size = originFont.pointSize + (targetFont.pointSize - originFont.pointSize) * p
    drawn.addAttribute(.font, value: originFont.withSize(size),
      range: NSRange(location: 0, length: drawn.length))
    text.attributedText = drawn
    bubble.frame = CGRect(
      x: origin.minX + (target.minX - origin.minX) * p,
      y: origin.minY + (target.minY - origin.minY) * p,
      width: origin.width + (target.width - origin.width) * p,
      height: origin.height + (target.height - origin.height) * p)
    bubble.backgroundColor = UIColor.secondarySystemBackground.withAlphaComponent(min(1, p * 2))
    text.frame = bubble.bounds.insetBy(dx: 14, dy: 14)
  }

  func remove() {
    source?.alpha = 1
    bubble.removeFromSuperview()
  }
}

struct SendMotionBubbleAnchor: UIViewRepresentable {
  let messageID: String
  let transition: ConversationSendTransition?
  func makeUIView(context: Context) -> SendMotionAnchorView {
    let view = SendMotionAnchorView()
    view.isUserInteractionEnabled = false
    view.messageID = messageID
    view.transition = transition
    return view
  }
  func updateUIView(_ view: SendMotionAnchorView, context: Context) {
    view.messageID = messageID
    view.transition = transition
    view.register()
  }
}

final class SendMotionAnchorView: UIView {
  var messageID = ""
  weak var transition: ConversationSendTransition?
  override func didMoveToWindow() { super.didMoveToWindow(); register() }
  override func layoutSubviews() { super.layoutSubviews(); register() }
  func register() {
    transition?.registerBubble(messageID: messageID, view: self)
  }
}
