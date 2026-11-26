import SwiftUI

extension EnvironmentValues {
  @Entry var imagePreviewPan: (@MainActor (UIPanGestureRecognizer) -> Void)?
}

/// Keep the presenting chat under the image as it follows a one-finger vertical drag.
struct ImagePreviewSwipeDismiss<Content: View>: View {
  let dismiss: () -> Void
  @ViewBuilder let content: () -> Content
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var dragOffset: CGFloat = 0
  @State private var isLeaving = false

  var body: some View {
    GeometryReader { geometry in
      content()
        .environment(\.imagePreviewPan, { handle($0, height: geometry.size.height) })
        .background(OkouColor.background)
        .offset(y: reduceMotion ? 0 : dragOffset)
        .opacity(reduceMotion && isLeaving ? 0 : 1)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .gesture(
          ImagePreviewPan { pan in handle(pan, height: geometry.size.height) }
        )
        .allowsHitTesting(!isLeaving)
    }
    .presentationBackground(.clear)
    .interactiveDismissDisabled()
    .accessibilityAction(.escape, dismiss)
  }

  private func handle(_ pan: UIPanGestureRecognizer, height: CGFloat) {
    guard !isLeaving else { return }
    let window = pan.view?.window
    let translation = pan.translation(in: window)
    switch pan.state {
    case .began, .changed:
      dragOffset = translation.y
    case .ended:
      let velocity = pan.velocity(in: window)
      if ImagePreviewPan.shouldDismiss(translation: translation, velocity: velocity) {
        withAnimation(OkouMotion.press) {
          isLeaving = true
          dragOffset = translation.y < 0 ? -height : height
        } completion: {
          dismiss()
        }
      } else {
        settle()
      }
    case .failed, .cancelled:
      settle()
    default:
      break
    }
  }

  private func settle() {
    withAnimation(reduceMotion ? nil : OkouMotion.transition) { dragOffset = 0 }
  }
}

struct ImagePreviewPan: UIGestureRecognizerRepresentable {
  let handle: (UIPanGestureRecognizer) -> Void

  func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

  func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
    let pan = UIPanGestureRecognizer()
    context.coordinator.configure(pan)
    return pan
  }

  func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
    handle(pan)
  }

  static func shouldDismiss(translation: CGPoint, velocity: CGPoint) -> Bool {
    let distance = translation.y
    guard abs(distance) > abs(translation.x) else { return false }
    return abs(distance) >= 96
      || (abs(distance) >= 16 && abs(velocity.y) >= 650 && distance * velocity.y > 0)
  }

  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    func configure(_ pan: UIPanGestureRecognizer) {
      pan.maximumNumberOfTouches = 1
      pan.cancelsTouchesInView = false
      pan.delegate = self
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
      guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
      let direction = pan.velocity(in: pan.view)
      return abs(direction.y) > abs(direction.x)
    }

    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer,
      shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
      otherGestureRecognizer is UIPanGestureRecognizer
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch)
      -> Bool
    {
      // A zoomed image keeps its pan even at a scroll edge.
      var ancestor = touch.view
      while let view = ancestor {
        if view is UIControl { return false }
        if view is QuickLookImageCanvas, gestureRecognizer.view?.isDescendant(of: view) != true {
          return false
        }
        if let scroll = view as? UIScrollView,
          scroll.isZooming || scroll.zoomScale > scroll.minimumZoomScale * 1.01
        {
          return false
        }
        ancestor = view.superview
      }
      return true
    }
  }
}
