package ai.okou.android.api

import ai.okou.android.chat.RealtimeTokenBridge
import io.ably.pubsub.http.Auth
import io.ably.pubsub.types.AblyException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class RealtimeApiTest {
    @Test
    fun sdkRenewalGetsFreshSignedRequestsThroughCanonicalEmptyObjectPostAndIdentityHeaders() =
        runTest {
            MockWebServer().use { server ->
                server.start()
                for (nonce in listOf("first-single-use", "renewed-single-use")) server.enqueue(
                    MockResponse()
                        .setBody(
                            """{"keyName":"app.key","timestamp":1700000000000,"ttl":3600000,"capability":"{}","clientId":"user-a","nonce":"$nonce","mac":"signed"}"""
                        )
                )
                ApiClient(server.url("/"), { "workspace-token" }, version = "0.1.0").use { api ->
                    val errors = mutableListOf<Exception>()
                    RealtimeTokenBridge(
                            coroutineContext,
                            { Json.encodeToString(api.realtimeToken()) },
                            errors::add,
                        )
                        .use { bridge ->
                            val first =
                                withContext(Dispatchers.IO) {
                                    bridge.getTokenRequest(null) as Auth.TokenRequest
                                }
                            val second =
                                withContext(Dispatchers.IO) {
                                    bridge.getTokenRequest(null) as Auth.TokenRequest
                                }
                            assertEquals("first-single-use", first.nonce)
                            assertEquals("renewed-single-use", second.nonce)
                            assertEquals(1700000000000L, second.timestamp)
                            assertEquals(3600000L, second.ttl)
                            repeat(2) {
                                val request = server.takeRequest()
                                assertEquals("POST", request.method)
                                assertEquals("/api/realtime/token", request.path)
                                assertEquals("{}", request.body.readUtf8())
                                assertEquals(
                                    "Bearer workspace-token",
                                    request.getHeader("Authorization"),
                                )
                                assertEquals("Android", request.getHeader("X-Client-Type"))
                                assertEquals("0.1.0", request.getHeader("X-Client-Version"))
                            }
                            assertTrue(errors.isEmpty())
                        }
                }
            }
        }

    @Test
    fun closingSdkBridgeCancelsHeldRenewalWithoutReportingRetirementAsAnApiFailure() = runTest {
        val started = CompletableDeferred<Unit>()
        val ended = CompletableDeferred<Unit>()
        val errors = mutableListOf<Exception>()
        val parent = SupervisorJob()
        val bridge =
            RealtimeTokenBridge(
                parent,
                {
                    started.complete(Unit)
                    try {
                        awaitCancellation()
                    } finally {
                        ended.complete(Unit)
                    }
                },
                errors::add,
            )
        try {
            val request = async(Dispatchers.IO) { runCatching { bridge.getTokenRequest(null) } }
            started.await()
            bridge.close()
            assertTrue(request.await().exceptionOrNull() is AblyException)
            ended.await()
            assertTrue(errors.isEmpty())
        } finally {
            bridge.close()
            parent.cancel()
        }
    }

    @Test
    fun tokenEndpointPreservesInstalledClientRequiredUpdateHandling() = runTest {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(
                MockResponse()
                    .setResponseCode(426)
                    .setBody(
                        """{"error":{"code":"ANDROID_UPDATE_REQUIRED","message":"Update"},"minimumSupportedVersion":"0.2.0"}"""
                    )
            )
            var requirement: RequiredUpdate? = null
            ApiClient(
                    server.url("/"),
                    { "token" },
                    version = "0.1.0",
                    onUpdateRequired = { requirement = it },
                )
                .use { api ->
                    try {
                        api.realtimeToken()
                        fail("An excluded installed client must not receive a realtime token")
                    } catch (error: ApiFailure.UpdateRequired) {
                        assertEquals("0.2.0", error.requirement.minimumSupportedVersion)
                        assertEquals(error.requirement, requirement)
                    }
                }
        }
    }
}
