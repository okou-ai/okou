import SwiftUI

/// A native name editor, following the chat rename alert's presentation and focus contract.
struct OkouNameDialog: UIViewControllerRepresentable {
  struct Request: Identifiable {
    var id = UUID()
    let title: String
    let placeholder: String
    var name: String
    var error: String?
    var maximumLength: Int?
    var accessibilityIdentifier: String?
  }

  let request: Request?
  let cancel: () -> Void
  let save: (String) -> Void

  /// The system fills the preferred action with the alert's tint and always labels it white.
  /// Save is neutral, not brand: ink in light appearance, and in dark a mid gray that white
  /// reads on and that stands apart from Cancel (ink there is near-white).
  static let actionTint = UIColor { traits in
    UIColor(traits.userInterfaceStyle == .dark ? OkouColor.gray500 : OkouColor.foreground)
      .resolvedColor(with: traits)
  }

  func makeUIViewController(context: Context) -> Controller { Controller() }

  func updateUIViewController(_ controller: Controller, context: Context) {
    controller.request = request
    controller.cancel = cancel
    controller.save = save
    controller.overrideUserInterfaceStyle =
      context.environment.colorScheme == .dark ? .dark : .light
    controller.reconcile()
  }

  final class Controller: UIViewController {
    var request: Request?
    var cancel: (() -> Void)?
    var save: ((String) -> Void)?
    private var displayedID: UUID?
    private weak var alert: UIAlertController?

    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      reconcile()
    }

    func reconcile() {
      guard let request else {
        displayedID = nil
        alert?.dismiss(animated: true)
        alert = nil
        return
      }
      guard view.window != nil, displayedID != request.id else { return }
      displayedID = request.id
      if let presented = presentedViewController {
        if presented.isBeingDismissed, let transition = presented.transitionCoordinator {
          transition.animate(alongsideTransition: nil) { [weak self] _ in self?.show(request) }
        } else {
          presented.dismiss(animated: true) { [weak self] in self?.show(request) }
        }
      } else {
        show(request)
      }
    }

    private func show(_ request: Request) {
      guard self.request?.id == request.id, view.window != nil else { return }
      let alert = UIAlertController(
        title: request.title, message: request.error, preferredStyle: .alert)
      alert.overrideUserInterfaceStyle = overrideUserInterfaceStyle
      alert.view.tintColor = OkouNameDialog.actionTint
      let save = UIAlertAction(title: String(localized: "Save"), style: .default) {
        [weak self, weak alert] _ in
        let name = alert?.textFields?.first?.text ?? request.name
        self?.alert = nil
        self?.displayedID = nil
        self?.save?(name)
      }
      save.isEnabled = !request.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      alert.addTextField { field in
        field.placeholder = request.placeholder
        field.text = request.name
        field.accessibilityIdentifier = request.accessibilityIdentifier
        field.returnKeyType = .done
        field.addAction(
          UIAction { [weak field, weak save] _ in
            let name = (field?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            save?.isEnabled =
              !name.isEmpty
              && (request.maximumLength.map { name.utf16.count <= $0 } ?? true)
          }, for: .editingChanged)
      }
      alert.addAction(
        UIAlertAction(title: String(localized: "Cancel"), style: .cancel) { [weak self] _ in
          self?.alert = nil
          self?.displayedID = nil
          self?.cancel?()
        })
      alert.addAction(save)
      alert.preferredAction = save
      self.alert = alert
      present(alert, animated: true)
    }
  }
}
