import SwiftUI

/// Supplements native List reuse with point-accurate reading-position restoration.
/// It neither replaces the scroll delegate nor depends on private List implementation classes.
@MainActor
final class ConversationScrollAnchor {
  private let markers = NSMapTable<NSString, ConversationRowMarker>.strongToWeakObjects()
  private weak var scrollView: UIScrollView?
  private var viewportChanged = false
  private var position: ConversationReadingPosition?
  private var displayLink: CADisplayLink?
  private var settlingFrames = 0
  private var needsReveal = false
  private var followsBottom = false
  var isScrolling = false {
    didSet { if !isScrolling { layoutDidChange() } }
  }
  var revealRow: (@MainActor (String) -> Void)?
  var viewportDidChange: (@MainActor () -> Void)?
  var preservedPosition: ConversationReadingPosition? { position }

  func capture() -> ConversationReadingPosition? {
    guard let scrollView else { return nil }
    let top = scrollView.bounds.minY + scrollView.adjustedContentInset.top
    let bottom = scrollView.bounds.maxY - scrollView.adjustedContentInset.bottom
    let visible = markers.objectEnumerator()?.allObjects.compactMap { $0 as? ConversationRowMarker }
      .filter { $0.window != nil && $0.enclosingScrollView === scrollView }
      .map { ($0.messageID, $0.convert($0.bounds, to: scrollView)) }
      .filter { $0.1.maxY > top && $0.1.minY < bottom }
      .min { $0.1.minY < $1.1.minY }
    guard let visible else { return nil }
    return ConversationReadingPosition(messageID: visible.0, offset: visible.1.minY - top)
  }

  func preserve(_ position: ConversationReadingPosition) {
    followsBottom = false
    if self.position != position {
      self.position = position
    }
    layoutDidChange()
  }

  func restore(_ position: ConversationReadingPosition) {
    // List can keep old cell measurements after a prepend, even while the marker is attached.
    needsReveal = true
    preserve(position)
  }

  func followBottom() {
    position = nil
    needsReveal = false
    viewportChanged = false
    followsBottom = true
    layoutDidChange()
  }

  func cancel() {
    position = nil
    followsBottom = false
    needsReveal = false
    viewportChanged = false
    displayLink?.invalidate()
    displayLink = nil
    settlingFrames = 0
  }

  func layoutDidChange() {
    // A correction can briefly match an estimate before the native cell transaction settles.
    settlingFrames = 2
    scheduleFrame()
  }

