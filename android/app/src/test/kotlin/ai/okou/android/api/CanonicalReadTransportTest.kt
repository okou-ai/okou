package ai.okou.android.api

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.chat.HistoryCursor
import ai.okou.android.chat.HistoryEvent
import ai.okou.android.chat.historyJson
import ai.okou.android.chat.readHistoryNdjson
import ai.okou.android.historyEventWire
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.*
import org.junit.Test

class CanonicalReadTransportTest {
    @Test
    fun progressingHistoryAndArchiveReadsOutliveTheOrdinaryControlBudget() = runTest {
        val wire = historyEventWire(payload = """{"content":"${"x".repeat(1_600)}"}""")
        MockWebServer().use { server ->
            server.dispatcher =
                object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse =
                        when (request.requestUrl!!.encodedPath) {
                            "/api/chat/events/catch-up" ->
                                MockResponse()
                                    .setBody(
                                        """{"events":{"$CHAT_PERSONAL":[$wire]},"notFoundThreads":[]}"""
                                    )
                                    .throttleBody(32, 50, TimeUnit.MILLISECONDS)
                            "/archive" ->
                                MockResponse()
                                    .setBody("$wire\n")
                                    .throttleBody(32, 50, TimeUnit.MILLISECONDS)
                            else -> MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)
                        }
                }
            server.start()
            ApiClient(
                    server.url("/"),
                    WorkspaceTokenProvider { "fixture-token" },
                    version = "0.1.0",
                    callTimeout = 1.seconds,
                )
                .use { api ->
                    SignedTransferClient(callTimeout = 1.seconds).use { transfers ->
                        val history = async {
                            api.historyCatchUp(mapOf(CHAT_PERSONAL to HistoryCursor()))
                        }
                        val archive = async {
                            transfers.download(server.url("/archive"), ::readHistoryNdjson)
                        }
                        // The wire deliberately progresses beyond the ordinary call budget;
                        // synchronization awaits real outcomes, never an elapsed-time assertion.
                        val control = failure<ApiFailure.Network> { api.realtimeToken() }
                        assertTrue(control.cause is InterruptedIOException)
                        val returned = history.await().events.getValue(CHAT_PERSONAL).single()
                        assertEquals(
                            HistoryEvent.decode(wire).wire,
                            historyJson.encodeToJsonElement(returned).jsonObject,
                        )
                        assertEquals(HistoryEvent.decode(wire).wire, archive.await().single().wire)
                        assertEquals(3, server.requestCount)
                    }
                }
        }
    }

    @Test
    fun progressingErrorBodiesStillHaveABudgetAndRetainTheRequiredUpdate() = runTest {
        MockWebServer().use { server ->
            server.enqueue(
                MockResponse()
                    .setResponseCode(426)
                    .setChunkedBody("x".repeat(1_024 * 1_024), 32)
                    .throttleBody(32, 50, TimeUnit.MILLISECONDS)
            )
            server.start()
            ApiClient(
                    server.url("/"),
                    WorkspaceTokenProvider { "fixture-token" },
                    version = "0.1.0",
                    callTimeout = 1.seconds,
                )
                .use { api ->
                    val error = failure<ApiFailure.UpdateRequired> { api.organization() }
                    assertNull(error.requirement.minimumSupportedVersion)
                    assertEquals(error.requirement, api.updateRequired.value)
                    failure<ApiFailure.UpdateRequired> { api.organization() }
                    assertEquals(1, server.requestCount)
                }
        }
    }

    @Test
    fun stalledSuccessfulReadsRetainTheSocketReadIdleTimeout() = runTest {
        MockWebServer().use { server ->
            server.dispatcher =
                object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest) =
                        MockResponse().setBody("").setHeader("Content-Length", "1")
                }
            server.start()
            ApiClient(
                    server.url("/"),
                    WorkspaceTokenProvider { "fixture-token" },
                    version = "0.1.0",
                    callTimeout = 1.seconds,
                )
                .use { api ->
                    SignedTransferClient(callTimeout = 1.seconds).use { transfers ->
                        val history = async {
                            failure<ApiFailure.Network> {
                                api.historyCatchUp(mapOf(CHAT_PERSONAL to HistoryCursor()))
                            }
                        }
                        val archive = async {
                            failure<SocketTimeoutException> {
                                transfers.download(server.url("/archive"), ::readHistoryNdjson)
                            }
                        }
                        assertTrue(history.await().cause is SocketTimeoutException)
                        archive.await()
                    }
                }
        }
    }

    @Test
    fun cancellingAStreamWhileItsBodyIsIncompleteClosesTheOwnedRead() = runTest {
        val entered = CompletableDeferred<Unit>()
        val exited = CompletableDeferred<Unit>()
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("x").setHeader("Content-Length", "1024"))
            server.start()
            SignedTransferClient().use { transfers ->
                val request = async {
                    transfers.download(server.url("/archive")) { stream ->
                        assertEquals('x'.code, stream.read())
                        entered.complete(Unit)
                        try {
                            stream.readBytes()
                        } finally {
                            exited.complete(Unit)
                        }
                    }
                }
                entered.await()
                request.cancelAndJoin()
                exited.await()
                assertTrue(request.isCancelled)
            }
        }
    }
}
