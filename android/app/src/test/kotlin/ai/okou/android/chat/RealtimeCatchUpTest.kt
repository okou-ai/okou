package ai.okou.android.chat

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatListApiFixture
import ai.okou.android.TestOkouApplication
import ai.okou.android.TestRealtimeService
import ai.okou.android.chatEventWire
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.test.core.app.ApplicationProvider
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class RealtimeCatchUpTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun heldHistoryAndFailedIndicatorsDoNotBlockListOrDropTrailingCanonicalChange() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        val cache =
            ChatCacheStore(
                ApplicationProvider.getApplicationContext(),
                temporary.newFolder(),
                dispatcher,
            )
        val held = CountDownLatch(1)
        try {
            ChatListApiFixture().use { api ->
                val external = TestRealtimeService()
                val model =
                    ViewModelProvider(
                        store,
                        viewModelFactory {
                            initializer {
                                ChatListModel(
                                    api.service,
                                    cache,
                                    api.identity,
                                    { true },
                                    {},
                                    dispatcher,
                                    external,
                                )
                            }
                        },
                    )[ChatListModel::class.java]
                model.refresh()
                val personal =
                    model.uiState
                        .first { it.listPhase == ChatReadPhase.Ready }
                        .threads
                        .single { it.id == CHAT_PERSONAL }
                model.history.open(personal)
                model.history.uiState.first { it.phase == HistoryPhase.Ready }
                api.beforeHistoryResponse = { request ->
                    if (request.requestUrl?.pathSegments?.last() == "event-rows") held.await()
                }
                api.indicators = { MockResponse().setResponseCode(503).setBody("unavailable") }
                api.events = { request ->
                    val fresh =
                        (request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0) < 30
                    jsonResponse(
                        """{"events":[${if (fresh) chatEventWire(seq = 30, id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind = "renamed", title = "External title") else ""}],"hasMore":false}"""
                    )
                }
                model.updates.foreground(true)
                model.uiState.first {
                    it.threads.any { row -> row.title == "External title" } &&
                        it.indicatorsPhase == ChatReadPhase.Failed
                }
                assertEquals(HistoryPhase.Loading, model.history.uiState.value.phase)
                api.events = { request ->
                    val fresh =
                        request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull()?.let {
                            it < 41
                        } != false
                    jsonResponse(
                        """{"events":[${if (fresh) chatEventWire(seq = 41, id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", kind = "renamed", title = "Trailing title") else ""}],"hasMore":false}"""
                    )
                }
                val added = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
                api.historyRows = { request ->
                    val fresh =
                        request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull()?.let {
                            it < 41
                        } != false
                    val input =
                        historyEventWire(
                            added,
                            41,
                            CHAT_PERSONAL,
                            "input.prompt",
                            """{"userMessage":{"version":1,"parts":[{"type":"text","text":"External input"}]}}""",
                            run = null,
                        )
                    jsonResponse(
                        """{"rows":[${if (fresh) input else ""}],"cursor":{"lastEventId":"$added","lastSeqId":41},"hasMore":false}"""
                    )
                }
                repeat(50) { external.invalidate() }
                model.uiState.first { it.threads.any { row -> row.title == "Trailing title" } }
                assertEquals(HistoryPhase.Loading, model.history.uiState.value.phase)
                held.countDown()
                val history =
                    model.history.uiState.first {
                        it.phase == HistoryPhase.Ready &&
                            it.transcript?.messages?.any { row ->
                                row.blocks.any { block -> block.text == "External input" }
                            } == true
                    }
                assertEquals(1, history.transcript!!.messages.count { it.id == added })
                assertEquals(ChatReadPhase.Failed, model.uiState.value.indicatorsPhase)
            }
        } finally {
            held.countDown()
            store.clear()
            cache.close()
            Dispatchers.resetMain()
        }
    }
}
