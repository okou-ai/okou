package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull

internal const val ChatDependencyRetryCount = 2
internal const val ChatDependencyRetryDelayMillis = 3_000L
internal val chatReadRetryDelays =
    listOf(
        ChatDependencyRetryDelayMillis,
        ChatDependencyRetryDelayMillis,
        6_000L,
        12_000L,
        24_000L,
        48_000L,
    )

internal fun chatReadRetryAfterMillis(error: Exception): Long? {
    val seconds =
        when (error) {
            is ApiFailure.Network,
            is ApiFailure.IncompatibleResponse -> 0L
            is ApiFailure.Http ->
                if (retryableChatReadStatus(error.status)) error.retryAfterSeconds ?: 0L else null
            // A fresh descriptor can replace a signed URL that expired or was removed.
            is ChatSnapshotUnavailable ->
                if (
                    error.status == 403 ||
                        error.status == 404 ||
                        retryableChatReadStatus(error.status)
                )
                    error.retryAfterSeconds ?: 0L
                else null
            else -> null
        }
    return seconds?.coerceIn(0, Long.MAX_VALUE / 1_000)?.times(1_000)
}

private fun retryableChatReadStatus(status: Int) =
    status == 408 || status == 410 || status == 429 || status in 500..599

internal fun dependencyRetryAfterMillis(error: Exception): Long? =
    if (error is ApiFailure.IncompatibleResponse) null else chatReadRetryAfterMillis(error)

/** A post-write verification can take over without waiting for an older read's retry timer. */
internal class ChatDependencyRetry {
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
        var retries = 0
        fun canRetry() = isCurrent() && (retries < ChatDependencyRetryCount || continuous)
        while (true) {
            try {
                return fetch()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                if (!canRetry()) throw error
                val retryAfter = dependencyRetryAfterMillis(error) ?: throw error
                val wait = maxOf(chatReadRetryDelays[retries], retryAfter)
                onRetry(retries + 1)
                if (
                    withTimeoutOrNull(wait) { superseded.await() } != null || superseded.isCompleted
                )
                    throw Superseded()
                if (!canRetry()) throw error
                retries = (retries + 1).coerceAtMost(chatReadRetryDelays.lastIndex)
            }
        }
    }
}
