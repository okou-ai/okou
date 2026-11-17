package ai.okou.android

import ai.okou.android.chat.ChatChanges
import ai.okou.android.chat.RealtimePhase
import ai.okou.android.chat.RealtimeService
import ai.okou.android.chat.RealtimeSnapshot
import ai.okou.android.chat.RunOutputSignal
import ai.okou.android.chat.RunOutputTarget
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** Controlled external SDK observations; production HTTP/cache/state owners remain installed. */
class TestRealtimeService : RealtimeService {
    val snapshot = MutableStateFlow(RealtimeSnapshot(RealtimePhase.Connected))
    val opened = AtomicInteger()
    val closed = AtomicInteger()
    val target = MutableStateFlow<RunOutputTarget?>(null)
    private val chunks = Channel<Pair<RunOutputTarget, RunOutputSignal>>(64)

    override suspend fun observeRealtime(
        target: StateFlow<RunOutputTarget?>,
        output: suspend (RunOutputTarget, RunOutputSignal) -> Unit,
        observe: suspend (RealtimeSnapshot) -> Unit,
    ): Nothing {
        opened.incrementAndGet()
        try {
            coroutineScope {
                launch { target.collect { this@TestRealtimeService.target.value = it } }
                launch { for ((owner, signal) in chunks) output(owner, signal) }
                var revision = -1L
                snapshot.collect {
                    val next = if (it.revision == revision) it.copy(changes = ChatChanges()) else it
                    revision = it.revision
                    observe(next)
                }
            }
        } finally {
            this.target.value = null
            closed.incrementAndGet()
        }
    }

    fun output(signal: RunOutputSignal) {
        check(chunks.trySend(checkNotNull(target.value) to signal).isSuccess)
    }

    fun invalidate(changes: ChatChanges = ChatChanges(resync = true)) {
        snapshot.value =
            snapshot.value.copy(revision = snapshot.value.revision + 1, changes = changes)
    }
}
