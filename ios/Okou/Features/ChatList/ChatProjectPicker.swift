import ChatDomain
import SwiftUI

/// Membership uses the same native searchable list and dismissal controls as other pickers.
struct ChatProjectPicker: View {
  let workspace: WorkspaceStore
  let thread: ChatThread
  let create: () -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var moving = false
  @State private var moveTask: Task<Void, Never>?

  var body: some View {
    NavigationStack {
      List {
        ForEach(
          workspace.projects.projects.filter {
            query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)
          }
        ) { project in
          Button {
            move(to: project.id)
          } label: {
            HStack {
              OkouRowLabel(Text(verbatim: project.name)) {
                OkouIcon("folder", size: OkouIconSize.standard)
              }
              Spacer()
              if project.id == thread.projectId {
                OkouIcon("check", size: OkouIconSize.standard)
              }
            }
          }
          .disabled(moving || project.id == thread.projectId || workspace.needsUpgrade)
        }
        Section {
          Button("New project", okouSymbol: "folder-plus", action: create)
          if thread.projectId != nil {
            Button("Remove from project", okouSymbol: "folder-minus") { move(to: nil) }
          }
        }
        if let error = workspace.projects.actionError {
          Text(error).font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
        }
      }
      .font(.okou(.body))
      .foregroundStyle(OkouColor.foreground)
      .disabled(moving || workspace.needsUpgrade)
      .searchable(text: $query, prompt: "Search projects")
      .navigationTitle("Move to project")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { OkouCloseToolbarItem { dismiss() } }
    }
    .onDisappear { moveTask?.cancel() }
  }

  private func move(to projectID: String?) {
    moving = true
    moveTask = Task {
      let moved = await workspace.projects.move(threadID: thread.id, projectID: projectID)
      guard !Task.isCancelled else { return }
      moving = false
      if moved { dismiss() }
    }
  }
}
