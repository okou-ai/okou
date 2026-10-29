import SwiftUI

struct ComposerWorkflowPresentation: PreferenceKey {
  struct Presentation {
    let bounds: Anchor<CGRect>
    let suggestions: ComposerWorkflowSuggestions
    let isDisabled: Bool
  }

  static var defaultValue: Presentation? { nil }

  static func reduce(value: inout Presentation?, nextValue: () -> Presentation?) {
    value = nextValue() ?? value
  }
}

extension View {
  /// Mount outside the composited workspace panel so visible rows receive touches.
  func composerWorkflowOverlay(topInset: CGFloat = 0, isEnabled: Bool = true) -> some View {
    overlayPreferenceValue(ComposerWorkflowPresentation.self) { presentation in
      GeometryReader { geometry in
        if isEnabled, let presentation {
          let composer = geometry[presentation.bounds]
          let top = max(0, topInset)
          let bottom = min(geometry.size.height, composer.minY - 8)
          let availableHeight = max(0, bottom - top)
          if availableHeight > 0 {
            ComposerWorkflowMenu(
              suggestions: presentation.suggestions, availableHeight: availableHeight
            )
            .disabled(presentation.isDisabled)
            .frame(width: composer.width)
            .frame(height: availableHeight, alignment: .bottom)
            .offset(x: composer.minX, y: top)
          }
        }
      }
    }
  }
}
