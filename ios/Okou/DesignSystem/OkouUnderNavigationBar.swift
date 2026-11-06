import SwiftUI
import UIKit

/// Lays a page out under the navigation bar with UIKit instead of SwiftUI. When the bar changes
/// height (the system search field rising into it while typing, or dropping back), UIKit moves
/// the page inside the bar's own Core Animation transaction, so the page travels with the
/// field. SwiftUI would apply the new safe area at once, and an animation of its own runs on
/// the main thread, which the keyboard's arrival keeps busy for the whole move.
///
/// Fill the screen with it (`.ignoresSafeArea()`); the page starts at the bar's bottom edge.
struct OkouUnderNavigationBar<Content: View>: UIViewControllerRepresentable {
  /// A hosting controller of its own starts from a fresh environment, so the page takes the
  /// app's appearance (type, colours, row height) again.
  typealias Page = ModifiedContent<Content, OkouAppearance>

  let content: Content

  init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  func makeUIViewController(context: Context) -> Controller {
    Controller(page: content.modifier(OkouAppearance()))
  }

  func updateUIViewController(_ controller: Controller, context: Context) {
    controller.host.rootView = content.modifier(OkouAppearance())
  }

  final class Controller: UIViewController {
    let host: UIHostingController<Page>

    init(page: Page) {
      host = UIHostingController(rootView: page)
      super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
      super.viewDidLoad()
      view.backgroundColor = .clear
      addChild(host)
      host.view.backgroundColor = .clear
      host.view.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(host.view)
      NSLayoutConstraint.activate([
        host.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
        host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
        host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      ])
      host.didMove(toParent: self)
    }

    /// The bar changed height. UIKit moves the bar in its own animation but lays this page out
    /// outside it, so the page takes the same move here: inside the bar's animation when this
    /// runs within it, otherwise a spring of the bar's length. Either way Core Animation runs
    /// it, so it keeps time with the bar while the main thread is busy.
    override func viewSafeAreaInsetsDidChange() {
      super.viewSafeAreaInsetsDidChange()
      guard view.window != nil, host.view.frame != .zero else { return }
      if UIView.inheritedAnimationDuration > 0 {
        view.layoutIfNeeded()
      } else {
        UIView.animate(springDuration: OkouMotion.barMove, bounce: 0) {
          self.view.layoutIfNeeded()
        }
      }
    }
  }
}
