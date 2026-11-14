package ai.okou.android.api

import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.time.Duration
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Signed assets/storage have no access to API tokens, cookies or client identity. */
class SignedTransferClient(
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
    callTimeout: Duration = DEFAULT_CALL_TIMEOUT,
) : Closeable {
    private val http = httpClient(callTimeout).build()
    private val closed = AtomicBoolean(false)

    suspend fun download(url: HttpUrl, maximumBytes: Long): ByteArray =
        withContext(dispatcher) {
            require(maximumBytes in 1..Int.MAX_VALUE.toLong())
            execute(Request.Builder().url(url).build(), maximumBytes)
        }

    /** Stream canonical archives without an Android-only data-size cutoff or byte/string copies. */
    suspend fun <T> download(url: HttpUrl, read: (InputStream) -> T): T =
        withContext(dispatcher) {
            check(!closed.get()) { "Transfer owner has closed" }
            validateTransportUrl(url)
            currentCoroutineContext().ensureActive()
            try {
                http.newCall(Request.Builder().url(url).build()).awaitBody { body ->
                    body.byteStream().use(read)
                }
            } catch (error: IOException) {
                currentCoroutineContext().ensureActive()
                error.httpRejection()?.let { throw ApiFailure.Http(it.status, null, null, null) }
                throw error
            }
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
        } catch (error: IOException) {
            currentCoroutineContext().ensureActive()
            error.httpRejection()?.let { throw ApiFailure.Http(it.status, null, null, null) }
            throw error
        }
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) http.closeTransport()
    }
}
