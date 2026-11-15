package ai.okou.android.chat

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Workspace subscription lifetime; confirmed resources own their independent trailing reads. */
class ChatUpdatesModel(
    private val service: RealtimeService?,
    private val scope: CoroutineScope,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    private val invalidate: () -> Unit,
) {
    private val mutable = MutableStateFlow(RealtimePhase.Stopped)
    val phase = mutable.asStateFlow()
    private var foreground = false
    private var closed = false
    private var generation = 0L
    private var observation: Job? = null
    private val connection = Mutex()

    fun foreground(value: Boolean) {
        if (closed || foreground == value) return
        foreground = value
        if (value) retry()
        else {
            generation++
            observation?.cancel()
            mutable.value = RealtimePhase.Stopped
        }
    }

    fun retry() {
        val source = service ?: return
        if (closed || !foreground || !authorized()) return
        val previous = observation
        previous?.cancel()
        val ticket = ++generation
        mutable.value = RealtimePhase.Connecting
        invalidate()
        observation =
            scope.launch {
                connection.withLock {
                    if (!current(ticket)) return@withLock
                    var revision = -1L
                    try {
                        source.observeRealtime { next ->
                            if (current(ticket)) {
                                mutable.value = next.phase
                                next.failure?.let(onFailure)
                                if (current(ticket) && next.revision != revision) {
                                    revision = next.revision
                                    invalidate()
                                }
                            }
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        if (current(ticket)) {
                            mutable.value = RealtimePhase.Unavailable
                            onFailure(error)
                        }
                    }
                }
            }
    }

    private fun current(ticket: Long) =
        !closed && foreground && authorized() && generation == ticket

    fun close() {
        closed = true
        generation++
        observation?.cancel()
        mutable.value = RealtimePhase.Stopped
    }
}
