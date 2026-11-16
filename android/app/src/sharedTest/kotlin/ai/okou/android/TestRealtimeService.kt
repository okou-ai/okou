package ai.okou.android

import ai.okou.android.chat.ChatChanges
import ai.okou.android.chat.RealtimePhase
import ai.okou.android.chat.RealtimeService
import ai.okou.android.chat.RealtimeSnapshot
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.flow.MutableStateFlow

/** Controlled external SDK observations; production HTTP/cache/state owners remain installed. */
class TestRealtimeService : RealtimeService {
    val snapshot = MutableStateFlow(RealtimeSnapshot(RealtimePhase.Connected))
    val opened = AtomicInteger()
    val closed = AtomicInteger()

    override suspend fun observeRealtime(observe: suspend (RealtimeSnapshot) -> Unit): Nothing {
        opened.incrementAndGet()
        try {
            var revision = -1L
            snapshot.collect {
                val next = if (it.revision == revision) it.copy(changes = ChatChanges()) else it
                revision = it.revision
                observe(next)
            }
        } finally {
            closed.incrementAndGet()
        }
    }

    fun invalidate(changes: ChatChanges = ChatChanges(resync = true)) {
        snapshot.value =
            snapshot.value.copy(revision = snapshot.value.revision + 1, changes = changes)
    }
}
