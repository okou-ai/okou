import ChatData
import ChatDataTestSupport

extension ChatHTTPFixture {
  var client: APIClient {
    APIClient(baseURL: baseURL, clientVersion: clientVersion, session: session) {
      "local-test-session"
    }
  }
}
