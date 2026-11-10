import CCStateSwiftUI
import ChatData
import ClerkKit
import SwiftUI

struct SignInView: View {
  let authentication: AuthenticationService
  let webURL: URL
  var body: some View {
    Group {
      if let clerk = authentication.clerk, !authentication.isLoading,
        !authentication.needsWorkspaceSelection, clerk.environment != nil
      {
        NativeAuthView(clerk: clerk) { await authentication.refresh() }
      } else {
        SignInPage(webURL: webURL) {
          if authentication.isLoading {
            ProgressView("Restoring your session…")
          } else if authentication.needsWorkspaceSelection {
            WorkspaceSignInView(authentication: authentication, webURL: webURL)
          } else {
            unavailableView
          }
        }
      }
    }
    .environment(\.locale, Locale(identifier: "en"))
  }

  private var unavailableView: some View {
    ViewThatFits(in: .vertical) {
      unavailableContent.fixedSize(horizontal: false, vertical: true)
      ScrollView { unavailableContent }
    }
    .scrollBounceBehavior(.basedOnSize)
  }

  private var unavailableContent: some View {
    VStack(alignment: .leading, spacing: OkouSpace.xl) {
      OkouIcon("user-round-x", size: OkouIconSize.emptyState)
        .foregroundStyle(OkouColor.mutedForeground)
        .frame(width: OkouControl.emptyStateMark, height: OkouControl.emptyStateMark)
        .background(OkouColor.stateHover, in: Circle())
        .accessibilityHidden(true)
      Text("Unable to sign in")
        .font(.okou(.title2).weight(.semibold))
        .accessibilityAddTraits(.isHeader)
      Text(
        authentication.errorMessage
          ?? String(localized: "Sign-in could not be loaded. Please try again.")
      )
      .font(.okou(.subheadline))
      .foregroundStyle(OkouColor.mutedForeground)
      .fixedSize(horizontal: false, vertical: true)
      // The same filled and outline buttons as the rest of sign-in (NativeAuthView).
      VStack(spacing: OkouSpace.md) {
        Button("Try again") { Task { await authentication.refresh() } }
          .buttonStyle(OkouButtonStyle(isPrimary: true))
        Link("Open Okou on the web", destination: webURL)
          .buttonStyle(OkouButtonStyle(isPrimary: false))
      }
    }
  }
}

/// Clerk's organization task also offers organization creation. This restricted
/// selection view keeps workspace setup on the web while using native SDK sessions.
private struct WorkspaceSignInView: View {
  let authentication: AuthenticationService
  let webURL: URL
  @State private var actionError: String?
  @State private var confirmsSignOut = false

  var body: some View {
    ViewThatFits(in: .vertical) {
      content.fixedSize(horizontal: false, vertical: true)
      ScrollView { content }
    }
    .scrollBounceBehavior(.basedOnSize)
    .tint(OkouAuthTheme.primary)
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: OkouSpace.xl) {
      Text("Choose a workspace")
        .font(.okou(.title2).weight(.semibold))
        .accessibilityAddTraits(.isHeader)
      Text("Continue with one of your workspaces.")
        .font(.okou(.subheadline))
        .foregroundStyle(OkouColor.mutedForeground)
      if let resources = authentication.accountResources {
        StoreProvider(resources.store) {
          WorkspaceMembershipChoices(
            authentication: authentication, resources: resources, webURL: webURL,
            actionError: $actionError)
        }
        .id(ObjectIdentifier(resources))
      }
      if let error = actionError ?? authentication.errorMessage {
        OkouLoadErrorRow(message: error) {
          actionError = nil
          await authentication.refresh()
        }
      }
      Button("Sign out") { confirmsSignOut = true }
        .buttonStyle(OkouButtonStyle(isPrimary: false))
        .signOutConfirmation(isPresented: $confirmsSignOut) {
          Task {
            do {
              try await authentication.signOut()
            } catch {
              actionError = error.localizedDescription
            }
          }
        }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct WorkspaceMembershipChoices: View {
  let authentication: AuthenticationService
  let resources: AccountMembershipResources
  let webURL: URL
  @Binding var actionError: String?
  @LoadableValue private var memberships: Loadable<[WorkspacePresentation]>

  init(
    authentication: AuthenticationService, resources: AccountMembershipResources, webURL: URL,
    actionError: Binding<String?>
  ) {
    self.authentication = authentication
    self.resources = resources
    self.webURL = webURL
    _actionError = actionError
    _memberships = LoadableValue(task: resources.value)
  }

  var body: some View {
    switch memberships {
    case .loading:
      if let confirmed = resources.confirmed, !confirmed.isEmpty {
        choices(confirmed)
      } else {
        OkouLoadingRow("Loading workspaces…")
      }
    case .hasError(let error):
      if let confirmed = resources.confirmed, !confirmed.isEmpty { choices(confirmed) }
      OkouLoadErrorRow(message: error.localizedDescription) {
        await authentication.refreshWorkspaces()
      }
    case .hasData(let workspaces):
      choices(workspaces)
    }
  }

  @ViewBuilder
  private func choices(_ workspaces: [WorkspacePresentation]) -> some View {
    if workspaces.isEmpty {
      VStack(alignment: .leading, spacing: OkouSpace.lg) {
        Text("Finish setting up your workspace on the web, then return here.")
          .foregroundStyle(OkouColor.mutedForeground)
        Link("Open Okou on the web", destination: webURL)
          .buttonStyle(OkouButtonStyle(isPrimary: false))
        Button("Refresh workspaces") { Task { await authentication.refreshWorkspaces() } }
          .buttonStyle(OkouButtonStyle(isPrimary: false))
      }
    } else {
      VStack(spacing: OkouSpace.md) {
        ForEach(workspaces) { workspace in
          Button {
            Task {
              do {
                try await authentication.switchWorkspace(workspace.id)
              } catch {
                actionError = error.localizedDescription
              }
            }
          } label: {
            HStack(spacing: OkouSpace.md) {
              OkouWorkspaceLogo(
                workspaceID: workspace.id, name: workspace.name,
                imageURL: workspace.imageURL, hasImage: workspace.hasImage
              )
              .accessibilityHidden(true)
              Text(workspace.name)
                .font(.okou(.body).weight(.medium))
                .multilineTextAlignment(.leading)
              Spacer(minLength: OkouSpace.sm)
              OkouIcon("chevron-right", size: OkouIconSize.accessory)
                .foregroundStyle(OkouColor.mutedForeground)
                .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .buttonStyle(OkouProviderButtonStyle())
          .disabled(authentication.isSwitchingWorkspace)
        }
      }
    }
  }
}
