package ai.okou.android.connectors

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.retryBoundedRead
import ai.okou.android.isFreshMemorySnapshot
import kotlin.time.TimeMark
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

internal enum class ConnectorReadFailure {
    Network,
    Sustained,
    Unavailable,
}

internal data class ConnectorRead<T>(
    val data: T? = null,
    val failure: ConnectorReadFailure? = null,
    val confirmedAt: TimeMark? = null,
    val failureRound: Long? = null,
    // The first attempt of an active directory read, including its retry windows.
    val startedAt: TimeMark? = null,
) {
    val isConfirmed: Boolean
        get() = data != null || failure == ConnectorReadFailure.Unavailable

    fun confirmed(): ConnectorRead<T> =
        if (failure == ConnectorReadFailure.Unavailable) this
        else copy(failure = null, failureRound = null)

    fun forEntry(): ConnectorRead<T> =
        if (confirmedAt.isFreshMemorySnapshot()) confirmed()
        else ConnectorRead(startedAt = startedAt)

    fun retaining(previous: ConnectorRead<T>?): ConnectorRead<T> =
        if (data != null || previous == null || failure == ConnectorReadFailure.Unavailable) this
        else if (previous.failure == ConnectorReadFailure.Unavailable)
            previous.copy(startedAt = startedAt)
        else
            copy(
                data = previous.data,
                confirmedAt = previous.confirmedAt,
            )
}

internal suspend fun <T : Any> retryConnectorRead(
    read: suspend () -> T,
    canRead: () -> Boolean,
    onError: (Exception) -> Unit,
    publish: (ConnectorRead<T>) -> Unit,
) {
    val error =
        retryBoundedRead(canRead) {
            val value =
                try {
                    read()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    onError(error)
                    return@retryBoundedRead error.takeIf { canRead() }
                }
            currentCoroutineContext().ensureActive()
            if (canRead()) publish(ConnectorRead(value))
            null
        } ?: return
    val failure =
        when {
            error is ApiFailure.Http && error.status in 403..404 -> ConnectorReadFailure.Unavailable
            error.connectionFailed() -> ConnectorReadFailure.Network
            else -> ConnectorReadFailure.Sustained
        }
    publish(ConnectorRead(failure = failure))
}

internal fun Exception.connectionFailed(): Boolean =
    this is ApiFailure.Network && this.connectionFailed

internal fun Exception.hasUncertainResponse() =
    this is ApiFailure.Network ||
        this is ApiFailure.IncompatibleResponse ||
        this is ApiFailure.Http && (status == 408 || status >= 500)
