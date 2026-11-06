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
        NativeAuthView(clerk: clerk) { await authentication.refreshWorkspaces() }
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
      if authentication.isLoadingWorkspaces && authentication.workspaces.isEmpty {
        OkouLoadingRow("Loading workspaces…")
      } else if authentication.workspaces.isEmpty && authentication.errorMessage == nil {
        VStack(alignment: .leading, spacing: OkouSpace.lg) {
          Text("Finish setting up your workspace on the web, then return here.")
            .foregroundStyle(OkouColor.mutedForeground)
          Link("Open Okou on the web", destination: webURL)
            .buttonStyle(OkouButtonStyle(isPrimary: false))
          Button("Refresh workspaces") { Task { await authentication.refresh() } }
            .buttonStyle(OkouButtonStyle(isPrimary: false))
        }
      } else {
        VStack(spacing: OkouSpace.md) {
          ForEach(authentication.workspaces) { workspace in
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
