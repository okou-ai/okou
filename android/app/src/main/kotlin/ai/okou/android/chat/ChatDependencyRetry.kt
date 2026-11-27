package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.continuousRetryDelayMillis
import ai.okou.android.api.continuousRetryDelays
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull

internal const val ChatDependencyRetryCount = 2
internal const val ChatDependencyRetryDelayMillis = 3_000L

internal fun chatReadRetryDelayMillis(error: Exception, retries: Int): Long? =
    when (error) {
        is ApiFailure.Network,
        is ApiFailure.IncompatibleResponse -> continuousRetryDelayMillis(retries)
        is ApiFailure.Http ->
            if (retryableChatReadStatus(error.status))
                continuousRetryDelayMillis(retries, error.retryAfterSeconds)
            else null
        // A fresh descriptor can replace a signed URL that expired or was removed.
        is ChatSnapshotUnavailable ->
            if (error.status == 403 || error.status == 404 || retryableChatReadStatus(error.status))
                continuousRetryDelayMillis(retries, error.retryAfterSeconds)
            else null
        else -> null
    }

private fun retryableChatReadStatus(status: Int) =
    status == 408 || status == 410 || status == 429 || status in 500..599

internal fun dependencyRetryDelayMillis(error: Exception, retries: Int): Long? =
    if (error is ApiFailure.IncompatibleResponse) null else chatReadRetryDelayMillis(error, retries)

/** A post-write verification can take over without waiting for an older read's retry timer. */
internal class ChatDependencyRetry(
    private val previousFailures: Int = 0,
    private val waitBeforeReadMillis: Long? = null,
) {
    class Superseded : CancellationException("Read superseded by write verification")

    private val superseded = CompletableDeferred<Unit>()

    fun stopRetrying() {
        superseded.complete(Unit)
    }

    suspend fun <T> read(
        isCurrent: () -> Boolean,
        continuous: Boolean = false,
        onRetry: (Int) -> Unit = {},
        fetch: suspend () -> T,
    ): T {
        var retries = previousFailures.coerceAtMost(continuousRetryDelays.lastIndex)
        fun canRetry() = isCurrent() && (retries < ChatDependencyRetryCount || continuous)
        if (waitBeforeReadMillis != null) {
            awaitRetry(waitBeforeReadMillis)
            if (!isCurrent()) throw CancellationException("Read no longer current")
        }
        while (true) {
            try {
                return fetch()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                if (!canRetry()) throw error
                val wait = dependencyRetryDelayMillis(error, retries) ?: throw error
                onRetry(retries + 1)
                awaitRetry(wait)
                if (!canRetry()) throw error
                retries = (retries + 1).coerceAtMost(continuousRetryDelays.lastIndex)
            }
        }
    }

    private suspend fun awaitRetry(waitMillis: Long) {
        if (withTimeoutOrNull(waitMillis) { superseded.await() } != null || superseded.isCompleted)
            throw Superseded()
    }
}
