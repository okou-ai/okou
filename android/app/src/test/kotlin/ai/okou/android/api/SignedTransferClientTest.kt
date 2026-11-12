package ai.okou.android.api

import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test

class SignedTransferClientTest {
    @Test
    fun signedCallCancellationClosesItsOwnedHttpCall() = runTest {
        val received = CompletableDeferred<Unit>()
        val release = CountDownLatch(1)
        MockWebServer().use { server ->
            server.dispatcher =
                object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse {
                        received.complete(Unit)
                        release.await()
                        return MockResponse().setBody("late")
                    }
                }
            server.start()
            try {
                SignedTransferClient().use { client ->
                    val call = async { client.download(server.url("/signed"), 32) }
                    received.await()
                    call.cancelAndJoin()
                    assertTrue(call.isCancelled)
                }
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun signedDownloadAndUploadCarryOnlyTheirOwnHeaders() = runTest {
        MockWebServer().use { server ->
            server.start()
            SignedTransferClient().use { transfers ->
                server.enqueue(
                    MockResponse().setBody("file").setHeader("Set-Cookie", "session=private")
                )
                assertEquals(
                    "file",
                    transfers.download(server.url("/signed?signature=fixture"), 16).decodeToString(),
                )
                server.enqueue(MockResponse().setResponseCode(204))
                transfers.upload(
                    server.url("/upload?signature=fixture"),
                    "bytes".encodeToByteArray(),
                    mapOf("Content-Type" to "text/plain", "x-amz-meta-file" to "fixture"),
                )
                val download = server.takeRequest()
                val upload = server.takeRequest()
                for (request in listOf(download, upload)) {
                    assertNull(request.getHeader("Authorization"))
                    assertNull(request.getHeader("Cookie"))
                    assertTrue(request.headers.names().none { it.startsWith("x-client-", true) })
                }
                assertEquals("PUT", upload.method)
                assertEquals("bytes", upload.body.readUtf8())
                assertEquals("fixture", upload.getHeader("x-amz-meta-file"))
                assertEquals("text/plain", upload.getHeader("Content-Type"))
                for (name in
                    listOf(
                        "Authorization",
                        "Cookie",
                        "X-Client-Type",
                        "Proxy-Authorization",
                        "Host",
                    )) {
                    failure<IllegalArgumentException> {
                        transfers.upload(
                            server.url("/upload"),
                            byteArrayOf(),
                            mapOf(name to "secret"),
                        )
                    }
                }
                assertEquals(2, server.requestCount)
            }
        }
    }

    @Test
    fun transfersBoundChunkedBytesAndNeverFollowRedirects() = runTest {
        MockWebServer().use { server ->
            server.start()
            SignedTransferClient().use { transfers ->
                server.enqueue(MockResponse().setChunkedBody("too large", 2))
                failure<ResponseLimitExceeded> { transfers.download(server.url("/signed"), 3) }
                server.enqueue(
                    MockResponse().setResponseCode(307).setHeader("Location", server.url("/replay"))
                )
                assertEquals(
                    307,
                    failure<ApiFailure.Http> {
                            transfers.upload(server.url("/upload"), byteArrayOf(1))
                        }
                        .status,
                )
                assertEquals(2, server.requestCount)
            }
        }
    }
}
