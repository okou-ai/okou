import Testing

@testable import ComputerUseHelperCore

struct BrowserAddressFieldPolicyTests {
    @Test
    func recognizesSafariAddressFieldIdentifier() {
        let attributes = BrowserAddressFieldAttributes(
            role: "AXTextField",
            identifier: "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD",
            description: "smart search field",
            placeholder: nil,
            title: nil,
            valueSettable: true
        )

        #expect(isBrowserAddressField(bundleId: "com.apple.Safari", attributes: attributes))
    }

    @Test
    func recognizesChromeAddressFieldDescription() {
        let attributes = BrowserAddressFieldAttributes(
            role: "AXTextField",
            identifier: nil,
            description: "Address and search bar",
            placeholder: "Ask Google or type a URL",
            title: nil,
            valueSettable: true
        )

        #expect(isBrowserAddressField(bundleId: "com.google.Chrome", attributes: attributes))
    }

    @Test
    func rejectsUnsupportedApps() {
        let attributes = BrowserAddressFieldAttributes(
            role: "AXTextField",
            identifier: "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD",
            description: "Address and search bar",
            placeholder: nil,
            title: nil,
            valueSettable: true
        )

        #expect(!isBrowserAddressField(bundleId: "com.apple.TextEdit", attributes: attributes))
    }

    @Test
    func rejectsSearchTextAsNavigationURL() {
        #expect(normalizedBrowserNavigationURL("reddit search query") == nil)
    }

    @Test
    func preservesExplicitHTTPSURL() {
        #expect(
            normalizedBrowserNavigationURL("https://www.reddit.com/") == "https://www.reddit.com/"
        )
    }

    @Test
    func defaultsBarePublicHostToHTTPS() {
        #expect(normalizedBrowserNavigationURL("www.reddit.com/") == "https://www.reddit.com/")
    }

    @Test
    func defaultsLocalhostToHTTP() {
        #expect(normalizedBrowserNavigationURL("127.0.0.1:8765") == "http://127.0.0.1:8765")
    }
}
