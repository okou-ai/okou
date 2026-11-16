package ai.okou.android

import ai.okou.android.api.generated.SessionOutputDelta
import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ChatChanges
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.RealtimePhase
import ai.okou.android.chat.RealtimeSnapshot
import ai.okou.android.chat.RunOutputSignal
import android.view.KeyEvent
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import java.util.regex.Pattern
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class NativeRealtimeTest {
    @Test
    fun foregroundReconnectRefreshesCanonicalConversationWithoutLosingNativeDraft() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val authentication = app.authentication as TestAuthentication
        val oldAuth = authentication.state.value
        val oldChats = app.chatService
        val oldRealtime = app.realtimeService
        val oldJournal = app.journalStore
        val oldPreferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val directory =
            Files.createTempDirectory(app.cacheDir.toPath(), "realtime-native-").toFile()
        val journal = ComposerJournalStore(app, directory)
        val fixture = ChatListApiFixture()
        val external = TestRealtimeService()
        external.snapshot.value = RealtimeSnapshot(RealtimePhase.Connecting)
        app.chatService = fixture.service
        app.realtimeService = external
        app.journalStore = journal
        authentication.state.value = testAuthenticationState()
        val device = UiDevice.getInstance(instrumentation)
        var scenario: ActivityScenario<MainActivity>? = null
        var composerJob: Job? = null
        var chatJob: Job? = null
        var chats: ChatListModel? = null
        val failures = mutableListOf<Throwable>()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            // Markdown paragraphs add line terminators after the unchanged visible body.
            fun label(value: String) =
                By.pkg(app.packageName).text(Pattern.compile(Pattern.quote(value) + "\\n*"))
            fun text(value: String) =
                checkNotNull(device.wait(Until.findObject(label(value)), 10_000))
            fun reveal(value: String) {
                val target = label(value)
                if (!device.hasObject(target)) {
                    val container =
                        checkNotNull(
                            device.wait(
                                Until.findObject(By.pkg(app.packageName).scrollable(true)),
                                10_000,
                            )
                        )
                    val visible =
                        object : Condition<UiObject2, Boolean> {
                            // Compose exposes virtual descendants through the current window.
                            override fun apply(unused: UiObject2) = device.hasObject(target)
                        }
                    if (!container.scrollUntil(Direction.UP, visible)) {
                        container.scrollUntil(Direction.DOWN, visible)
                    }
                }
                text(value)
            }
            fun condition(check: () -> Boolean) =
                assertTrue(
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice) = check()
                        },
                        10_000,
                    )
                )
            fun ime(visible: Boolean) = condition {
                var shown = false
                checkNotNull(scenario).onActivity {
                    shown =
                        ViewCompat.getRootWindowInsets(it.window.decorView)
                            ?.isVisible(WindowInsetsCompat.Type.ime()) == true
                }
                shown == visible
            }
            text(app.getString(R.string.chat_list_title))
            text(app.getString(R.string.realtime_connecting))
            scenario.onActivity {
                val ready =
                    checkNotNull(
                        ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready
                    )
                composerJob = ready.composer.viewModelScope.coroutineContext[Job]
                chatJob = ready.chats.viewModelScope.coroutineContext[Job]
                chats = ready.chats
            }
            condition { chats?.uiState?.value?.threads?.any { it.id == CHAT_PERSONAL } == true }
            reveal("Personal chat")
            text("Personal chat").click()
            assertNotNull(
                device.wait(
                    Until.findObject(By.pkg(app.packageName).textContains("Native history")),
                    10_000,
                )
            )
            val editor =
                checkNotNull(
                    device.wait(
                        Until.findObject(
                            By.pkg(app.packageName).clazz("android.widget.EditText").enabled(true)
                        ),
                        10_000,
                    )
                )
            editor.click()
            editor.text = "Keep this draft"
            ime(true)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            ime(false)
            external.snapshot.value =
                external.snapshot.value.copy(phase = RealtimePhase.Unavailable)
            text(app.getString(R.string.realtime_unavailable))

            val sequence = AtomicLong(41)
            val title = AtomicReference("Changed on another client")
            fixture.events = { request ->
                val seq = sequence.get()
                val fresh =
                    (request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0) < seq
                jsonResponse(
                    """{"events":[${if (fresh) chatEventWire(seq = seq, id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa${if (seq == 41L) "41" else "52"}", kind = "renamed", title = title.get()) else ""}],"hasMore":false}"""
                )
            }
            val extraId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
            fixture.historyRows = { request ->
                val cursor = request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0
                val thread = checkNotNull(request.requestUrl).pathSegments[2]
                val original =
                    listOf(
                        17L to
                            historyEventWire(
                                "input",
                                17,
                                thread,
                                "input.prompt",
                                """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Hello history"}]}}""",
                            ),
                        23L to historyEventWire("output", 23, thread),
                        37L to
                            historyEventWire(
                                HISTORY_LAST_EVENT,
                                37,
                                thread,
                                "run.completed",
                                "null",
                            ),
                        41L to
                            historyEventWire(
                                extraId,
                                41,
                                thread,
                                "input.prompt",
                                """{"userMessage":{"version":1,"parts":[{"type":"text","text":"External input"}]}}""",
                                run = null,
                            ),
                    )
                val rows = original.filter { it.first > cursor }.joinToString(",") { it.second }
                jsonResponse(
                    """{"rows":[$rows],"cursor":{"lastEventId":"$extraId","lastSeqId":41},"hasMore":false}"""
                )
            }
            external.snapshot.value =
                RealtimeSnapshot(RealtimePhase.Connected, 1, changes = ChatChanges(resync = true))
            text("Changed on another client")
            // The new confirmed message can be below the current viewport; use native scrolling.
            reveal("External input")
            assertTrue(
                checkNotNull(
                        device.findObject(By.pkg(app.packageName).clazz("android.widget.EditText"))
                    )
                    .text
                    .contains("Keep this draft")
            )

            reveal("Changed on another client")
            val opened = external.opened.get()
            scenario.moveToState(Lifecycle.State.CREATED)
            condition { external.closed.get() == opened }
            title.set("Changed while backgrounded")
            sequence.set(52)
            scenario.moveToState(Lifecycle.State.RESUMED)
            condition { external.opened.get() == opened + 1 }
            text("Changed while backgrounded")
            // Confirmed active-run ownership enables transient output on the same observation.
            val activeRun = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            val activeInput = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
            val streamedEvent = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
            val savedOutput = AtomicReference(false)
            fixture.historyRows = { request ->
                val cursor = request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0
                val saved = savedOutput.get()
                val rows =
                    buildList {
                            if (cursor < 53)
                                add(
                                    historyEventWire(
                                        activeInput,
                                        53,
                                        CHAT_PERSONAL,
                                        "input.prompt",
                                        """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Start live output"}]}}""",
                                        activeRun,
                                    )
                                )
                            if (saved && cursor < 54)
                                add(
                                    historyEventWire(
                                        streamedEvent,
                                        54,
                                        CHAT_PERSONAL,
                                        "output.message",
                                        """{"content":"Saved native answer"}""",
                                        activeRun,
                                    )
                                )
                        }
                        .joinToString(",")
                val lastId = if (saved) streamedEvent else activeInput
                val lastSeq = if (saved) 54 else 53
                jsonResponse(
                    """{"rows":[$rows],"cursor":{"lastEventId":"$lastId","lastSeqId":$lastSeq},"hasMore":false}"""
                )
            }
            external.invalidate()
            condition { external.target.value?.runId == activeRun }
            fun chunk(index: Long, value: String) =
                RunOutputSignal.Delta(
                    SessionOutputDelta(
                        CHAT_PERSONAL,
                        activeRun,
                        streamedEvent,
                        "native-output",
                        CHAT_DATE,
                        index,
                        value,
                    )
                )
            external.output(chunk(0, "Live native "))
            external.output(chunk(0, "duplicate"))
            external.output(chunk(1, "answer"))
            condition {
                chats
                    ?.history
                    ?.output
                    ?.state
                    ?.value
                    ?.messages
                    ?.singleOrNull()
                    ?.blocks
                    ?.singleOrNull()
                    ?.text == "Live native answer"
            }
            reveal("Live native answer")
            external.output(chunk(3, "missing chunk"))
            external.snapshot.value =
                external.snapshot.value.copy(phase = RealtimePhase.Unavailable)
            condition {
                chats?.history?.output?.state?.value?.phase ==
                    ai.okou.android.chat.RunOutputPhase.CatchingUp
            }
            text("Live native answer")
            external.snapshot.value =
                external.snapshot.value.copy(
                    phase = RealtimePhase.Connected,
                    revision = external.snapshot.value.revision + 1,
                )
            savedOutput.set(true)
            external.invalidate()
            reveal("Saved native answer")
            assertFalse(device.hasObject(label("Live native answer")))
            condition { chats?.history?.output?.state?.value?.messages?.isEmpty() == true }
            assertTrue(
                checkNotNull(
                        device.findObject(By.pkg(app.packageName).clazz("android.widget.EditText"))
                    )
                    .text
                    .contains("Keep this draft")
            )
        } catch (error: Throwable) {
            failures += error
            try {
                takeScreenshot().writeToTestStorage("native-realtime-failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    {
                        runBlocking {
                            withTimeout(10_000) {
                                composerJob?.join()
                                chatJob?.join()
                            }
                        }
                    },
                    { runBlocking { journal.close() } },
                    { fixture.close() },
                    { cache.restore() },
                    { app.restoreApiPreferences(oldPreferences) },
                    {
                        app.chatService = oldChats
                        app.realtimeService = oldRealtime
                        app.journalStore = oldJournal
                    },
                    { authentication.state.value = oldAuth },
                    { check(directory.deleteRecursively()) },
                )) try {
                cleanup()
            } catch (error: Throwable) {
                failures += error
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
