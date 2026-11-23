import Foundation

extension AuthenticationService {
  /// Account-scoped setup can precede organization activation. Fence the original session.
  func accountAccessToken(userID expectedUser: String?, sessionID expectedSession: String?)
    async throws -> String
  {
    guard let session = clerk?.session, let userID, userID == expectedUser,
      session.id == expectedSession
    else { throw AuthenticationError.signedOut }
    let token = try await session.getToken()
    try Task.checkCancellation()
    guard clerk?.session?.id == expectedSession, self.userID == expectedUser else {
      throw AuthenticationError.workspaceChanged
    }
    guard let token, !token.isEmpty else { throw AuthenticationError.signedOut }
    return token
  }

}
