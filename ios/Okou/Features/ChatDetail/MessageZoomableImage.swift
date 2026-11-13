import SwiftUI

struct MessageZoomableImage: UIViewRepresentable {
  let image: UIImage
  var zoomStep = 0
  var accessibilityLabel = String(localized: "Image. Pinch to zoom, or double tap.")
  var navigateImage: ((Int) -> Void)?

  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeUIView(context: Context) -> MessageImageScrollView {
    let view = MessageImageScrollView(image: image, accessibilityLabel: accessibilityLabel)
    context.coordinator.navigateImage = navigateImage
    context.coordinator.install(on: view)
    return view
  }
  func updateUIView(_ view: MessageImageScrollView, context: Context) {
    context.coordinator.navigateImage = navigateImage
    view.adjustZoom(to: zoomStep)
  }

  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    var navigateImage: ((Int) -> Void)?
    private weak var view: MessageImageScrollView?

    func install(on view: MessageImageScrollView) {
      self.view = view
      for direction: UISwipeGestureRecognizer.Direction in [.left, .right] {
        let swipe = UISwipeGestureRecognizer(target: self, action: #selector(navigate(_:)))
        swipe.direction = direction
        swipe.delegate = self
        view.addGestureRecognizer(swipe)
        view.panGestureRecognizer.require(toFail: swipe)
        if let pinch = view.pinchGestureRecognizer { swipe.require(toFail: pinch) }
      }
    }

    private var canNavigate: Bool {
      guard let view, navigateImage != nil else { return false }
      return !view.isZooming && view.zoomScale <= view.minimumZoomScale * 1.01
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch)
      -> Bool
    {
      canNavigate
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
      canNavigate
    }

    @objc private func navigate(_ gesture: UISwipeGestureRecognizer) {
      navigateImage?(gesture.direction == .left ? 1 : -1)
    }
  }
}

final class MessageImageScrollView: UIScrollView, UIScrollViewDelegate {
  private let imageView: UIImageView
  private let imageSize: CGSize
  private var viewport: CGSize = .zero
  private var zoomStep = 0

  init(image: UIImage, accessibilityLabel: String) {
    imageView = UIImageView(image: image)
    imageSize = image.size
    super.init(frame: .zero)
    delegate = self
    contentInsetAdjustmentBehavior = .never
    imageView.frame = CGRect(origin: .zero, size: image.size)
    imageView.isAccessibilityElement = true
    imageView.accessibilityLabel = accessibilityLabel
    imageView.accessibilityCustomActions = [
      UIAccessibilityCustomAction(
        name: String(localized: "Zoom in"), target: self, selector: #selector(zoomIn)),
      UIAccessibilityCustomAction(
        name: String(localized: "Zoom out"), target: self, selector: #selector(zoomOut)),
    ]
    addSubview(imageView)
    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
    doubleTap.numberOfTapsRequired = 2
    addGestureRecognizer(doubleTap)
  }

  required init?(coder: NSCoder) { nil }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.size != viewport, bounds.width > 0, bounds.height > 0 else { return }
    viewport = bounds.size
    let fit = min(bounds.width / imageSize.width, bounds.height / imageSize.height)
    minimumZoomScale = min(1, fit)
    maximumZoomScale = max(4, fit * 8)
    setZoomScale(minimumZoomScale, animated: false)
    centerImage()
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
  func scrollViewDidZoom(_ scrollView: UIScrollView) { centerImage() }

  func adjustZoom(to step: Int) {
    guard step != zoomStep else { return }
    let factor = pow(1.6, Double(step - zoomStep))
    zoomStep = step
    setZoomScale(min(maximumZoomScale, max(minimumZoomScale, zoomScale * factor)), animated: true)
  }

  private func centerImage() {
    contentInset = UIEdgeInsets(
      top: max(0, (bounds.height - contentSize.height) / 2),
      left: max(0, (bounds.width - contentSize.width) / 2),
      bottom: 0, right: 0)
  }

  @objc private func zoomIn() -> Bool {
    setZoomScale(min(maximumZoomScale, zoomScale * 1.6), animated: true)
    return true
  }

  @objc private func zoomOut() -> Bool {
    setZoomScale(max(minimumZoomScale, zoomScale / 1.6), animated: true)
    return true
  }

  @objc private func toggleZoom(_ gesture: UITapGestureRecognizer) {
    if zoomScale > minimumZoomScale * 1.1 {
      setZoomScale(minimumZoomScale, animated: true)
    } else {
      let scale = min(maximumZoomScale, minimumZoomScale * 3)
      let point = gesture.location(in: imageView)
      let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
      zoom(
        to: CGRect(
          x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width,
          height: size.height), animated: true)
    }
  }
}
