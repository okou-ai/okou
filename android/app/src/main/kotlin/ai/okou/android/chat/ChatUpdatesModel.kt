package ai.okou.android.chat

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
    private val output: RunOutputModel? = null,
    private val foregroundChanged: (Boolean) -> Unit = {},
    private val invalidate: (ChatChanges) -> Unit,
) {
    private val mutable = MutableStateFlow(RealtimePhase.Stopped)
    val phase = mutable.asStateFlow()
    private var foreground = false
    private var closed = false
    private var generation = 0L
    private var observation: Job? = null
    private val connection = Mutex()
    private val noOutput = MutableStateFlow<RunOutputTarget?>(null)

    fun foreground(value: Boolean) {
        if (closed || foreground == value) return
        foreground = value
        foregroundChanged(value)
        if (value) startObservation()
        else {
            generation++
            observation?.cancel()
            publishPhase(RealtimePhase.Stopped)
        }
    }

    private fun startObservation() {
        val source = service ?: return
        if (!authorized()) return
        val ticket = ++generation
        publishPhase(RealtimePhase.Connecting)
        invalidate(ChatChanges(resync = true))
        observation = scope.launch {
            connection.withLock { observeWhileCurrent(source, ticket) }
        }
    }

    private suspend fun observeWhileCurrent(source: RealtimeService, ticket: Long) {
        var retryIndex = 0
        while (current(ticket)) {
            try {
                source.observeRealtime(
                    output?.target ?: noOutput,
                    { target, signal -> if (current(ticket)) output?.receive(target, signal) },
                ) { next ->
                    if (!current(ticket)) return@observeRealtime
                    if (next.phase == RealtimePhase.Connected) retryIndex = 0
                    publishPhase(next.phase)
                    next.failure?.let(onFailure)
                    if (current(ticket) && next.changes != ChatChanges()) invalidate(next.changes)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (!current(ticket)) return
                publishPhase(RealtimePhase.Unavailable)
                onFailure(error)
                val retryAfter = dependencyRetryAfterMillis(error) ?: return
                // An active SDK observation handles its own reconnections. Start over only after
                // it has ended and released its subscriptions and token request.
                delay(maxOf(chatReadRetryDelays[retryIndex], retryAfter))
                retryIndex = (retryIndex + 1).coerceAtMost(chatReadRetryDelays.lastIndex)
            }
        }
    }

    private fun publishPhase(phase: RealtimePhase) {
        mutable.value = phase
        output?.transport(phase)
    }

    private fun current(ticket: Long) =
        !closed && foreground && authorized() && generation == ticket

    fun close() {
        closed = true
        generation++
        observation?.cancel()
        foregroundChanged(false)
        mutable.value = RealtimePhase.Stopped
    }
}