  private func scheduleFrame() {
    guard position != nil || followsBottom || viewportChanged, !isScrolling, displayLink == nil
    else { return }
    // A main-queue yield can precede List's native cell transaction. Correct on the next frame.
    let target = ConversationAnchorFrameTarget(anchor: self)
    let link = CADisplayLink(
      target: target, selector: #selector(ConversationAnchorFrameTarget.tick(_:)))
    displayLink = link
    link.add(to: .main, forMode: .common)
  }

  fileprivate func viewportLayoutDidChange() {
    viewportChanged = true
    layoutDidChange()
  }

  fileprivate func correctOnFrame(_ link: CADisplayLink) {
    guard displayLink === link else { return }
    link.invalidate()
    displayLink = nil
    if viewportChanged {
      viewportChanged = false
      viewportDidChange?()
    }
    correctPosition()
    if settlingFrames > 0 {
      settlingFrames -= 1
      scheduleFrame()
    }
  }

  fileprivate func register(_ marker: ConversationRowMarker) {
    guard marker.window != nil else { return }
    markers.setObject(marker, forKey: marker.messageID as NSString)
    if let scroll = marker.enclosingScrollView, scrollView !== scroll {
      scrollView = scroll
    }
    layoutDidChange()
  }

  fileprivate func unregister(_ marker: ConversationRowMarker) {
    if markers.object(forKey: marker.messageID as NSString) === marker {
      markers.removeObject(forKey: marker.messageID as NSString)
    }
  }

  private func correctPosition() {
    guard let scrollView, !isScrolling, !scrollView.isTracking, !scrollView.isDragging,
      !scrollView.isDecelerating
    else { return }
    if followsBottom {
      let y = max(
        -scrollView.adjustedContentInset.top,
        scrollView.contentSize.height - scrollView.bounds.height
          + scrollView.adjustedContentInset.bottom)
      if abs(y - scrollView.contentOffset.y) > 0.5 {
        scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: y), animated: false)
        layoutDidChange()
      } else {
        followsBottom = false
      }
      return
    }
    guard let position else { return }
    if needsReveal, let revealRow {
      needsReveal = false
      revealRow(position.messageID)
      layoutDidChange()
      return
    }
    guard let marker = markers.object(forKey: position.messageID as NSString), marker.window != nil,
      marker.enclosingScrollView === scrollView
    else {
      // A large prepend can recycle the anchor cell. Let List materialize it before correcting points.
      if let revealRow {
        revealRow(position.messageID)
        // The ID is in the render window, but List may not have committed its cell transaction yet.
        layoutDidChange()
      }
      return
    }
    let offset =
      marker.convert(marker.bounds, to: scrollView).minY
      - scrollView.bounds.minY - scrollView.adjustedContentInset.top
    let minimum = -scrollView.adjustedContentInset.top
    let maximum = max(
      minimum,
      scrollView.contentSize.height - scrollView.bounds.height
        + scrollView.adjustedContentInset.bottom)
    let y = min(maximum, max(minimum, scrollView.contentOffset.y + offset - position.offset))
    guard abs(y - scrollView.contentOffset.y) > 0.5 else { return }
    scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: y), animated: false)
    // Native List may adjust estimates in response to this move; verify the resulting frame.
    layoutDidChange()
  }
}

struct ConversationViewportAnchor: UIViewRepresentable {
  let anchor: ConversationScrollAnchor
  func makeUIView(context: Context) -> ConversationViewportMarker {
    let view = ConversationViewportMarker()
    view.isUserInteractionEnabled = false
    return view
  }
  func updateUIView(_ view: ConversationViewportMarker, context: Context) {
    view.anchor = anchor
  }
  static func dismantleUIView(_ view: ConversationViewportMarker, coordinator: ()) {
    view.anchor = nil
  }
}

final class ConversationViewportMarker: UIView {
  fileprivate weak var anchor: ConversationScrollAnchor?
  private var lastBounds: CGRect = .zero
  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    anchor?.viewportLayoutDidChange()
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    if lastBounds != bounds {
      lastBounds = bounds
      anchor?.viewportLayoutDidChange()
    }
  }
}

@MainActor
private final class ConversationAnchorFrameTarget: NSObject {
  weak var anchor: ConversationScrollAnchor?
  init(anchor: ConversationScrollAnchor) { self.anchor = anchor }
  @objc func tick(_ link: CADisplayLink) {
    guard let anchor else {
      link.invalidate()
      return
    }
    anchor.correctOnFrame(link)
  }
}

struct ConversationRowAnchor: UIViewRepresentable {
  let messageID: String
  let anchor: ConversationScrollAnchor

  func makeUIView(context: Context) -> ConversationRowMarker {
    let view = ConversationRowMarker()
    view.isUserInteractionEnabled = false
    return view
  }

  func updateUIView(_ view: ConversationRowMarker, context: Context) {
    view.anchor?.unregister(view)
    view.messageID = messageID
    view.anchor = anchor
    anchor.register(view)
  }

  static func dismantleUIView(_ view: ConversationRowMarker, coordinator: ()) {
    view.anchor?.unregister(view)
    view.anchor = nil
  }
}

final class ConversationRowMarker: UIView {
  fileprivate(set) var messageID = ""
  fileprivate weak var anchor: ConversationScrollAnchor?

  var enclosingScrollView: UIScrollView? {
    var ancestor = superview
    while let view = ancestor {
      if let scroll = view as? UIScrollView { return scroll }
      ancestor = view.superview
    }
    return nil
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { anchor?.unregister(self) } else { anchor?.register(self) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    anchor?.register(self)
  }
}
