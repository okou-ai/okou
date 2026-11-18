import Foundation

enum AuthenticationError: LocalizedError {
  case notConfigured
  case signedOut
  case workspaceChanged
  case workspaceUnavailable

  var errorDescription: String? {
    switch self {
    case .notConfigured:
      String(localized: "Sign-in is not configured for this build.")
    case .signedOut:
      String(localized: "Your session has expired. Please sign in again.")
    case .workspaceChanged:
      String(
        localized: "Your account or workspace changed. Please try again in the current workspace."
      )
    case .workspaceUnavailable:
      String(
        localized:
          "This workspace is no longer available. Choose another workspace or manage access on the web."
      )
    }
  }
}
