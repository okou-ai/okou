package ai.okou.android.api

import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Signed assets/storage have no access to API tokens, cookies or client identity. */
class SignedTransferClient(private val dispatcher: CoroutineDispatcher = Dispatchers.IO) :
    Closeable {
    private val http = httpClient().build()
    private val closed = AtomicBoolean(false)

    suspend fun download(url: HttpUrl, maximumBytes: Long): ByteArray =
        withContext(dispatcher) {
            require(maximumBytes in 1..Int.MAX_VALUE.toLong())
            execute(Request.Builder().url(url).build(), maximumBytes)
        }

    suspend fun upload(url: HttpUrl, bytes: ByteArray, headers: Map<String, String> = emptyMap()) =
        withContext(dispatcher) {
            val request = Request.Builder().url(url).put(bytes.toRequestBody())
            for ((name, value) in headers) {
                require(
                    !name.equals("authorization", true) &&
                        !name.equals("proxy-authorization", true) &&
                        !name.equals("cookie", true) &&
                        !name.equals("host", true) &&
                        !name.startsWith("x-client-", true)
                ) {
                    "API credentials and client headers do not belong on signed transfers"
                }
                request.header(name, value)
            }
            execute(request.build(), 64 * 1024)
            Unit
        }

    private suspend fun execute(request: Request, maximumBytes: Long): ByteArray {
        check(!closed.get()) { "Transfer owner has closed" }
        validateTransportUrl(request.url)
        currentCoroutineContext().ensureActive()
        return try {
            http.newCall(request).awaitBytes(maximumBytes)
        } catch (error: HttpRejection) {
            currentCoroutineContext().ensureActive()
            throw ApiFailure.Http(error.status, null, null, null)
        }
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) http.closeTransport()
    }
}
