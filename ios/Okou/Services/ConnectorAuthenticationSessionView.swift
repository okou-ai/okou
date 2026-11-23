import AuthenticationServices
import SwiftUI

/// Adapts the system browser to the connector attempt that owns its API receipt.
struct ConnectorAuthenticationSessionView: UIViewControllerRepresentable {
  let url: URL?
  let callbackURL: URL?
  let onFinish: @MainActor (URL, URL?, Error?) -> Void

  func makeUIViewController(context: Context) -> Controller { Controller() }

  func updateUIViewController(_ controller: Controller, context: Context) {
    controller.update(url: url, callbackURL: callbackURL, onFinish: onFinish)
  }

  static func dismantleUIViewController(_ controller: Controller, coordinator: ()) {
    controller.cancel()
  }

  final class Controller: UIViewController {
    private var requestedURL: URL?
    private var callbackURL: URL?
    private var requestID: UUID?
    private var session: ASWebAuthenticationSession?
    private var presentation: Presentation?
    private var onFinish: (@MainActor (URL, URL?, Error?) -> Void)?

    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      startIfReady()
    }

    func update(
      url: URL?, callbackURL: URL?, onFinish: @escaping @MainActor (URL, URL?, Error?) -> Void
    ) {
      self.onFinish = onFinish
      guard requestedURL != url || self.callbackURL != callbackURL else { return }
      cancel()
      requestedURL = url
      self.callbackURL = callbackURL
      startIfReady()
    }

    private func startIfReady() {
      guard session == nil, let url = requestedURL, let window = view.window else { return }
      let id = UUID()
      requestID = id
      let presentation = Presentation(window: window)
      let completion: ASWebAuthenticationSession.CompletionHandler = {
        [weak self] callback, error in
        Task { @MainActor [weak self] in
          self?.finish(id: id, url: url, callbackURL: callback, error: error)
        }
      }
      let session: ASWebAuthenticationSession
      if let callbackURL, let host = callbackURL.host {
        session = ASWebAuthenticationSession(
          url: url, callback: .https(host: host, path: callbackURL.path),
          completionHandler: completion)
      } else {
        // Older APIs and other providers still complete through receipt polling.
        session = ASWebAuthenticationSession(
          url: url, callbackURLScheme: nil, completionHandler: completion)
      }
      session.presentationContextProvider = presentation
      session.prefersEphemeralWebBrowserSession = false
      self.presentation = presentation
      self.session = session
      if !session.start() {
        finish(id: id, url: url, callbackURL: nil, error: PresentationError.unavailable)
      }
    }

    private func finish(id: UUID, url: URL, callbackURL: URL?, error: Error?) {
      guard requestID == id else { return }
      requestID = nil
      requestedURL = nil
      session = nil
      presentation = nil
      if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
        onFinish?(url, callbackURL, CancellationError())
      } else {
        onFinish?(url, callbackURL, error)
      }
    }

    func cancel() {
      requestID = nil
      let previous = session
      session = nil
      presentation = nil
      requestedURL = nil
      previous?.cancel()
    }
  }

  private final class Presentation: NSObject, ASWebAuthenticationPresentationContextProviding {
    let window: UIWindow
    init(window: UIWindow) { self.window = window }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
      window
    }
  }

  private enum PresentationError: Error { case unavailable }
}
