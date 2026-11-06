import SwiftUI
import UIKit

/// The system back button keeps its native behaviour (swipe back, the long-press history menu,
/// the glass circle) but draws Okou's Lucide chevron instead of the SF Symbol. The SF chevron
/// was half again as tall and heavier than every Lucide glyph beside it (19 pt against the
/// 20 pt Lucide set's 11–15 pt artwork), so a pushed page's back button never matched the
/// header's menu or a sheet's close.
enum OkouNavigationBar {
  @MainActor static func applyBackIndicator() {
    guard let chevron = OkouIcon.uiImage("chevron-left") else { return }
    let bar = UINavigationBar.appearance()
    bar.backIndicatorImage = chevron
    bar.backIndicatorTransitionMaskImage = chevron
  }

  /// The system search field keeps its interaction (rising into the bar while typing) but
  /// draws the app's glyphs: Lucide `search` and `circle-x` in `OkouColor.placeholder`, as the
  /// sidebar's `OkouSearchBar` draws them, instead of the SF Symbols.
  @MainActor static func applySearchField() {
    let grey = UIColor(OkouColor.placeholder)
    let bar = UISearchBar.appearance()
    if let glass = OkouIcon.uiImage("search")?.withTintColor(grey, renderingMode: .alwaysOriginal) {
      bar.setImage(glass, for: .search, state: .normal)
    }
    if let clear = OkouIcon.uiImage("circle-x")?.withTintColor(grey, renderingMode: .alwaysOriginal)
    {
      bar.setImage(clear, for: .clear, state: .normal)
    }
  }
}

extension View {
  /// A search page's field in the app's style. No clear button inside the field: the ✕ that
  /// ends search sits right beside it, and two ✕ side by side read as the same action twice;
  /// deleting the text clears it. That ✕ draws the app's Lucide `x` at the toolbar size, as
  /// every other close button does, instead of the system's larger, heavier SF Symbol. Both
  /// are set on the page's own field, out of reach of `applySearchField()`'s appearance, so
  /// apply this inside `.searchable`.
  func okouSearchPageField() -> some View {
    background(SearchPageField())
  }
}

private struct SearchPageField: UIViewControllerRepresentable {
  func makeUIViewController(context: Context) -> Controller { Controller() }
  func updateUIViewController(_ controller: Controller, context: Context) {}

  final class Controller: UIViewController {
    private var beginEditing: NSObjectProtocol?

    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      guard let search = searchController, beginEditing == nil else { return }
      let field = search.searchBar.searchTextField
      field.clearButtonMode = .never
      style(search.searchBar)
      // The ✕ is shown, and may be rebuilt, as the field starts editing.
      beginEditing = NotificationCenter.default.addObserver(
        forName: UITextField.textDidBeginEditingNotification, object: field, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let bar = self?.searchController?.searchBar else { return }
          self?.style(bar)
          DispatchQueue.main.async { self?.style(bar) }
        }
      }
    }

    isolated deinit {
      if let beginEditing { NotificationCenter.default.removeObserver(beginEditing) }
    }

    /// The page's own search controller, on the nearest controller that carries one.
    private var searchController: UISearchController? {
      var next = parent
      while let controller = next {
        if let search = controller.navigationItem.searchController { return search }
        next = controller.parent
      }
      return nil
    }

    /// The search bar's ✕ is its one button outside the text field.
    private func style(_ bar: UISearchBar) {
      guard let glyph = OkouIcon.uiImage("x") else { return }
      for button in Self.buttons(in: bar) where !button.isDescendant(of: bar.searchTextField) {
        var configuration = button.configuration ?? .plain()
        guard configuration.image !== glyph else { continue }
        configuration.image = glyph
        configuration.preferredSymbolConfigurationForImage = nil
        button.configuration = configuration
      }
    }

    private static func buttons(in view: UIView) -> [UIButton] {
      var found: [UIButton] = []
      for subview in view.subviews {
        if let button = subview as? UIButton { found.append(button) }
        found += buttons(in: subview)
      }
      return found
    }
  }
}
