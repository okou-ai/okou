import ClerkKit
import ClerkKitUI
import SwiftUI

struct SignInView: View {
  let authentication: AuthenticationService
  let webURL: URL
  @State private var theme = SignInStyle.makeTheme()

  var body: some View {
    SignInPage(webURL: webURL) {
      if let clerk = authentication.clerk {
        if authentication.isLoading {
          ProgressView("Restoring your session…")
        } else if authentication.needsWorkspaceSelection {
          WorkspaceSignInView(authentication: authentication, webURL: webURL)
        } else if clerk.environment == nil {
          unavailableView
        } else {
          AuthView(mode: .signIn, isDismissible: false) {
            Task { await authentication.refreshWorkspaces() }
          }
          .environment(clerk)
          .environment(\.clerkTheme, theme)
          .clerkAppIconView {
            SignInWordmark(width: 76)
              .padding(.top, 16)
              .padding(.bottom, 24)
          }
          .frame(maxHeight: 620)
        }
      } else {
        unavailableView
      }
    }
    .environment(\.locale, .autoupdatingCurrent)
  }

  private var unavailableView: some View {
    ViewThatFits(in: .vertical) {
      unavailableContent.fixedSize(horizontal: false, vertical: true)
      ScrollView { unavailableContent }
    }
    .scrollBounceBehavior(.basedOnSize)
  }

  private var unavailableContent: some View {
    VStack(alignment: .leading, spacing: 20) {
      Image(systemName: "person.crop.circle.badge.exclamationmark")
        .font(.system(size: 28))
        .foregroundStyle(SignInStyle.primary)
        .accessibilityHidden(true)
      Text("Unable to sign in")
        .font(.title2.weight(.semibold))
        .accessibilityAddTraits(.isHeader)
      Text(
        authentication.errorMessage
          ?? String(localized: "Sign-in could not be loaded. Please try again.")
      )
      .font(.subheadline)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
      Button {
        Task { await authentication.refresh() }
      } label: {
        Text("Try again")
          .frame(maxWidth: .infinity)
          .foregroundStyle(Color(uiColor: .systemBackground))
      }
      .buttonStyle(.borderedProminent)
      .buttonBorderShape(.roundedRectangle(radius: 10))
      .tint(SignInStyle.primary)
      .controlSize(.large)
      Link(destination: webURL) {
        Text("Open Okou on the web").frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .buttonBorderShape(.roundedRectangle(radius: 10))
      .tint(SignInStyle.primary)
      .controlSize(.large)
    }
    .padding(28)
  }
}

/// Clerk's organization task also offers organization creation. This restricted
/// selection view keeps workspace setup on the web while using native SDK sessions.
private struct WorkspaceSignInView: View {
  let authentication: AuthenticationService
  let webURL: URL
  @State private var actionError: String?

  var body: some View {
    ViewThatFits(in: .vertical) {
      content.fixedSize(horizontal: false, vertical: true)
      ScrollView { content }
    }
    .scrollBounceBehavior(.basedOnSize)
    .tint(SignInStyle.primary)
    .task(id: authentication.userID) {
      await authentication.refreshWorkspaces()
    }
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text("Choose a workspace")
        .font(.title2.weight(.semibold))
        .accessibilityAddTraits(.isHeader)
      Text("Continue with one of your workspaces.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
      if authentication.isLoadingWorkspaces && authentication.workspaces.isEmpty {
        ProgressView("Loading workspaces…")
      } else if authentication.workspaces.isEmpty {
        VStack(alignment: .leading, spacing: 16) {
          Text("Finish setting up your workspace on the web, then return here.")
            .foregroundStyle(.secondary)
          Link("Open Okou on the web", destination: webURL)
          Button("Refresh workspaces") { Task { await authentication.refresh() } }
        }
      } else {
        VStack(spacing: 12) {
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
              HStack(spacing: 12) {
                Image(systemName: "building.2")
                  .foregroundStyle(SignInStyle.primary)
                  .accessibilityHidden(true)
                Text(workspace.name)
                  .font(.body.weight(.medium))
                  .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(.secondary)
                  .accessibilityHidden(true)
              }
              .padding(16)
              .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            }
            .buttonStyle(.plain)
            .background(
              Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12)
            )
            .disabled(authentication.isSwitchingWorkspace)
          }
        }
      }
      if let error = actionError ?? authentication.errorMessage {
        VStack(alignment: .leading, spacing: 12) {
          Text(error).foregroundStyle(.red)
          Button("Try again") {
            actionError = nil
            Task { await authentication.refresh() }
          }
        }
      }
      Divider()
      HStack {
        Button("Sign out", role: .destructive) {
          Task {
            do {
              try await authentication.signOut()
            } catch {
              actionError = error.localizedDescription
            }
          }
        }
        Spacer()
      }
    }
    .padding(28)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
