package ai.okou.android

import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.chat.ChatCacheStore
import ai.okou.android.chat.ChatCheckpoint
import ai.okou.android.chat.ChatCursor
import ai.okou.android.chat.HistoryCheckpoint
import ai.okou.android.chat.HistoryCursor
import ai.okou.android.chat.HistoryEvent
import ai.okou.android.chat.cursor
import ai.okou.android.chat.projectHistory
import ai.okou.android.chat.replayChats
import android.content.Context
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.util.UUID
import kotlin.math.ceil
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json

private fun measurementId(number: Int) =
    "${number.toString().padStart(8, '0')}-0000-4000-8000-000000000000"

private data class PublicationTimes(val write: Long, val read: Long, val project: Long) {
    val total: Long
        get() = write + read + project
}

private fun report(label: String, samples: List<PublicationTimes>) {
    fun distribution(values: List<Long>): String {
        val sorted = values.sorted()
        fun percentile(p: Double) = sorted[ceil(p * sorted.size).toInt() - 1] / 1_000
        return "${percentile(0.5)}/${percentile(0.9)}"
    }
    Log.i(
        "OkouRoomMeasurement",
        "$label n=${samples.size} us-p50/p90 write=${distribution(samples.map { it.write })} " +
            "read=${distribution(samples.map { it.read })} " +
            "project=${distribution(samples.map { it.project })} " +
            "total=${distribution(samples.map { it.total })}",
    )
}

internal fun measureHistoryPublication(context: Context) = runBlocking {
    val root = File(context.cacheDir, "history-measure-${UUID.randomUUID()}")
    val store = ChatCacheStore(context, root)
    val identity = WorkspaceIdentity("https://fixture.test/", "user", "session", "org", "member")
    try {
        store
            .open(identity) { true }
            .use { lease ->
                for (size in listOf(24, 4096)) {
                    val threadId = measurementId(size)
                    val payload =
                        """{"content":"${"Representative response content. ".repeat(12)}"}"""
                    val rows =
                        (1..size + 40).map { seq ->
                            HistoryEvent.decode(
                                historyEventWire(
                                    id = measurementId(seq),
                                    seq = seq.toLong(),
                                    thread = threadId,
                                    payload = payload,
                                    run = measurementId(seq + 30_000),
                                )
                            )
                        }
                    fun checkpoint(count: Int): HistoryCheckpoint {
                        val tail = rows[count - 1]
                        return HistoryCheckpoint(
                            threadId,
                            rows.subList(0, count),
                            HistoryCursor(tail.id, tail.seqId),
                        )
                    }
                    lease.saveHistory(checkpoint(size), 100)
                    val before = mutableListOf<PublicationTimes>()
                    val after = mutableListOf<PublicationTimes>()
                    for (round in 0 until 40) {
                        val next = checkpoint(size + round + 1)
                        val useMatch = round % 2 == 1
                        val start = SystemClock.elapsedRealtimeNanos()
                        lease.saveHistory(next, (101 + round).toLong())
                        val written = SystemClock.elapsedRealtimeNanos()
                        val cached =
                            checkNotNull(
                                if (useMatch) lease.loadHistoryAfterSync(next)
                                else lease.loadHistory(threadId)
                            )
                        val read = SystemClock.elapsedRealtimeNanos()
                        projectHistory(cached.checkpoint)
                        val projected = SystemClock.elapsedRealtimeNanos()
                        check(cached.checkpoint.cursor == next.cursor)
                        if (round >= 8) {
                            val samples = if (useMatch) after else before
                            samples +=
                                PublicationTimes(written - start, read - written, projected - read)
                        }
                    }
                    report("history $size full-read", before)
                    report("history $size cursor-match", after)
                }

                val events =
                    Json { ignoreUnknownKeys = true }
                        .decodeFromString<ChatEvents>(
                            """{"events":[${(1..320).joinToString(",") { seq ->
                    chatEventWire(id = measurementId(seq), seq = seq.toLong(), thread = measurementId(seq + 50_000))
                }}],"hasMore":false}"""
                        )
                        .events
                fun listCheckpoint(count: Int): ChatCheckpoint =
                    ChatCheckpoint(
                        ChatArchive(emptyList()),
                        ChatCursor(),
                        events.subList(0, count),
                        events[count - 1].cursor(),
                    )
                check(lease.save(listCheckpoint(300), 100))
                val list =
                    (1..20)
                        .map { round ->
                            val next = listCheckpoint(300 + round)
                            val start = SystemClock.elapsedRealtimeNanos()
                            check(replayChats(next).size == 300 + round)
                            val projected = SystemClock.elapsedRealtimeNanos()
                            check(lease.save(next, (100 + round).toLong()))
                            val written = SystemClock.elapsedRealtimeNanos()
                            PublicationTimes(written - projected, 0, projected - start)
                        }
                        .drop(4)
                report("chat-list 300 append", list)
            }
    } finally {
        store.close()
        root.deleteRecursively()
    }
    Unit
}
