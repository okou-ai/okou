import CCStateSwiftUI
import ChatData
import SwiftUI

struct WorkspaceMembershipMenu: View {
  let authentication: AuthenticationService
  let resources: AccountMembershipResources
  let workspaceID: String
  @Binding var accountError: String?
  @LoadableValue private var memberships: Loadable<[WorkspacePresentation]>

  init(
    authentication: AuthenticationService, resources: AccountMembershipResources,
    workspaceID: String, accountError: Binding<String?>
  ) {
    self.authentication = authentication
    self.resources = resources
    self.workspaceID = workspaceID
    _accountError = accountError
    _memberships = LoadableValue(task: resources.value)
  }

  private var workspaceName: String {
    authentication.workspacePresentation(workspaceID)?.name ?? "Workspace"
  }

  var body: some View {
    Menu {
      switch memberships {
      case .hasData(let workspaces):
        choices(workspaces)
      case .loading:
        // The confirmed membership snapshot supports switching during a same-account refresh.
        choices(resources.confirmed ?? [])
        Text("Loading workspaces…")
      case .hasError(let error):
        choices(resources.confirmed ?? [])
        Text(error.localizedDescription)
        Button("Retry") { Task { await authentication.refreshWorkspaces() } }
      }
    } label: {
      let workspace = authentication.workspacePresentation(workspaceID)
      OkouWorkspaceGlassLogo(
        workspaceID: workspaceID, name: workspaceName,
        imageURL: workspace?.imageURL, hasImage: workspace?.hasImage ?? false,
        cachedImage: authentication.presentation?.image("workspace:" + workspaceID),
        usesSharedImage: true, metadataKnown: workspace != nil
      )
      .accessibilityHidden(true)
    }
    .buttonStyle(.plain)
    .disabled(authentication.isSwitchingWorkspace)
    .accessibilityLabel("Workspace: \(workspaceName)")
  }

  private func choices(_ workspaces: [WorkspacePresentation]) -> some View {
    Picker("Workspace", selection: workspaceSelection) {
      ForEach(workspaces) { workspace in
        Label {
          Text(workspace.name)
        } icon: {
          OkouWorkspaceMenuLogos.image(
            workspaceID: workspace.id, hasImage: workspace.hasImage,
            cachedImage: authentication.presentation?.image("workspace:" + workspace.id))
        }
        .tag(workspace.id)
      }
    }
    .pickerStyle(.inline)
    .labelsHidden()
  }

  private var workspaceSelection: Binding<String> {
    Binding {
      workspaceID
    } set: { id in
      Task {
        do { try await authentication.switchWorkspace(id) } catch {
          accountError = error.localizedDescription
        }
      }
    }
  }
}
