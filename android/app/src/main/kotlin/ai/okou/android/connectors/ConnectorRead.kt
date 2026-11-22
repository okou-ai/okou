package ai.okou.android.connectors

import ai.okou.android.api.ApiFailure
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal enum class ConnectorReadFailure {
    Recent,
    Sustained,
    Unavailable,
}

internal data class ConnectorRead<T>(
    val data: T? = null,
    val failure: ConnectorReadFailure? = null,
) {
    fun retaining(previous: ConnectorRead<T>?): ConnectorRead<T> =
        if (data != null || previous == null || failure == ConnectorReadFailure.Unavailable) this
        else
            copy(
                data = previous.data,
                failure =
                    if (previous.failure == ConnectorReadFailure.Sustained) previous.failure
                    else failure,
            )
}

private val readRetryDelays = listOf(5.seconds, 10.seconds, 20.seconds, 40.seconds, 60.seconds)

internal suspend fun <T : Any> retryConnectorRead(
    read: suspend () -> T,
    canRead: () -> Boolean,
    onError: (Exception) -> Unit,
    publish: (ConnectorRead<T>) -> Unit,
) = coroutineScope {
    var failures = 0
    var failureWindowElapsed = false
    var failureWindow: Job? = null
    try {
        while (canRead()) {
            val value =
                try {
                    read()
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    onError(error)
                    if (!canRead()) return@coroutineScope
                    failures = (failures + 1).coerceAtMost(readRetryDelays.size)
                    val failure =
                        when {
                            error is ApiFailure.Http && error.status in 403..404 ->
                                ConnectorReadFailure.Unavailable
                            failures >= 3 && failureWindowElapsed -> ConnectorReadFailure.Sustained
                            else -> ConnectorReadFailure.Recent
                        }
                    publish(ConnectorRead(failure = failure))
                    if (
                        error is ApiFailure.Http &&
                            error.status in 400..499 &&
                            error.status != 408 &&
                            error.status != 429
                    )
                        return@coroutineScope
                    if (failures == 1) {
                        failureWindow = launch {
                            delay(30.seconds)
                            failureWindowElapsed = true
                            if (failures >= 3 && canRead())
                                publish(ConnectorRead(failure = ConnectorReadFailure.Sustained))
                        }
                    }
                    delay(readRetryDelays[failures - 1])
                    continue
                }
            if (canRead()) publish(ConnectorRead(value))
            return@coroutineScope
        }
    } finally {
        failureWindow?.cancel()
    }
}
