package ai.okou.android.api

import ai.okou.android.BuildConfig
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException
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
import okio.buffer

internal const val MAX_API_RESPONSE_BYTES = 1024L * 1024L

internal class ResponseLimitExceeded : IOException("Response exceeds the supported size")

internal class HttpRejection(val status: Int, val retryAfter: String?, val envelope: String?) :
    IOException("HTTP $status")

internal fun validateTransportUrl(url: HttpUrl) {
    require(url.username.isEmpty() && url.password.isEmpty()) { "URL credentials are not allowed" }
    require(
        url.isHttps || (BuildConfig.DEBUG && url.host in setOf("localhost", "127.0.0.1", "::1"))
    ) {
        "HTTPS is required; debug cleartext is limited to loopback"
    }
}

internal fun httpClient(): OkHttpClient.Builder =
    OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES)
        .cache(null)
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .callTimeout(30, TimeUnit.SECONDS)
        .addNetworkInterceptor { chain ->
            val response = chain.proceed(chain.request())
            if (!response.isSuccessful) {
                // OkHttp can otherwise follow up a 503 with Retry-After: 0 even with
                // connection retries disabled. Preserve the first result without replay.
                val envelope =
                    response.use {
                        try {
                            checkNotNull(it.body).bounded(64L * 1024).use { body -> body.string() }
                        } catch (_: ResponseLimitExceeded) {
                            null
                        }
                    }
                throw HttpRejection(response.code, response.header("Retry-After"), envelope)
            }
            response
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

internal suspend fun Call.awaitBytes(maximumBytes: Long): ByteArray =
    suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { cancel() }
        enqueue(
            object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    continuation.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    // Keep the Call cancellable until bounded body consumption and cleanup finish.
                    // This callback runs on OkHttp's IO executor, not the main thread.
                    continuation.resumeWith(
                        runCatching {
                            response.use {
                                checkNotNull(it.body).bounded(maximumBytes).use { body ->
                                    body.bytes()
                                }
                            }
                        }
                    )
                }
            }
        )
    }
