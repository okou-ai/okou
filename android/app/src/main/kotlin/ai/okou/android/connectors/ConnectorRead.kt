package ai.okou.android.connectors

import ai.okou.android.api.ApiFailure
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.UnknownHostException
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeMark
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

internal enum class ConnectorReadFailure {
    Network,
    Sustained,
    Unavailable,
}

internal data class ConnectorRead<T>(
    val data: T? = null,
    val failure: ConnectorReadFailure? = null,
    val expiresAt: TimeMark? = null,
) {
    val isConfirmed: Boolean
        get() = data != null || failure == ConnectorReadFailure.Unavailable

    fun confirmed(): ConnectorRead<T> =
        if (failure == ConnectorReadFailure.Unavailable) this else copy(failure = null)

    fun forEntry(): ConnectorRead<T> =
        if (expiresAt?.hasPassedNow() == false) confirmed() else ConnectorRead()

    fun retaining(previous: ConnectorRead<T>?): ConnectorRead<T> =
        if (data != null || previous == null || failure == ConnectorReadFailure.Unavailable) this
        else if (previous.failure == ConnectorReadFailure.Unavailable) previous
        else
            copy(
                data = previous.data,
                expiresAt = previous.expiresAt,
            )
}

private const val READ_RETRY_LIMIT = 2

internal suspend fun <T : Any> retryConnectorRead(
    read: suspend () -> T,
    canRead: () -> Boolean,
    onError: (Exception) -> Unit,
    publish: (ConnectorRead<T>) -> Unit,
) {
    for (attempt in 0..READ_RETRY_LIMIT) {
        if (!canRead()) return
        val value =
            try {
                read()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                onError(error)
                if (!canRead()) return
                val retryable =
                    error !is ApiFailure.Http ||
                        error.status !in 400..499 ||
                        error.status == 408 ||
                        error.status == 429
                if (retryable && attempt < READ_RETRY_LIMIT) {
                    delay(3.seconds)
                    continue
                }
                val failure =
                    when {
                        error is ApiFailure.Http && error.status in 403..404 ->
                            ConnectorReadFailure.Unavailable
                        error.connectionFailed() -> ConnectorReadFailure.Network
                        else -> ConnectorReadFailure.Sustained
                    }
                publish(ConnectorRead(failure = failure))
                return
            }
        if (canRead()) publish(ConnectorRead(value))
        return
    }
}

// Canonical calls do not retry connections or follow redirects. These failures happen
// before sending the request. A read timeout or a lost response does not prove that.
internal fun Exception.connectionFailed(): Boolean =
    this is ApiFailure.Network &&
        (cause is UnknownHostException ||
            cause is ConnectException ||
            cause is NoRouteToHostException)

internal fun Exception.hasUncertainResponse() =
    this is ApiFailure.Network ||
        this is ApiFailure.IncompatibleResponse ||
        this is ApiFailure.Http && (status == 408 || status >= 500)
