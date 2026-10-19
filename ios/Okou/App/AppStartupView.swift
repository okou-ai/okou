import SwiftUI

struct AppStartupContainer<Content: View>: View {
  let isLoading: Bool
  @ViewBuilder let content: () -> Content
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      if !isLoading { content().transition(.identity) }
      if isLoading {
        AppStartupView()
          .allowsHitTesting(false)
          .transition(.asymmetric(insertion: .identity, removal: .opacity))
          .zIndex(1)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: isLoading)
  }
}

struct AppStartupView: View {
  var body: some View {
    ZStack {
      Color("StartupBackground")
      StartupWordmark().frame(width: 198.4, height: 59.2)
    }
    .ignoresSafeArea()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Loading Okou…")
    .accessibilityIdentifier("app-startup")
  }
}

private struct StartupWordmark: UIViewRepresentable {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase

  func makeUIView(context: Context) -> StartupWordmarkView { StartupWordmarkView() }

  func updateUIView(_ view: StartupWordmarkView, context: Context) {
    view.animates = !reduceMotion && scenePhase == .active
  }

  static func dismantleUIView(_ view: StartupWordmarkView, coordinator: ()) {
    view.animates = false
  }
}

private final class StartupWordmarkView: UIView {
  var animates = false {
    didSet { updateAnimations() }
  }
  private var letters: [CALayer] = []

  init() {
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    // Match index.html's mobile (0.8 scale) letter frames and sprite coordinates.
    let sprite = UIImage(named: "StartupWordmark")!.cgImage!
    let widths: [CGFloat] = [56, 51, 49, 56]
    let glyphWidths: [CGFloat] = [54, 49, 47, 55]
    let spriteOffsets: [CGFloat] = [0, 56, 107, 156]
    var x: CGFloat = 0
    for index in widths.indices {
      let width = widths[index]
      let letter = CALayer()
      letter.anchorPoint = CGPoint(x: 0.5, y: 0.55)
      letter.bounds = CGRect(x: 0, y: 0, width: width * 0.8, height: 66 * 0.8)
      letter.position = CGPoint(x: (x + width / 2) * 0.8, y: (4 + 66 * 0.55) * 0.8)
      let glyph = CALayer()
      glyph.contents = sprite
      glyph.contentsRect = CGRect(
        x: spriteOffsets[index] / 211, y: 0, width: glyphWidths[index] / 211, height: 1)
      glyph.frame = CGRect(
        x: (width - glyphWidths[index]) / 2 * 0.8, y: 6 * 0.8,
        width: glyphWidths[index] * 0.8, height: 54 * 0.8)
      letter.addSublayer(glyph)
      layer.addSublayer(letter)
      letters.append(letter)
      x += width + 12
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updateAnimations()
  }

  private func updateAnimations() {
    for (index, letter) in letters.enumerated() {
      guard animates && window != nil else {
        letter.removeAnimation(forKey: "bounce")
        continue
      }
      guard letter.animation(forKey: "bounce") == nil else { continue }
      let bounce = CAKeyframeAnimation(keyPath: "transform")
      bounce.values = [
        CATransform3DIdentity,
        CATransform3DScale(CATransform3DMakeTranslation(0, -14 * 0.8, 0), 0.93, 1.07, 1),
        CATransform3DMakeScale(1.08, 0.9, 1),
        CATransform3DScale(CATransform3DMakeTranslation(0, -4 * 0.8, 0), 0.98, 1.02, 1),
        CATransform3DIdentity, CATransform3DIdentity,
      ].map { NSValue(caTransform3D: $0) }
      bounce.keyTimes = [0, 0.11, 0.22, 0.30, 0.38, 1]
      let rise = CAMediaTimingFunction(controlPoints: 0.33, 1, 0.68, 1)
      let fall = CAMediaTimingFunction(controlPoints: 0.32, 0, 0.67, 0)
      bounce.timingFunctions = [rise, fall, rise, fall, CAMediaTimingFunction(name: .linear)]
      bounce.duration = 1.2
      bounce.repeatCount = .infinity
      bounce.beginTime = letter.convertTime(CACurrentMediaTime(), from: nil) + Double(index) * 0.08
      letter.add(bounce, forKey: "bounce")
    }
  }
}
