import ChatData
import Foundation
import SpotifyiOS
import UIKit

/// The SDK owns its state validation and app/browser selection. Its delegate
/// hands only the code to the existing API exchange; it never receives tokens.
@MainActor
final class SpotifyConnectorAuthorization: NSObject, @preconcurrency SPTSessionManagerDelegate {
  private var manager: SPTSessionManager?
  private var callbackURL: URL?
  private var continuation: CheckedContinuation<String, Error>?

  func authorize(_ request: ConnectorProviderRequest) async throws -> String {
    guard let callback = request.callbackURL, let exchange = request.exchangeURL,
      let items = URLComponents(url: request.webURL, resolvingAgainstBaseURL: false)?.queryItems,
      let clientID = items.first(where: { $0.name == "client_id" })?.value,
      let scopes = items.first(where: { $0.name == "scope" })?.value
    else { throw APIClientError.invalidResponse }
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      return try await withCheckedThrowingContinuation { continuation in
        self.continuation = continuation
        callbackURL = callback
        let configuration = SPTConfiguration(clientID: clientID, redirectURL: callback)
        // Select the confidential code flow. The delegate below intercepts the
        // exchange before any SDK request to this registered backend callback.
        configuration.tokenSwapURL = exchange
        let manager = SPTSessionManager(configuration: configuration, delegate: self)
        self.manager = manager
        manager.initiateSession(withRawScope: scopes, options: .default, campaign: nil)
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.finish(.failure(CancellationError())) }
    }
  }

  func receive(_ url: URL) -> Bool {
    guard let expected = callbackURL, url.scheme == expected.scheme,
      url.host == expected.host, url.path == expected.path,
      url.user == nil, url.password == nil, url.port == nil, url.fragment == nil
    else { return false }
    return manager?.application(UIApplication.shared, open: url, options: [:]) == true
  }

  func sessionManager(
    manager: SPTSessionManager, shouldRequestAccessTokenWith code: String
  ) -> Bool {
    guard self.manager === manager else { return false }
    finish(code.isEmpty ? .failure(APIClientError.invalidResponse) : .success(code))
    return false
  }

  func sessionManager(manager: SPTSessionManager, didFailWith error: Error) {
    guard self.manager === manager else { return }
    finish(.failure(error))
  }

  func sessionManager(manager: SPTSessionManager, didInitiate session: SPTSession) {
    guard self.manager === manager else { return }
    finish(.failure(APIClientError.invalidResponse))
  }

  private func finish(_ result: Result<String, Error>) {
    let pending = continuation
    continuation = nil
    manager?.delegate = nil
    manager = nil
    callbackURL = nil
    pending?.resume(with: result)
  }
}
