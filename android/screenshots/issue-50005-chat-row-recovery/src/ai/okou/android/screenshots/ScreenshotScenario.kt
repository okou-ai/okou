package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatRowAction
import ai.okou.android.chat.isUnread
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.rowEventTail
import ai.okou.android.testAuthenticationState
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.IOException
import java.net.ConnectException
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesFilteredReorderingAndRecovery() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val savedAuth = auth.state.value
        val savedService = app.chatService
        val savedOnline = app.connectivity.value
        val savedPreferences = app.snapshotApiPreferences()
        val savedCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val middle = "22222222-2222-4222-8222-222222222222"
        val last = "33333333-3333-4333-8333-333333333333"
        val firstTitle = "Client onboarding"
        val middleTitle = "Release notes"
        val lastTitle = "Roadmap review"

        fun eventId(seq: Long) = "00000000-0000-4000-8000-${seq.toString().padStart(12, '0')}"
        fun seed(seq: Long, thread: String, title: String, rank: String) =
            listOf(
                chatEventWire(eventId(seq), seq, thread, title = title),
                chatEventWire(
                    eventId(seq + 1),
                    seq + 1,
                    thread,
                    "pinned",
                    ",\"pinOrder\":\"$rank\"",
                ),
            )
        val initial =
            seed(17, CHAT_PERSONAL, firstTitle, "a0") +
                seed(19, middle, middleTitle, "a1") +
                seed(21, last, lastTitle, "a2")
        fixture.events = {
            jsonResponse("""{"events":[${initial.joinToString(",")}],"hasMore":false}""")
        }
        fixture.indicators = {
            jsonResponse(
                """{"threads":{"$CHAT_PERSONAL":"unread","$last":"unread"},"unreadAt":{"$CHAT_PERSONAL":"$CHAT_DATE","$last":"$CHAT_DATE"}}"""
            )
        }
        fixture.historyMarkRead = { MockResponse().setResponseCode(503) }
        val events = fixture.rowEventTail()
        val pinTargets = CopyOnWriteArrayList<String>()
        fixture.commandResponse = { request ->
            val path = request.requestUrl?.pathSegments.orEmpty()
            if (request.method == "POST" && path.lastOrNull() == "pin-order") {
                val thread = path[2]
                pinTargets += thread
                val command = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                events +=
                    23L to
                        chatEventWire(
                            command.getValue("eventId").jsonPrimitive.content,
                            23,
                            thread,
                            "sort_touched",
                            ",\"pinOrder\":${command.getValue("pinOrder")}",
                        )
                MockResponse().setResponseCode(204)
            } else if (
                request.method == "POST" &&
                    path == listOf("api", "chat-threads", CHAT_PERSONAL, "mark-unread")
            ) {
                jsonResponse("""{"lastReadAt":null}""")
            } else null
        }
        val retryIds = CopyOnWriteArrayList<String>()
        val unknownIds = CopyOnWriteArrayList<String>()
        val releaseRetry = CompletableDeferred<Unit>()
        app.chatService =
            object : WorkspaceSession by fixture.service {
                override suspend fun setArchived(
                    threadId: String,
                    archived: Boolean,
                    eventId: String,
                ) {
                    if (threadId == last) {
                        retryIds += eventId
                        if (retryIds.size == 2) releaseRetry.await()
                        throw ApiFailure.Network(ConnectException("Fixture connection failed"))
                    }
                    assertEquals(CHAT_PERSONAL, threadId)
                    unknownIds += eventId
                    throw ApiFailure.Network(IOException("Fixture response lost"))
                }

                override fun close() = Unit
            }
        app.connectivity.value = true
        auth.state.value = testAuthenticationState(user = "row-recovery-${UUID.randomUUID()}")
        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        lateinit var chats: ChatListModel
        fun selector(value: String) = By.pkg(app.packageName).text(value)
        fun element(target: BySelector) =
            checkNotNull(device.wait(Until.findObject(target), 10_000)) { "Missing $target" }
        fun text(value: String) = element(selector(value))
        fun text(id: Int) = text(app.getString(id))
        fun awaitState(message: String, ready: () -> Boolean) {
            assertTrue(
                message,
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean = ready()
                    },
                    10_000,
                ),
            )
        }
        fun above(first: String, second: String) =
            text(first).visibleBounds.top < text(second).visibleBounds.top
        val filter = By.pkg(app.packageName).desc(app.getString(R.string.chat_filter))

        try {
            val activityScenario = ActivityScenario.launch(MainActivity::class.java)
            scenario = activityScenario
            device.awaitChatList(app)
            activityScenario.onActivity { activity ->
                val ready =
                    checkNotNull(
                        ViewModelProvider(activity)[SessionModel::class.java].uiState.value.ready
                    )
                chats = ready.chats
                chatJob = chats.viewModelScope.coroutineContext[Job]
            }
            text(firstTitle)
            text(middleTitle)
            text(lastTitle)
            element(filter).click()
            text(R.string.chat_unread).click()
            text(firstTitle)
            text(lastTitle)
            assertFalse(device.hasObject(selector(middleTitle)))
            assertTrue(above(firstTitle, lastTitle))
            text(lastTitle).longClick()
            val up = text(R.string.chat_move_pin_up)
            ScreenshotCapture.capture("filtered-pin-menu.png")
            up.click()
            awaitState("Expected the visible pin order to change") { above(lastTitle, firstTitle) }
            assertFalse(device.hasObject(selector(middleTitle)))
            ScreenshotCapture.capture("filtered-pin-reordered.png")
            element(filter).click()
            text(R.string.chat_inbox).click()
            text(middleTitle)
            assertTrue(above(lastTitle, firstTitle))
            assertTrue(above(firstTitle, middleTitle))
            assertEquals(listOf(last), pinTargets)

            text(lastTitle).longClick()
            text(R.string.chat_archive).click()
            awaitState("Expected one retry while the optimistic archive is visible") {
                retryIds.size == 2
            }
            assertFalse(device.hasObject(selector(lastTitle)))
            assertFalse(device.hasObject(selector(app.getString(R.string.chat_undo))))
            ScreenshotCapture.capture("archive-retry-pending.png")
            releaseRetry.complete(Unit)
            val connectionFailure =
                app.getString(
                    R.string.chat_row_action_offline_named,
                    app.getString(R.string.chat_archive),
                )
            text(connectionFailure)
            assertTrue(above(lastTitle, firstTitle))
            assertEquals(3, retryIds.size)
            assertEquals(1, retryIds.distinct().size)
            ScreenshotCapture.capture("archive-rollback.png")
            assertTrue(device.wait(Until.gone(selector(connectionFailure)), 10_000))

            text(firstTitle).longClick()
            text(R.string.chat_archive).click()
            text(R.string.chat_row_action_failed)
            assertFalse(device.hasObject(selector(firstTitle)))
            ScreenshotCapture.capture("archive-awaiting-confirmation.png")
            events += 24L to chatEventWire(eventId(24), 24, CHAT_PERSONAL, "archived")
            text(R.string.chat_refresh).click()
            awaitState("Expected the external archive to reach the confirmed list") {
                chats.uiState.value.confirmedThreads.any { it.id == CHAT_PERSONAL && it.archived }
            }
            assertTrue(
                device.wait(
                    Until.gone(selector(app.getString(R.string.chat_row_action_failed))),
                    10_000,
                )
            )
            element(filter).click()
            text(R.string.chat_archived).click()
            text(firstTitle)
            assertEquals(1, unknownIds.size)
            assertFalse(device.hasObject(selector(app.getString(R.string.chat_undo))))
            ScreenshotCapture.capture("archive-confirmed-on-another-device.png")

            text(firstTitle).longClick()
            text(R.string.chat_mark_read).click()
            text(R.string.chat_row_action_failed)
            assertEquals(ChatRowAction.MarkRead, chats.uiState.value.failedRowAction?.action)
            assertFalse(chats.uiState.value.isUnread(CHAT_PERSONAL))
            ScreenshotCapture.capture("read-awaiting-confirmation.png")

            text(firstTitle).longClick()
            text(R.string.chat_mark_unread).click()
            awaitState("Expected the confirmed unread state to replace the earlier read") {
                val state = chats.uiState.value
                state.isUnread(CHAT_PERSONAL) &&
                    state.readIntents.isEmpty() &&
                    state.failedRowAction == null
            }
            assertTrue(
                device.wait(
                    Until.gone(selector(app.getString(R.string.chat_row_action_failed))),
                    10_000,
                )
            )
            ScreenshotCapture.capture("unread-after-confirmation.png")
        } catch (error: Throwable) {
            failures += error
            try {
                ScreenshotCapture.capture("failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            releaseRetry.complete(Unit)
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { chatJob?.join() } } },
                    { fixture.close() },
                    { savedCache.restore() },
                    { app.restoreApiPreferences(savedPreferences) },
                    { app.chatService = savedService },
                    { app.connectivity.value = savedOnline },
                    { auth.state.value = savedAuth },
                )) {
                try {
                    cleanup()
                } catch (error: Throwable) {
                    failures += error
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
