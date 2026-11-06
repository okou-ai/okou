import SwiftUI

/// Signing out asks first, as ChatGPT, Claude and the system's own Settings do: one question
/// anchored to the button, a destructive "Sign out" and Cancel. Leaving costs a full sign-in
/// on this device, while a stray tap on the last row of Settings is easy.
struct SignOutConfirmation: ViewModifier {
  @Binding var isPresented: Bool
  let signOut: () -> Void

  func body(content: Content) -> some View {
    content.confirmationDialog(
      "Sign out of Okou?", isPresented: $isPresented, titleVisibility: .visible
    ) {
      Button("Sign out", role: .destructive, action: signOut)
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("You’ll need to sign in again to see your chats on this device.")
    }
  }
}

extension View {
  /// Puts the sign-out question on the button that asks it.
  func signOutConfirmation(isPresented: Binding<Bool>, signOut: @escaping () -> Void)
    -> some View
  {
    modifier(SignOutConfirmation(isPresented: isPresented, signOut: signOut))
  }
}
