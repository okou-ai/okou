import SwiftUI
import UIKit

/// A little more blur inside a band the layout already gives an edge, never a taller one: the
/// status bar band under the transcript's system soft edge, and the composer's own area at the
/// bottom. Full strength at the screen's edge, fading to clear over `OkouMotion.edgeBlurFade`
/// toward the content, with a light wash of the page colour so the material does not tint grey.
final class OkouEdgeBlurView: UIView {
  enum Edge { case top, bottom }

  private let edge: Edge
  private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
  private let wash = UIView()
  private let fade = CAGradientLayer()

  init(edge: Edge) {
    self.edge = edge
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    accessibilityElementsHidden = true
    blur.frame = bounds
    blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(blur)
    wash.frame = bounds
    wash.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    wash.backgroundColor = UIColor { traits in
      UIColor(OkouColor.background).resolvedColor(with: traits)
        .withAlphaComponent(OkouMotion.edgeBlurWash)
    }
    addSubview(wash)
    fade.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
    layer.mask = fade
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    fade.frame = bounds
    let solid = bounds.height > 0 ? max(0, 1 - OkouMotion.edgeBlurFade / bounds.height) : 0
    fade.locations = [0, NSNumber(value: solid), 1]
    switch edge {
    case .top:
      fade.startPoint = CGPoint(x: 0.5, y: 0)
      fade.endPoint = CGPoint(x: 0.5, y: 1)
    case .bottom:
      fade.startPoint = CGPoint(x: 0.5, y: 1)
      fade.endPoint = CGPoint(x: 0.5, y: 0)
    }
    CATransaction.commit()
  }
}
