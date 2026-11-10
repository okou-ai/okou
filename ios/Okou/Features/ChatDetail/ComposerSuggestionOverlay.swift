import SwiftUI

struct ComposerSuggestionPresentation: PreferenceKey {
  enum Content {
    case chats(ComposerEditor)
    case workflows(ComposerWorkflowSuggestions)
  }

  struct Presentation {
    let bounds: Anchor<CGRect>
    let content: Content
    let isDisabled: Bool
  }

  static var defaultValue: Presentation? { nil }

  static func reduce(value: inout Presentation?, nextValue: () -> Presentation?) {
    value = nextValue() ?? value
  }
}

extension View {
  /// Both pickers float outside the workspace's composited panel to receive touches.
  func composerSuggestionOverlay(topInset: CGFloat = 0, isEnabled: Bool = true) -> some View {
    overlayPreferenceValue(ComposerSuggestionPresentation.self) { presentation in
      GeometryReader { geometry in
        if isEnabled, let presentation {
          let composer = geometry[presentation.bounds]
          let top = max(0, topInset)
          let bottom = min(geometry.size.height, composer.minY - OkouSpace.sm)
          let availableHeight = max(0, bottom - top)
          if availableHeight > 0 {
            Group {
              switch presentation.content {
              case .chats(let editor):
                ComposerMentionMenu(editor: editor, availableHeight: availableHeight)
              case .workflows(let suggestions):
                ComposerWorkflowMenu(suggestions: suggestions, availableHeight: availableHeight)
              }
            }
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
