import SwiftUI

/// One workspace-level native editor, shared by the sidebar and detail menu.
struct ChatThreadRenameDialog: UIViewControllerRepresentable {
  let list: ThreadListStore

  func makeUIViewController(context: Context) -> Controller {
    let controller = Controller(list: list)
    controller.updateAppearance(context.environment.colorScheme == .dark ? .dark : .light)
    return controller
  }

  func updateUIViewController(_ controller: Controller, context: Context) {
    controller.updateAppearance(context.environment.colorScheme == .dark ? .dark : .light)
    controller.reconcile()
  }

  final class Controller: UIViewController {
    private let list: ThreadListStore
    private var displayedID: UUID?
    private weak var alert: UIAlertController?

    init(list: ThreadListStore) {
      self.list = list
      super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    func updateAppearance(_ style: UIUserInterfaceStyle) {
      overrideUserInterfaceStyle = style
      alert?.overrideUserInterfaceStyle = style
    }

    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      reconcile()
    }

    func reconcile() {
      guard let request = list.renameRequest else {
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

    private func show(_ request: ThreadListStore.RenameRequest) {
      guard list.renameRequest?.id == request.id, view.window != nil else { return }
      let alert = UIAlertController(
        title: "Rename chat", message: request.error, preferredStyle: .alert)
      alert.overrideUserInterfaceStyle = overrideUserInterfaceStyle
      alert.view.tintColor = .label
      let save = UIAlertAction(title: "Save", style: .default) { [weak self, weak alert] _ in
        guard let self else { return }
        list.renameTitle = alert?.textFields?.first?.text ?? list.renameTitle
        self.alert = nil
        displayedID = nil
        Task { await self.list.saveRename() }
      }
      save.isEnabled = !list.renameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      alert.addTextField { [weak list] field in
        field.placeholder = "Chat title"
        field.text = list?.renameTitle
        field.accessibilityIdentifier = "chat-rename-title"
        field.returnKeyType = .done
        field.addAction(
          UIAction { [weak field, weak list, weak save] _ in
            let title = field?.text ?? ""
            list?.renameTitle = title
            save?.isEnabled = !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          }, for: .editingChanged)
      }
      alert.addAction(
        UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
          self?.alert = nil
          self?.displayedID = nil
          self?.list.cancelRename()
        })
      alert.addAction(save)
      alert.preferredAction = save
      self.alert = alert
      present(alert, animated: true)
    }
  }
}
