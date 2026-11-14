package ai.okou.android.api

import ai.okou.android.BuildConfig
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.ForwardingSource
import okio.GzipSource
import okio.buffer

internal val DEFAULT_CALL_TIMEOUT = 30.seconds

internal class ResponseLimitExceeded : IOException("Response exceeds the supported size")

internal class HttpRejection(val status: Int, val retryAfter: String?, val envelope: String?) :
    IOException("HTTP $status")

internal fun IOException.httpRejection(): HttpRejection? =
    when (this) {
        is HttpRejection -> this
        // OkHttp wraps an interceptor failure when the whole-call deadline expires.
        is InterruptedIOException -> cause as? HttpRejection
        else -> null
    }

internal fun validateTransportUrl(url: HttpUrl) {
    require(url.username.isEmpty() && url.password.isEmpty()) { "URL credentials are not allowed" }
    require(
        url.isHttps || (BuildConfig.DEBUG && url.host in setOf("localhost", "127.0.0.1", "::1"))
    ) {
        "HTTPS is required; debug cleartext is limited to loopback"
    }
}

internal fun httpClient(callTimeout: Duration = DEFAULT_CALL_TIMEOUT): OkHttpClient.Builder {
    require(callTimeout.isFinite() && callTimeout.inWholeMilliseconds > 0) {
        "The HTTP call timeout must be finite and at least one millisecond"
    }
    return OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES)
        .cache(null)
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .callTimeout(callTimeout.inWholeMilliseconds, TimeUnit.MILLISECONDS)
        .addNetworkInterceptor { chain ->
            val response = chain.proceed(chain.request())
            if (!response.isSuccessful) {
                // OkHttp can otherwise follow up a 503 with Retry-After: 0 even with
                // connection retries disabled. Preserve the first result without replay.
                val envelope =
                    response.use {
                        try {
                            it.errorBody().bounded(64L * 1024).use { body -> body.string() }
                        } catch (_: IOException) {
                            null
                        }
                    }
                throw HttpRejection(response.code, response.header("Retry-After"), envelope)
            }
            response
        }
}

private fun Response.errorBody(): ResponseBody {
    val original = checkNotNull(body)
    if (!header("Content-Encoding").equals("gzip", ignoreCase = true)) return original
    // Rejections are captured before OkHttp's transparent decompression so they cannot replay.
    // Decode here to apply the envelope limit to the bytes the JSON reader actually consumes.
    val decoded = GzipSource(original.source()).buffer()
    return object : ResponseBody() {
        override fun contentType() = original.contentType()

        override fun contentLength() = -1L

        override fun source() = decoded
    }
}

internal fun OkHttpClient.closeTransport() {
    dispatcher.cancelAll()
    connectionPool.evictAll()
    dispatcher.executorService.shutdown()
}

internal fun ResponseBody.bounded(maximumBytes: Long): ResponseBody {
    val original = this
    if (contentLength() > maximumBytes) {
        close()
        throw ResponseLimitExceeded()
    }
    val limited =
        object : ForwardingSource(source()) {
                private var total = 0L

                override fun read(sink: Buffer, byteCount: Long): Long {
                    val read = super.read(sink, minOf(byteCount, maximumBytes - total + 1))
                    if (read > 0) total += read
                    if (total > maximumBytes) throw ResponseLimitExceeded()
                    return read
                }
            }
            .buffer()
    return object : ResponseBody() {
        override fun contentType() = original.contentType()

        override fun contentLength() = original.contentLength()

        override fun source() = limited
    }
}

internal suspend fun Call.awaitBytes(maximumBytes: Long): ByteArray = awaitBody { body ->
    body.bounded(maximumBytes).use { it.bytes() }
}

internal suspend fun <T> Call.awaitBody(read: (ResponseBody) -> T): T =
    suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { cancel() }
        enqueue(
            object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    continuation.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    // Keep the Call cancellable until streamed body consumption and cleanup finish.
                    // This callback runs on OkHttp's IO executor, not the main thread.
                    continuation.resumeWith(
                        runCatching { response.use { read(checkNotNull(it.body)) } }
                    )
                }
            }
        )
    }
