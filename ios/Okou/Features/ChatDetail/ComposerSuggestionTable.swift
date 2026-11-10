import SwiftUI

struct ComposerSuggestionItem: Equatable, Identifiable {
  let id: String
  let title: String
  var detail: String?
  var command: String?
  let accessibilityLabel: String
  let accessibilityHint: String
}

/// Native scrolling and accessibility never take first responder from the editor.
struct ComposerSuggestionTable: UIViewRepresentable {
  let items: [ComposerSuggestionItem]
  let selectedIndex: Int
  let maximumHeight: CGFloat
  let accessibilityIdentifier: String
  let activate: (String) -> Void
  var didDisplay: (AnyObject) -> Void = { _ in }
  var didDismantle: (AnyObject) -> Void = { _ in }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> ComposerSuggestionNativeTable {
    let table = ComposerSuggestionNativeTable(frame: .zero, style: .plain)
    table.backgroundColor = .clear
    table.separatorStyle = .none
    table.keyboardDismissMode = .none
    table.contentInsetAdjustmentBehavior = .never
    table.rowHeight = UITableView.automaticDimension
    table.estimatedRowHeight = OkouControl.listRow
    table.contentInset.bottom = OkouSpace.sm
    table.register(SuggestionCell.self, forCellReuseIdentifier: "suggestion")
    table.dataSource = context.coordinator
    table.delegate = context.coordinator
    table.accessibilityIdentifier = accessibilityIdentifier
    return table
  }

  func updateUIView(_ table: ComposerSuggestionNativeTable, context: Context) {
    let coordinator = context.coordinator
    let previous = coordinator.items
    coordinator.items = items
    coordinator.activate = activate
    coordinator.didDismantle = didDismantle
    if previous != items { table.reloadData() }
    // The owner registers exactly the snapshot this native table can activate.
    didDisplay(coordinator)
    if items.indices.contains(selectedIndex) {
      let path = IndexPath(row: selectedIndex, section: 0)
      table.selectRow(at: path, animated: false, scrollPosition: .none)
      if !previous.isEmpty, coordinator.selectedIndex != selectedIndex {
        table.scrollToRow(at: path, at: .none, animated: false)
      }
    } else if let path = table.indexPathForSelectedRow {
      table.deselectRow(at: path, animated: false)
    }
    coordinator.selectedIndex = selectedIndex
  }

  func sizeThatFits(
    _ proposal: ProposedViewSize, uiView: ComposerSuggestionNativeTable, context: Context
  ) -> CGSize? {
    guard let width = proposal.width else { return nil }
    // SwiftUI may measure while its graph is updating. Laying out hosted cells
    // here re-enters that graph; UIKit owns their layout after measurement.
    let estimatedHeight = items.reduce(OkouSpace.sm) { height, item in
      height
        + (item.detail?.isEmpty == false
          ? OkouControl.minimumTarget + OkouSpace.sm * 2 : OkouControl.listRow)
    }
    let measuredHeight = uiView.contentSize.height + uiView.contentInset.bottom
    return CGSize(
      width: width,
      height: min(
        maximumHeight, uiView.contentSize.height > 0 ? measuredHeight : estimatedHeight))
  }

  static func dismantleUIView(_ table: ComposerSuggestionNativeTable, coordinator: Coordinator) {
    coordinator.didDismantle(coordinator)
    coordinator.didDismantle = { _ in }
    coordinator.activate = { _ in }
    table.dataSource = nil
    table.delegate = nil
  }

  final class Coordinator: NSObject, UITableViewDataSource, UITableViewDelegate {
    var items: [ComposerSuggestionItem] = []
    var selectedIndex = -1
    var activate: (String) -> Void = { _ in }
    var didDismantle: (AnyObject) -> Void = { _ in }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
      items.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
      let cell = tableView.dequeueReusableCell(withIdentifier: "suggestion", for: indexPath)
      guard let cell = cell as? SuggestionCell else {
        preconditionFailure("Suggestion cells must use their registered class")
      }
      let item = items[indexPath.row]
      cell.configure(item) { [weak self] in self?.activate(item.id) }
      return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
      activate(items[indexPath.row].id)
    }
  }
}

final class ComposerSuggestionNativeTable: UITableView {
  override var contentSize: CGSize {
    didSet {
      if oldValue != contentSize { invalidateIntrinsicContentSize() }
    }
  }

  override var intrinsicContentSize: CGSize {
    CGSize(width: UIView.noIntrinsicMetric, height: contentSize.height)
  }
}

private final class SuggestionCell: UITableViewCell {
  private var item: ComposerSuggestionItem?
  private var activate: () -> Void = {}

  func configure(_ item: ComposerSuggestionItem, activate: @escaping () -> Void) {
    self.item = item
    self.activate = activate
    // Hosted rows draw their semantic focus layer; UIKit's default selection
    // otherwise covers it with an opaque system gray on current iOS.
    selectionStyle = .none
    backgroundColor = .clear
    backgroundConfiguration = .clear()
    automaticallyUpdatesBackgroundConfiguration = false
    automaticallyUpdatesContentConfiguration = false
    isAccessibilityElement = true
    accessibilityTraits = .button
    accessibilityLabel = item.accessibilityLabel
    accessibilityHint = item.accessibilityHint
    accessibilityIdentifier = item.id
    updateContent()
  }

  override func setSelected(_ selected: Bool, animated: Bool) {
    super.setSelected(selected, animated: animated)
    updateContent()
  }

  override func setHighlighted(_ highlighted: Bool, animated: Bool) {
    super.setHighlighted(highlighted, animated: animated)
    updateContent()
  }

  private func updateContent() {
    guard let item else { return }
    let focused = isSelected || isHighlighted
    contentConfiguration = UIHostingConfiguration {
      OkouSuggestionRow(title: item.title, detail: item.detail, command: item.command)
        .accessibilityHidden(true)
    }
    .margins(.horizontal, OkouSpace.lg)
    .margins(.vertical, OkouSpace.sm)
    .background {
      RoundedRectangle(cornerRadius: OkouRadius.control)
        .fill(focused ? OkouColor.stateSelected : .clear)
        .padding(.horizontal, OkouSpace.six)
        .padding(.vertical, OkouSpace.one)
    }
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    item = nil
    contentConfiguration = nil
    activate = {}
  }

  override func accessibilityActivate() -> Bool {
    activate()
    return true
  }
}
