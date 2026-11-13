import SwiftUI

struct MessageImageNavigation {
  let canGoPrevious: Bool
  let canGoNext: Bool
  let previous: UIImage?
  let next: UIImage?
  let select: (Int) -> Void
}

struct MessageImagePager: UIViewRepresentable {
  let image: UIImage
  let navigation: MessageImageNavigation

  func makeUIView(context: Context) -> MessageImagePagingView {
    MessageImagePagingView(image: image, navigation: navigation)
  }

  func updateUIView(_ view: MessageImagePagingView, context: Context) {
    view.update(navigation)
  }
}

/// UIKit owns tracking, velocity, page settling and cancelled drags. Keep only the
/// current image and its two adjacent covers; commit selection after paging settles.
final class MessageImagePagingView: UIScrollView, UIScrollViewDelegate {
  private let current: MessageImageScrollView
  private let previousCover: ImageCover?
  private let nextCover: ImageCover?
  private let currentIndex: Int
  private var viewport: CGSize = .zero
  private var navigation: MessageImageNavigation
  private var committed = false

  init(image: UIImage, navigation: MessageImageNavigation) {
    self.navigation = navigation
    current = MessageImageScrollView(
      image: image, accessibilityLabel: String(localized: "Image. Pinch to zoom, or double tap."))
    previousCover = navigation.canGoPrevious ? ImageCover(picture: navigation.previous) : nil
    nextCover = navigation.canGoNext ? ImageCover(picture: navigation.next) : nil
    currentIndex = navigation.canGoPrevious ? 1 : 0
    super.init(frame: .zero)
    delegate = self
    isPagingEnabled = true
    isDirectionalLockEnabled = true
    showsHorizontalScrollIndicator = false
    showsVerticalScrollIndicator = false
    contentInsetAdjustmentBehavior = .never
    panGestureRecognizer.maximumNumberOfTouches = 1
    if let previousCover { addSubview(previousCover) }
    addSubview(current)
    if let nextCover { addSubview(nextCover) }
    // A fitted image gives its one-finger pan to the pager; pinch stays with the image.
    current.panGestureRecognizer.isEnabled = false
    current.zoomChanged = { [weak self] ownsPan in
      self?.panGestureRecognizer.isEnabled = !ownsPan
    }
    update(navigation)
  }

  required init?(coder: NSCoder) { nil }

  func update(_ navigation: MessageImageNavigation) {
    self.navigation = navigation
    previousCover?.update(navigation.previous)
    nextCover?.update(navigation.next)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.size != viewport, bounds.width > 0, bounds.height > 0 else { return }
    viewport = bounds.size
    let width = bounds.width
    let height = bounds.height
    previousCover?.frame = CGRect(x: 0, y: 0, width: width, height: height)
    current.frame = CGRect(x: CGFloat(currentIndex) * width, y: 0, width: width, height: height)
    nextCover?.frame = CGRect(
      x: CGFloat(currentIndex + 1) * width, y: 0, width: width, height: height)
    let count = currentIndex + 1 + (nextCover == nil ? 0 : 1)
    contentSize = CGSize(width: CGFloat(count) * width, height: height)
    setContentOffset(CGPoint(x: CGFloat(currentIndex) * width, y: 0), animated: false)
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { selectSettledPage() }
  func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { selectSettledPage() }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if !decelerate { selectSettledPage() }
  }

  private func selectSettledPage() {
    guard !committed, bounds.width > 0 else { return }
    let index = (contentOffset.x / bounds.width).rounded()
    guard abs(contentOffset.x - index * bounds.width) < 1 else { return }
    let direction = Int(index) - currentIndex
    guard direction == -1 || direction == 1 else { return }
    committed = true
    isUserInteractionEnabled = false
    navigation.select(direction)
  }

  private final class ImageCover: UIView {
    private let image = UIImageView()
    private let loading = UIActivityIndicatorView(style: .medium)

    init(picture: UIImage?) {
      super.init(frame: .zero)
      image.contentMode = .scaleAspectFit
      image.isAccessibilityElement = false
      addSubview(image)
      loading.startAnimating()
      addSubview(loading)
      update(picture)
    }

    required init?(coder: NSCoder) { nil }

    func update(_ picture: UIImage?) {
      image.image = picture
      loading.isHidden = picture != nil
      setNeedsLayout()
    }

    override func layoutSubviews() {
      super.layoutSubviews()
      if let picture = image.image {
        let fit = min(
          1, min(bounds.width / picture.size.width, bounds.height / picture.size.height))
        let size = CGSize(width: picture.size.width * fit, height: picture.size.height * fit)
        image.frame = CGRect(
          x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2,
          width: size.width, height: size.height)
      }
      loading.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }
  }
}
