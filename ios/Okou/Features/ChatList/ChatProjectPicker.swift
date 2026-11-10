import ChatDomain
import SwiftUI

extension View {
  func chatProjectMembershipPicker(workspace: WorkspaceStore, thread: Binding<ChatThread?>)
    -> some View
  {
    modifier(ChatProjectMembershipPicker(workspace: workspace, thread: thread))
  }
}

/// Keep the sheet-to-dialog handoff identical in the sidebar and the chat header.
private struct ChatProjectMembershipPicker: ViewModifier {
  let workspace: WorkspaceStore
  @Binding var thread: ChatThread?
  @State private var creationThreadID: String?
  @State private var nameRequest: OkouNameDialog.Request?
  @State private var createTask: Task<Void, Never>?

  func body(content: Content) -> some View {
    content
      .sheet(item: $thread, onDismiss: presentNameDialog) { thread in
        ChatProjectPicker(workspace: workspace, thread: thread) {
          creationThreadID = thread.id
          self.thread = nil
        }
        .okouSheetBackground()
      }
      .background {
        OkouNameDialog(
          request: nameRequest,
          cancel: {
            nameRequest = nil
            creationThreadID = nil
          }, save: createProject
        ).frame(width: 0, height: 0)
      }
      .onDisappear { createTask?.cancel() }
  }

  private func presentNameDialog() {
    guard creationThreadID != nil else { return }
    nameRequest = request(name: "")
  }

  private func request(name: String, error: String? = nil) -> OkouNameDialog.Request {
    OkouNameDialog.Request(
      title: String(localized: "New project"), placeholder: String(localized: "Project name"),
      name: name, error: error, maximumLength: 120, accessibilityIdentifier: "project-name")
  }

  private func createProject(_ name: String) {
    guard let threadID = creationThreadID else { return }
    nameRequest = nil
    createTask?.cancel()
    createTask = Task {
      let created = await workspace.projects.create(name: name, fromThreadID: threadID)
      guard !Task.isCancelled else { return }
      if created != nil {
        creationThreadID = nil
      } else {
        nameRequest = request(name: name, error: workspace.projects.actionError)
      }
    }
  }
}

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
    .task { await workspace.projects.activate() }
    .onDisappear { moveTask?.cancel() }
  }

  private func move(to projectID: String?) {
    moving = true
    moveTask = Task {
      // The list retains the mutation before the picker dismisses and cancels its waiter.
      await workspace.moveToProject(thread.id, projectID: projectID) { dismiss() }
      guard !Task.isCancelled else { return }
      moving = false
    }
  }
}
