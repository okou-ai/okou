package ai.okou.android

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
            snapshot.collect { observe(it) }
        } finally {
            closed.incrementAndGet()
        }
    }

    fun invalidate() {
        snapshot.value = snapshot.value.copy(revision = snapshot.value.revision + 1)
    }
}
