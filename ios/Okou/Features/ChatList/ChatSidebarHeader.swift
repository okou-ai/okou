import SwiftUI

struct ChatSidebarHeader: View {
  let store: WorkspaceStore
  let authentication: AuthenticationService
  let workspaceID: String
  let headerHeight: CGFloat
  let isScrolled: Bool
  @Binding var accountError: String?
  let threadFilter: Binding<ChatListFilter>
  /// Whether a chat is unread, for Mark all as read.
  let hasUnreadChats: Bool
  /// Whether Mark all as read is in flight, from the list status the sidebar resolves.
  let markingAllRead: Bool
  /// Whether a chat write is in flight, from the row mutations the sidebar resolves.
  let updatingChats: Bool
  /// Whether the workspace requires an update, from the workspace state the sidebar resolves.
  let needsUpgrade: Bool
  let close: () -> Void
  let newProject: () -> Void
  let openSettings: () -> Void

  private var workspaceName: String {
    authentication.workspacePresentation(workspaceID)?.name ?? "Workspace"
  }

  private var settingsSubtitle: String? {
    let name = authentication.profile?.name?.trimmingCharacters(in: .whitespacesAndNewlines)
    let email = authentication.profile?.email?.trimmingCharacters(in: .whitespacesAndNewlines)
    switch (name?.isEmpty == false ? name : nil, email?.isEmpty == false ? email : nil) {
    case (let name?, let email?) where name != email:
      return "\(name) · \(email)"
    case (let name?, _):
      return name
    case (nil, let email?):
      return email
    case (nil, nil):
      return nil
    }
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
      if !authentication.workspaces.isEmpty {
        Section {
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
          .disabled(authentication.isSwitchingWorkspace)
        }
      }
      Section {
        Button(action: openSettings) {
          Label {
            Text("Settings")
            if let subtitle = settingsSubtitle {
              Text(subtitle)
            }
          } icon: {
            OkouIcon("settings", size: OkouIconSize.menu)
          }
        }
        .accessibilityIdentifier("settings")
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
        store: store, selection: threadFilter, hasUnreadChats: hasUnreadChats,
        markingAllRead: markingAllRead, updatingChats: updatingChats, needsUpgrade: needsUpgrade,
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
