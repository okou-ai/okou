import SwiftUI
import UIKit

/// Native editing inside `OkouSearchBar`, without a search controller's activation/cancel
/// state. Initial focus belongs to this presentation, never a query or filter update.
struct OkouSearchField: UIViewControllerRepresentable {
  @Binding var text: String
  let prompt: LocalizedStringResource

  func makeUIViewController(context: Context) -> Controller {
    Controller(text: $text)
  }

  func updateUIViewController(_ controller: Controller, context: Context) {
    controller.text = $text
    controller.field.attributedPlaceholder = NSAttributedString(
      string: String(localized: prompt),
      attributes: [.foregroundColor: UIColor(OkouColor.placeholder)])
    // Assigning text during composition would discard the IME's marked range and selection.
    if controller.field.markedTextRange == nil, controller.field.text != text {
      controller.field.text = text
    }
  }

  final class Controller: UIViewController, UITextFieldDelegate {
    let field = UITextField()
    var text: Binding<String>
    private var requestedInitialFocus = false

    init(text: Binding<String>) {
      self.text = text
      super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
      super.viewDidLoad()
      view.backgroundColor = .clear
      field.text = text.wrappedValue
      field.font = OkouTypography.font(forTextStyle: .body)
      field.adjustsFontForContentSizeCategory = true
      field.textColor = UIColor(OkouColor.foreground)
      field.autocapitalizationType = .none
      field.autocorrectionType = .no
      field.returnKeyType = .search
      field.clearButtonMode = .never
      field.accessibilityIdentifier = "search-field"
      field.delegate = self
      field.addTarget(self, action: #selector(editingChanged), for: .editingChanged)
      field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
      field.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(field)
      NSLayoutConstraint.activate([
        field.topAnchor.constraint(equalTo: view.topAnchor),
        field.leadingAnchor.constraint(equalTo: view.leadingAnchor),
        field.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        field.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      ])
    }

    override func viewIsAppearing(_ animated: Bool) {
      super.viewIsAppearing(animated)
      guard !requestedInitialFocus else { return }
      requestedInitialFocus = true
      // The field is in a window and laid out, but the sheet is still transitioning in.
      // Do not wait for viewDidAppear or refocus after returning from an artifact preview.
      field.becomeFirstResponder()
    }

    @objc private func editingChanged() {
      text.wrappedValue = field.text ?? ""
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
      guard textField.markedTextRange == nil else { return false }
      // Search keeps the query/results visible; only the page's close button dismisses it.
      textField.resignFirstResponder()
      return true
    }
  }
}
