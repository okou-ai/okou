import CCStateSwiftUI
import ChatData
import SwiftUI

struct ComposerWorkflowMenu: View {
  let suggestions: ComposerWorkflowSuggestions
  let availableHeight: CGFloat
  var body: some View {
    StoreProvider(suggestions.resources.store) {
      ComposerWorkflowContent(suggestions: suggestions, availableHeight: availableHeight)
        .id(ObjectIdentifier(suggestions))
    }
  }
}

private struct ComposerWorkflowContent: View {
  let suggestions: ComposerWorkflowSuggestions
  let availableHeight: CGFloat
  @LoadableValue private var results: Loadable<ComposerWorkflowResources.Matches>

  init(suggestions: ComposerWorkflowSuggestions, availableHeight: CGFloat) {
    self.suggestions = suggestions
    self.availableHeight = availableHeight
    _results = LoadableValue(task: suggestions.resources.matches)
  }

  @State private var headerHeight: CGFloat = 44

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("Workflows")
          .font(.okou(.footnote).weight(.medium))
          .foregroundStyle(OkouColor.mutedForeground)
          .accessibilityAddTraits(.isHeader)
        Spacer()
        Button {
          suggestions.dismiss()
        } label: {
          OkouIcon("x", size: OkouIconSize.inline)
            .foregroundStyle(OkouColor.mutedForeground)
            .frame(width: OkouControl.minimumTarget, height: OkouControl.inlineActionHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss Workflow suggestions")
        .accessibilityIdentifier("dismiss-workflows")
      }
      .padding(.leading, OkouSpace.lg)
      .padding(.top, OkouSpace.xs)
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
    .modifier(OkouFloatingPanelStyle())
    .accessibilityIdentifier("workflow-menu")
  }

  @ViewBuilder
  private var content: some View {
    switch results {
    case .loading:
      OkouLoadingRow("Loading Workflows…").padding(.horizontal, OkouSpace.lg)
    case .hasError(let error):
      VStack(alignment: .leading, spacing: OkouSpace.sm) {
        Text(error.localizedDescription).font(.okou(.caption)).foregroundStyle(
          OkouColor.mutedForeground)
        Button("Retry Workflows") { suggestions.reload() }.frame(
          minHeight: OkouControl.minimumTarget)
      }.padding(.horizontal, OkouSpace.lg)
    case .hasData(let result) where result.values.isEmpty:
      Text("No matching Workflows").font(.okou(.subheadline)).foregroundStyle(
        OkouColor.mutedForeground
      )
      .padding(OkouSpace.lg)
    case .hasData(let result):
      ComposerWorkflowTable(
        suggestions: suggestions, result: result, selectedIndex: suggestions.selectedIndex
      )
      .frame(
        height: max(
          0,
          min(
            264, availableHeight - headerHeight,
            CGFloat(result.values.count) * 60 + OkouSpace.sm)))
    }
  }
}

private struct ComposerWorkflowTable: UIViewRepresentable {
  let suggestions: ComposerWorkflowSuggestions
  let result: ComposerWorkflowResources.Matches
  let selectedIndex: Int

  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeUIView(context: Context) -> UITableView {
    let table = UITableView(frame: .zero, style: .plain)
    table.backgroundColor = .clear
    table.separatorStyle = .none
    table.keyboardDismissMode = .none
    table.rowHeight = UITableView.automaticDimension
    table.estimatedRowHeight = 60
    table.contentInset = UIEdgeInsets(top: 0, left: 0, bottom: OkouSpace.sm, right: 0)
    table.register(WorkflowCell.self, forCellReuseIdentifier: "workflow")
    table.dataSource = context.coordinator
    table.delegate = context.coordinator
    table.accessibilityIdentifier = "workflow-suggestions"
    return table
  }

  func updateUIView(_ table: UITableView, context: Context) {
    let coordinator = context.coordinator
    coordinator.suggestions = suggestions
    let values = result.values
    let previous = coordinator.values
    coordinator.result = result
    suggestions.registerRows(coordinator) { [weak coordinator] in coordinator?.result }
    if previous != values {
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
    coordinator.suggestions?.unregisterRows(coordinator)
    coordinator.suggestions = nil
    table.dataSource = nil
    table.delegate = nil
  }

  final class Coordinator: NSObject, UITableViewDataSource, UITableViewDelegate {
    weak var suggestions: ComposerWorkflowSuggestions?
    var result: ComposerWorkflowResources.Matches?
    var values: [ComposerWorkflow] { result?.values ?? [] }
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
    // People pick a workflow by its name; the slash command is what gets inserted.
    contentConfiguration = UIHostingConfiguration {
      WorkflowSuggestionRow(workflow: workflow)
    }
    .margins(.horizontal, OkouSpace.lg)
    .margins(.vertical, OkouSpace.sm)
    configurationUpdateHandler = { cell, state in
      var background = UIBackgroundConfiguration.clear()
      background.backgroundColor =
        state.isSelected || state.isHighlighted ? UIColor(OkouColor.stateSelected) : .clear
      background.cornerRadius = OkouRadius.control
      background.backgroundInsets = NSDirectionalEdgeInsets(
        top: 1, leading: OkouSpace.six, bottom: 1, trailing: OkouSpace.six)
      cell.backgroundConfiguration = background
    }
    accessibilityLabel = [workflow.displayName ?? workflow.name, workflow.description]
      .compactMap { $0 }.joined(separator: ", ")
    accessibilityHint = String(localized: "Inserts this Workflow into your message")
    accessibilityIdentifier = "workflow-" + workflow.id
  }

  override func accessibilityActivate() -> Bool {
    activate?()
    return true
  }
}

private struct WorkflowSuggestionRow: View {
  let workflow: ComposerWorkflow

  var body: some View {
    HStack(spacing: OkouSpace.md) {
      OkouIcon("workflow", size: OkouIconSize.standard)
        .foregroundStyle(OkouColor.mutedForeground)
        .frame(width: 32, height: 32)
        .background(OkouColor.stateHover, in: RoundedRectangle(cornerRadius: OkouRadius.small))
      VStack(alignment: .leading, spacing: OkouSpace.two) {
        HStack(spacing: OkouSpace.sm) {
          Text(workflow.displayName ?? workflow.name)
            .font(.okou(.subheadline).weight(.medium))
            .foregroundStyle(OkouColor.foreground)
            .lineLimit(1)
          if workflow.displayName != nil {
            Text(verbatim: "/" + workflow.name)
              .font(.okou(.caption, design: .monospaced))
              .foregroundStyle(OkouColor.mutedForeground)
              .lineLimit(1)
              .truncationMode(.middle)
          }
        }
        if let description = workflow.description, !description.isEmpty {
          Text(description)
            .font(.okou(.caption))
            .foregroundStyle(OkouColor.mutedForeground)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
    }
    .accessibilityHidden(true)
  }
}
