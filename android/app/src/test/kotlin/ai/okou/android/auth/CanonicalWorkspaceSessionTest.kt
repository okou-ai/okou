package ai.okou.android.auth

import ai.okou.android.TEST_PREFERENCES
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.InitializePreferencesRequestLocale
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UpdatePreferencesRequestLocale
import java.util.Locale
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class CanonicalWorkspaceSessionTest {
    private val server = MockWebServer()

    @Before fun start() = server.start()

    @After fun stop() = server.shutdown()

    private fun owner() =
        CanonicalWorkspaceSession(
            WorkspaceIdentity(server.url("/").toString(), "user-a", "session-a", "org-a"),
            WorkspaceTokenProvider { "token" },
            InitializePreferencesRequestLocale.ZH_HANT,
            "Asia/Shanghai",
        )

    @Test
    fun preferenceUpdateUsesTheCanonicalScopedRouteAndOnlyTheSelectedFields() = runTest {
        server.enqueue(MockResponse().setBody(TEST_PREFERENCES))
        owner().use {
            it.updatePreferences(
                UpdatePreferencesRequest(locale = UpdatePreferencesRequestLocale.ZH_HANT)
            )
        }
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/user-preferences", request.path)
        assertEquals("Bearer token", request.getHeader("Authorization"))
        assertEquals("Android", request.getHeader("X-Client-Type"))
        assertEquals("""{"locale":"zh-Hant"}""", request.body.readUtf8())
    }

    @Test
    fun initializedCanonicalPreferencesNeedNoWrite() = runTest {
        server.enqueue(MockResponse().setBody("""{"id":"org-a","name":"A"}"""))
        server.enqueue(MockResponse().setBody(TEST_PREFERENCES))
        owner().use { assertTrue(it.bootstrap().preferences.memoryInitialized) }
        assertEquals(2, server.requestCount)
        assertEquals("/api/org", server.takeRequest().path)
        assertEquals("/api/user-preferences", server.takeRequest().path)
    }

    @Test
    fun canonicalTimezoneIsNotRewrittenUsingTheDevicesTimezoneCatalog() = runTest {
        server.enqueue(MockResponse().setBody("""{"id":"org-a","name":"A"}"""))
        server.enqueue(MockResponse().setBody(TEST_PREFERENCES.replace("UTC", "America/Coyhaique")))
        owner().use { assertEquals("America/Coyhaique", it.bootstrap().preferences.timezone) }
        assertEquals(2, server.requestCount)
    }

    @Test
    fun missingPreferencesOrMemoryUsesCanonicalIdempotentInitialization() = runTest {
        for (response in
            listOf(
                MockResponse()
                    .setResponseCode(409)
                    .setBody("""{"error":{"code":"NOT_INITIALIZED","message":"Initialize"}}"""),
                MockResponse()
                    .setBody(
                        TEST_PREFERENCES.replace(
                            "\"memoryInitialized\":true",
                            "\"memoryInitialized\":false",
                        )
                    ),
            )) {
            server.enqueue(MockResponse().setBody("""{"id":"org-a","name":"A"}"""))
            server.enqueue(response)
            server.enqueue(MockResponse().setBody(TEST_PREFERENCES))
            owner().use { assertTrue(it.bootstrap().preferences.memoryInitialized) }
            server.takeRequest()
            server.takeRequest()
            val initialize = server.takeRequest()
            assertEquals("POST", initialize.method)
            assertEquals("/api/user-preferences/initialize", initialize.path)
            assertEquals(
                """{"timezone":"Asia/Shanghai","locale":"zh-Hant"}""",
                initialize.body.readUtf8(),
            )
        }
    }

    @Test
    fun wrongWorkspaceOrIncompleteInitializationNeverGrantsReadyData() = runTest {
        server.enqueue(MockResponse().setBody("""{"id":"org-b","name":"Other"}"""))
        owner().use {
            assertTrue(runCatching { it.bootstrap() }.exceptionOrNull() is IllegalStateException)
        }
        assertEquals(1, server.requestCount)
        server.enqueue(MockResponse().setBody("""{"id":"org-a","name":"A"}"""))
        val uninitialized =
            TEST_PREFERENCES.replace("\"memoryInitialized\":true", "\"memoryInitialized\":false")
        server.enqueue(MockResponse().setBody(uninitialized))
        server.enqueue(MockResponse().setBody(uninitialized))
        owner().use {
            assertTrue(runCatching { it.bootstrap() }.exceptionOrNull() is IllegalStateException)
        }
    }

    @Test
    fun bootstrapLocaleFollowsSupportedLanguageAndChineseScript() {
        assertEquals(
            InitializePreferencesRequestLocale.ZH_HANT,
            initialLocale(Locale.forLanguageTag("zh-HK")),
        )
        assertEquals(
            InitializePreferencesRequestLocale.ZH_HANS,
            initialLocale(Locale.forLanguageTag("zh-Hans-TW")),
        )
        assertEquals(
            InitializePreferencesRequestLocale.EN_US,
            initialLocale(Locale.forLanguageTag("ar-EG")),
        )
    }
}
