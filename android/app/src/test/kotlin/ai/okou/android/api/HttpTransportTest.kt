package ai.okou.android.api

import ai.okou.android.FixtureHttpsServer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.Dispatcher
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpTransportTest {
    @Test
    fun closeShutsDownTheDispatcherBeforeIdleTlsEvictionCompletes() {
        FixtureHttpsServer().use { fixture ->
            fixture.server.enqueue(MockResponse().setBody("ok"))
            fixture.server.start()
            val executor = Executors.newSingleThreadExecutor()
            val client = httpClient().dispatcher(Dispatcher(executor)).build()
            val allowEviction = CountDownLatch(1)
            try {
                val request = Request.Builder().url(fixture.server.url("/")).build()
                client.newCall(request).execute().use { response ->
                    assertEquals("ok", response.body.string())
                }
                assertEquals(1, client.connectionPool.idleConnectionCount())

                executor.execute { allowEviction.await(10, TimeUnit.SECONDS) }
                client.closeTransport()
                assertTrue(executor.isShutdown)
                assertEquals(1, client.connectionPool.idleConnectionCount())

                allowEviction.countDown()
                assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
                assertEquals(0, client.connectionPool.connectionCount())
            } finally {
                allowEviction.countDown()
                executor.shutdown()
                client.connectionPool.evictAll()
            }
        }
    }
}
