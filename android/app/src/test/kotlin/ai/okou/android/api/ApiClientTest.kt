package ai.okou.android.api

import ai.okou.android.api.generated.InitializePreferencesRequest
import ai.okou.android.api.generated.InitializePreferencesRequestLocale
import ai.okou.android.api.generated.OrganizationRole
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import okio.GzipSink
import okio.buffer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class ApiClientTest {
    private val server = MockWebServer()

    @Before
    fun start() {
        server.start()
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun client(
        tokens: WorkspaceTokenProvider = WorkspaceTokenProvider { "workspace-token" }
    ) = ApiClient(server.url("/"), tokens, version = "0.1.0")

    @Test
    fun lazyTransportUsesFreshTokensAndDistinctRequestIdentity() = runTest {
        val resolved = AtomicInteger()
        client { "token-${resolved.incrementAndGet()}" }
            .use { api ->
                assertEquals(0, resolved.get())
                assertEquals(0, server.requestCount)
                server.enqueue(MockResponse().setBody(organization))
                server.enqueue(MockResponse().setBody(organization))
                assertEquals(OrganizationRole.ADMIN, api.organization().role)
                api.organization()
                val first = server.takeRequest()
                val second = server.takeRequest()
                assertEquals("GET", first.method)
                assertEquals("/api/org", first.path)
                assertEquals("Bearer token-1", first.getHeader("Authorization"))
                assertEquals("Bearer token-2", second.getHeader("Authorization"))
                assertEquals("Android", first.getHeader("X-Client-Type"))
                assertEquals("0.1.0", first.getHeader("X-Client-Version"))
                assertNotNull(first.getHeader("X-Client-Session-Id"))
                assertEquals(
                    first.getHeader("X-Client-Session-Id"),
                    second.getHeader("X-Client-Session-Id"),
                )
                assertNotEquals(
                    first.getHeader("X-Client-Request-Id"),
                    second.getHeader("X-Client-Request-Id"),
                )
            }
    }

    @Test
    fun generatedInitializeRequestOmitsAbsentFieldsAndDecodesNullablePreferences() = runTest {
        client().use { api ->
            server.enqueue(MockResponse().setBody(preferences))
            val value =
                api.initializePreferences(
                    InitializePreferencesRequest(
                        locale = InitializePreferencesRequestLocale.ZH_HANT
                    )
                )
            assertNull(value.timezone)
            assertTrue(value.memoryInitialized)
            val request = server.takeRequest()
            assertEquals("POST", request.method)
            assertEquals("/api/user-preferences/initialize", request.path)
            assertEquals(
                Json.parseToJsonElement("""{"locale":"zh-Hant"}"""),
                Json.parseToJsonElement(request.body.readUtf8()),
            )
        }
    }

    @Test
    fun missingRequiredNullableFieldsWrongTypesAndUnknownEnumsFailDecoding() = runTest {
        for (body in
            listOf(
                preferences.replace("\"timezone\":null,", ""),
                preferences.replace("\"system\"", "\"future-mode\""),
                preferences.replace("\"memoryInitialized\":true", "\"memoryInitialized\":{}"),
            )) {
            client().use { api ->
                server.enqueue(MockResponse().setBody(body))
                val result = runCatching { api.preferences() }.exceptionOrNull()
                assertTrue(
                    "Expected incompatible response for $body; actual=$result",
                    result is ApiFailure.IncompatibleResponse,
                )
            }
        }
    }

    @Test
    fun preservesHttpErrorsAndRetryInformationWithoutReplayingRequests() = runTest {
        client().use { api ->
            for ((index, status) in listOf(401, 403, 409, 429, 500, 503).withIndex()) {
                server.enqueue(
                    MockResponse()
                        .setResponseCode(status)
                        .setHeader("Retry-After", "0")
                        .setBody(error)
                )
                val result = failure<ApiFailure.Http> { api.organization() }
                assertEquals(status, result.status)
                assertEquals("FIXTURE_ERROR", result.code)
                assertEquals("Try again", result.serverMessage)
                assertEquals(0L, result.retryAfterSeconds)
                assertEquals(index + 1, server.requestCount)
            }
            server.enqueue(MockResponse().setResponseCode(502).setBody("not json"))
            val malformed = failure<ApiFailure.Http> { api.organization() }
            assertEquals(502, malformed.status)
            assertNull(malformed.code)
        }
    }

    @Test
    fun aRetryAfterZeroWriteIsNotReplayed() = runTest {
        server.dispatcher =
            object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) =
                    MockResponse().setResponseCode(503).setHeader("Retry-After", "0").setBody(error)
            }
        client().use { api ->
            failure<ApiFailure.Http> {
                api.initializePreferences(
                    InitializePreferencesRequest(locale = InitializePreferencesRequestLocale.EN_US)
                )
            }
            assertEquals(1, server.requestCount)
        }
    }

    @Test
    fun updateRequiredIsRetainedAndBlocksFurtherOperationsEvenWithMalformedEnvelope() = runTest {
        for ((body, minimum) in
            listOf(
                """{"error":{"code":"ANDROID_UPDATE_REQUIRED","message":"Update"},"minimumSupportedVersion":"0.2.0"}""" to
                    "0.2.0",
                "invalid" to null,
                "x".repeat(128 * 1024) to null,
                """{"error":{"code":"IOS_UPDATE_REQUIRED","message":"Update"},"minimumSupportedVersion":"0.2.0"}""" to
                    null,
            )) {
            val before = server.requestCount
            client().use { api ->
                server.enqueue(MockResponse().setResponseCode(426).setBody(body))
                val rejected = failure<ApiFailure.UpdateRequired> { api.organization() }
                assertEquals(minimum, rejected.requirement.minimumSupportedVersion)
                assertEquals(rejected.requirement, api.updateRequired.value)
                failure<ApiFailure.UpdateRequired> { api.preferences() }
                assertEquals(before + 1, server.requestCount)
            }
        }
    }

    @Test
    fun cancellationDuringTokenResolutionDoesNotSendAnything() = runTest {
        val entered = CompletableDeferred<Unit>()
        val token = CompletableDeferred<String>()
        client {
                entered.complete(Unit)
                token.await()
            }
            .use { api ->
                val request = async { api.organization() }
                entered.await()
                request.cancelAndJoin()
                assertTrue(request.isCancelled)
                assertEquals(0, server.requestCount)
            }
    }

    @Test
    fun callDeadlinePreservesReceivedHttpStatusAndRetainsRequiredUpdate() = runTest {
        server.dispatcher =
            object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) =
                    MockResponse()
                        .setResponseCode(if (request.path == "/api/org") 426 else 503)
                        .setBody("")
                        // Headers are complete, but the peer never finishes its error body.
                        .setHeader("Content-Length", "8")
                        .setHeader("Retry-After", "0")
            }
        ApiClient(
                server.url("/"),
                WorkspaceTokenProvider { "workspace-token" },
                version = "0.1.0",
                callTimeout = 5.seconds,
            )
            .use { api ->
                SignedTransferClient(callTimeout = 5.seconds).use { transfers ->
                    val update = async { failure<ApiFailure.UpdateRequired> { api.organization() } }
                    val transfer = async {
                        failure<ApiFailure.Http> { transfers.download(server.url("/signed"), 32) }
                    }
                    assertNull(update.await().requirement.minimumSupportedVersion)
                    assertEquals(RequiredUpdate(null), api.updateRequired.value)
                    assertEquals(503, transfer.await().status)
                    failure<ApiFailure.UpdateRequired> { api.preferences() }
                    assertEquals(2, server.requestCount)
                }
            }
    }

    @Test
    fun pendingHttpCallIsCancellableAndRetiredOwnerCannotPublish() = runTest {
        val received = CompletableDeferred<Unit>()
        val release = CountDownLatch(1)
        server.dispatcher =
            object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    received.complete(Unit)
                    release.await()
                    return MockResponse().setBody(organization)
                }
            }
        try {
            client().use { api ->
                val request = async { api.organization() }
                received.await()
                request.cancelAndJoin()
                assertTrue(request.isCancelled)
                release.countDown()
            }
        } finally {
            release.countDown()
        }
    }

    @Test
    fun rejectsRedirectsWithoutForwardingCredentialsAndRejectsInvalidOrigins() = runTest {
        MockWebServer().use { destination ->
            destination.start()
            server.enqueue(
                MockResponse()
                    .setResponseCode(302)
                    .setHeader("Location", destination.url("/capture"))
            )
            client().use { api ->
                assertEquals(302, failure<ApiFailure.Http> { api.organization() }.status)
            }
            assertEquals(0, destination.requestCount)
        }
        for (url in
            listOf(
                "http://api.example/",
                "https://api.example/api/",
                "https://user:pass@api.example/",
                "https://api.example/?token=secret",
            )) {
            failure<IllegalArgumentException> {
                ApiClient(url.toHttpUrl(), WorkspaceTokenProvider { "unused" }).close()
            }
        }
        client { null }.use { api -> failure<ApiFailure.Unauthenticated> { api.organization() } }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun streamsLargeKnownLengthChunkedAndCompressedCanonicalResponses() = runTest {
        val oversized = """{"id":"org_large","name":"${"x".repeat(2 * 1024 * 1024)}"}"""
        client().use { api ->
            for (response in
                listOf(
                    MockResponse().setBody(oversized),
                    MockResponse().setChunkedBody(oversized, 8192),
                    gzipResponse(oversized),
                )) {
                server.enqueue(response)
                val organization = api.organization()
                assertEquals("org_large", organization.id)
                assertEquals(2 * 1024 * 1024, organization.name.length)
            }
        }
    }

    @Test
    fun decodesAndBoundsCompressedResponsesAfterDecompression() = runTest {
        client().use { api ->
            server.enqueue(gzipResponse(organization))
            assertEquals(OrganizationRole.ADMIN, api.organization().role)
            server.enqueue(gzipResponse(error).setResponseCode(503).setHeader("Retry-After", "0"))
            assertEquals("FIXTURE_ERROR", failure<ApiFailure.Http> { api.organization() }.code)
            val oversized =
                """{"error":{"code":"TOO_LARGE","message":"${"x".repeat(64 * 1024)}"}}"""
            server.enqueue(gzipResponse(oversized).setResponseCode(500))
            val rejected = failure<ApiFailure.Http> { api.organization() }
            assertEquals(500, rejected.status)
            assertNull(rejected.code)
            server.enqueue(
                MockResponse()
                    .setResponseCode(502)
                    .setHeader("Content-Encoding", "gzip")
                    .setBody("invalid gzip")
            )
            assertEquals(502, failure<ApiFailure.Http> { api.organization() }.status)
            server.enqueue(
                gzipResponse(
                        """{"error":{"code":"ANDROID_UPDATE_REQUIRED","message":"Update"},"minimumSupportedVersion":"0.2.0"}"""
                    )
                    .setResponseCode(426)
            )
            assertEquals(
                "0.2.0",
                failure<ApiFailure.UpdateRequired> { api.organization() }
                    .requirement
                    .minimumSupportedVersion,
            )
            assertEquals(5, server.requestCount)
        }
    }

    @Test
    fun lostWriteResponseRemainsUncertainAndIsNotReplayed() = runTest {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        client().use { api ->
            failure<ApiFailure.Network> {
                api.initializePreferences(
                    InitializePreferencesRequest(locale = InitializePreferencesRequestLocale.EN_US)
                )
            }
            assertEquals(1, server.requestCount)
            assertEquals("POST", server.takeRequest().method)
        }
    }

    @Test
    fun pendingSuccessCannotEscapeAnUpdateRequiredState() = runTest {
        val received = CompletableDeferred<Unit>()
        val release = CountDownLatch(1)
        server.dispatcher =
            object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.path == "/api/org") {
                        received.complete(Unit)
                        release.await()
                        return MockResponse().setBody(organization)
                    }
                    return MockResponse().setResponseCode(426).setBody("invalid")
                }
            }
        try {
            client().use { api ->
                val first = async { runCatching { api.organization() } }
                received.await()
                failure<ApiFailure.UpdateRequired> { api.preferences() }
                release.countDown()
                assertTrue(first.await().exceptionOrNull() is ApiFailure.UpdateRequired)
            }
        } finally {
            release.countDown()
        }
    }

    @Test
    fun incompatibleResponseDiagnosticsDoNotExposeWireValues() = runTest {
        val privateValue = "fixture-private-response-value"
        server.enqueue(MockResponse().setBody(organization.replace("admin", privateValue)))
        client().use { api ->
            val error = failure<ApiFailure.IncompatibleResponse> { api.organization() }
            assertFalse(error.stackTraceToString().contains(privateValue))
        }
    }

    private companion object {
        const val organization =
            """{"id":"org_one","name":"Workspace","role":"admin","futureField":true}"""
        const val error = """{"error":{"code":"FIXTURE_ERROR","message":"Try again"}}"""
        const val preferences =
            """{"timezone":null,"locale":null,"supportedLocales":["en-US","zh-Hant"],"pinnedAgentIds":[],"sendMode":"enter","cloudBrowserEnabledByDefault":false,"chatResourcesEnabledByDefault":false,"theme":"system","colorTheme":null,"captureNetworkBodiesRemaining":0,"memoryInitialized":true}"""
    }
}

internal suspend inline fun <reified T : Throwable> failure(block: suspend () -> Unit): T {
    try {
        block()
    } catch (error: Throwable) {
        if (error is T) return error else throw error
    }
    throw AssertionError("Expected ${T::class.simpleName}")
}

private fun gzipResponse(body: String): MockResponse {
    val compressed = Buffer()
    GzipSink(compressed).buffer().use { it.writeUtf8(body) }
    return MockResponse().setHeader("Content-Encoding", "gzip").setBody(compressed)
}
