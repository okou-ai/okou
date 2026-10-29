import ChatData
import SwiftUI

struct ComposerWorkflowMenu: View {
  let suggestions: ComposerWorkflowSuggestions
  let availableHeight: CGFloat
  @State private var headerHeight: CGFloat = 44

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("Workflows").font(.subheadline.bold())
        Spacer()
        Button {
          suggestions.dismiss()
        } label: {
          Image(systemName: "xmark").frame(width: 44, height: 44)
        }
        .accessibilityLabel("Dismiss Workflow suggestions")
        .accessibilityIdentifier("dismiss-workflows")
      }
      .padding(.leading, 16)
      .fixedSize(horizontal: false, vertical: true)
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        headerHeight = $0
      }
      content
        .frame(maxHeight: max(0, availableHeight - headerHeight), alignment: .top)
        .clipped()
    }
    .frame(maxHeight: availableHeight, alignment: .top)
    .fixedSize(horizontal: false, vertical: true)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
    .clipShape(RoundedRectangle(cornerRadius: 16))
    .accessibilityIdentifier("workflow-menu")
  }

  @ViewBuilder
  private var content: some View {
    if suggestions.isLoading {
      HStack {
        ProgressView()
        Text("Loading Workflows…").font(.subheadline)
      }.padding(16)
    } else if let error = suggestions.error {
      VStack(alignment: .leading, spacing: 8) {
        Text(error).font(.caption).foregroundStyle(.secondary)
        Button("Retry Workflows") { suggestions.reload() }.frame(minHeight: 44)
      }.padding(.horizontal, 16)
    } else if suggestions.matches.isEmpty {
      Text("No matching Workflows").font(.subheadline).foregroundStyle(.secondary)
        .padding(16)
    } else {
      ComposerWorkflowTable(
        suggestions: suggestions, values: suggestions.matches,
        selectedIndex: suggestions.selectedIndex
      )
      .frame(
        height: max(
          0, min(240, availableHeight - headerHeight, CGFloat(suggestions.matches.count) * 68)))
    }
  }
}

private struct ComposerWorkflowTable: UIViewRepresentable {
  let suggestions: ComposerWorkflowSuggestions
  let values: [ComposerWorkflow]
  let selectedIndex: Int

  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeUIView(context: Context) -> UITableView {
    let table = UITableView(frame: .zero, style: .plain)
    table.backgroundColor = .clear
    table.separatorStyle = .none
    table.keyboardDismissMode = .none
    table.rowHeight = UITableView.automaticDimension
    table.estimatedRowHeight = 68
    table.register(WorkflowCell.self, forCellReuseIdentifier: "workflow")
    table.dataSource = context.coordinator
    table.delegate = context.coordinator
    table.accessibilityIdentifier = "workflow-suggestions"
    return table
  }

  func updateUIView(_ table: UITableView, context: Context) {
    let coordinator = context.coordinator
    coordinator.suggestions = suggestions
    if coordinator.values != values {
      coordinator.values = values
      table.reloadData()
    }
    if values.indices.contains(selectedIndex) {
      let path = IndexPath(row: selectedIndex, section: 0)
      table.selectRow(at: path, animated: false, scrollPosition: .none)
      if coordinator.selectedIndex != selectedIndex {
        table.scrollToRow(at: path, at: .none, animated: false)
      }
    } else if let path = table.indexPathForSelectedRow {
      table.deselectRow(at: path, animated: false)
    }
    coordinator.selectedIndex = selectedIndex
  }

  static func dismantleUIView(_ table: UITableView, coordinator: Coordinator) {
    coordinator.suggestions = nil
    table.dataSource = nil
    table.delegate = nil
  }

  final class Coordinator: NSObject, UITableViewDataSource, UITableViewDelegate {
    weak var suggestions: ComposerWorkflowSuggestions?
    var values: [ComposerWorkflow] = []
    var selectedIndex = -1
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
      values.count
    }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
      let cell = tableView.dequeueReusableCell(withIdentifier: "workflow", for: indexPath)
      guard let cell = cell as? WorkflowCell else {
        preconditionFailure("Workflow cell registration is missing")
      }
      let workflow = values[indexPath.row]
      cell.configure(workflow) { [weak self] in self?.suggestions?.insert(workflow) }
      return cell
    }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
      suggestions?.insert(values[indexPath.row])
    }
  }
}

private final class WorkflowCell: UITableViewCell {
  private var activate: (() -> Void)?
  override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
    super.init(style: .subtitle, reuseIdentifier: reuseIdentifier)
    backgroundColor = .clear
    isAccessibilityElement = true
    accessibilityTraits = .button
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ workflow: ComposerWorkflow, activate: @escaping () -> Void) {
    self.activate = activate
    var content = defaultContentConfiguration()
    content.text = "/" + workflow.name
    content.secondaryText = workflow.description
    content.textProperties.font = .preferredFont(forTextStyle: .subheadline)
    content.secondaryTextProperties.font = .preferredFont(forTextStyle: .caption1)
    content.textProperties.adjustsFontForContentSizeCategory = true
    content.secondaryTextProperties.adjustsFontForContentSizeCategory = true
    content.textProperties.numberOfLines = 2
    content.secondaryTextProperties.numberOfLines = 2
    contentConfiguration = content
    accessibilityLabel = [workflow.name, workflow.description].compactMap { $0 }.joined(
      separator: ", ")
    accessibilityHint = "Inserts this Workflow into your message"
    accessibilityIdentifier = "workflow-" + workflow.id
  }

  override func accessibilityActivate() -> Bool {
    activate?()
    return true
  }
}
