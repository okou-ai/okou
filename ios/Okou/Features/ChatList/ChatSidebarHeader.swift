import SwiftUI

struct ChatSidebarHeader: View {
  let store: WorkspaceStore
  let authentication: AuthenticationService
  let workspaceID: String
  let headerHeight: CGFloat
  let isScrolled: Bool
  @Binding var accountError: String?
  let threadFilter: Binding<ChatListFilter>
  let close: () -> Void
  let newProject: () -> Void

  private var workspaceName: String {
    authentication.workspacePresentation(workspaceID)?.name ?? "Workspace"
  }

  /// As Slack's: the workspace's logo as a glass button that opens the switcher, its name
  /// beside it with no arrow, and on the right the chat filter and the way back to the chat in
  /// one glass group. The name leaves once rows scroll under the bar; the glass buttons stay.
  var body: some View {
    HStack(spacing: OkouSpace.md) {
      workspaceSwitcher
      Text(workspaceName)
        .redacted(
          reason: authentication.workspacePresentation(workspaceID) == nil ? .placeholder : []
        )
        .font(.okou(.headline))
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(isScrolled ? 0 : 1)
        .animation(OkouMotion.transition, value: isScrolled)
        // The switcher's label already names the workspace.
        .accessibilityHidden(true)
      headerActions
    }
    .frame(minHeight: headerHeight)
  }

  private var workspaceSwitcher: some View {
    Menu {
      // A picker draws the system's check beside the current workspace, and every row
      // carries its logo, as the web's switcher does.
      Picker("Workspace", selection: workspaceSelection) {
        ForEach(authentication.workspaces) { workspace in
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
    .disabled(authentication.isSwitchingWorkspace || authentication.workspaces.isEmpty)
    .accessibilityLabel("Workspace: \(workspaceName)")
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

  /// Top right, one glass capsule as iOS groups related bar buttons: the chat list menu on the
  /// left (the filters, Mark all as read and New project) and the way back to the chat on the
  /// right, toward the page it returns to. On the default Chats the menu is an icon; any other
  /// filter names itself, so a filtered list never reads as missing chats.
  private var headerActions: some View {
    HStack(spacing: 0) {
      ChatListFilterMenu(
        store: store, selection: threadFilter,
        newProject: newProject
      )
      .frame(height: OkouControl.minimumTarget)
      .fixedSize(horizontal: true, vertical: false)
      Button(action: close) {
        OkouToolbarIcon("arrow-right")
          .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Close sidebar")
      .accessibilityIdentifier("close-sidebar")
    }
    .modifier(OkouGlassControl(shape: .capsule))
  }
}
