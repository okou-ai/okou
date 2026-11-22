package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.rowEventTail
import ai.okou.android.testAuthenticationState
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runners.model.MultipleFailureException

class ScreenshotScenario {
    private val destinationId = "bcf53013-dfc9-4136-9de3-d3d070d8c488"
    private val sourceName = "Release planning"
    private val destinationName = "Field notes"
    private val chatName = "Prepare release notes"
    private val outsideChat = "Launch checklist"

    @Test
    fun regroupAfterAnUnconfirmedMove() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val savedAuth = auth.state.value
        val savedService = app.chatService
        val savedConnectivity = app.connectivity.value
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val chatReadRecovered = AtomicBoolean(false)
        configureFixture(fixture, chatReadRecovered)

        fun selector(value: String) = By.pkg(app.packageName).text(value)
        fun text(value: String) =
            checkNotNull(device.wait(Until.findObject(selector(value)), 10_000)) {
                "Missing $value"
            }

        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        app.chatService = fixture.service
        auth.state.value = testAuthenticationState(user = "project-regrouping-${UUID.randomUUID()}")
        try {
            val activeScenario = ActivityScenario.launch(MainActivity::class.java)
            scenario = activeScenario
            device.awaitChatList(app)
            text(sourceName)
            lateinit var chats: ChatListModel
            activeScenario.onActivity { activity ->
                chats =
                    checkNotNull(
                        ViewModelProvider(activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready
                            ?.chats
                    )
                chatJob = chats.viewModelScope.coroutineContext[Job]
            }
            text(sourceName).click()
            text(chatName).longClick()
            text(app.getString(R.string.chat_move_project)).click()
            val destination =
                checkNotNull(
                    device.wait(
                        object : Condition<UiDevice, UiObject2?> {
                            override fun apply(device: UiDevice) =
                                device.findObjects(selector(destinationName)).firstOrNull {
                                    it.visibleBounds.centerY() > device.displayHeight / 2
                                }
                        },
                        10_000,
                    )
                ) {
                    "Missing the destination in the bottom sheet"
                }
            destination.click()
            val uncertainty = app.getString(R.string.chat_row_action_failed)
            text(uncertainty)
            val dismiss =
                By.pkg(app.packageName).desc(app.getString(R.string.chat_feedback_dismiss))
            checkNotNull(device.wait(Until.findObject(dismiss), 10_000)).click()
            assertTrue(device.wait(Until.gone(selector(uncertainty)), 10_000))
            text(destinationName).click()
            text(chatName)

            val remove = app.getString(R.string.chat_project_delete)
            text(sourceName).longClick()
            text(remove).click()
            text(app.getString(R.string.chat_project_delete_title, sourceName))
            text(remove).click()
            val waiting = runBlocking {
                withTimeout(10_000) {
                    chats.uiState.first { state ->
                        state.projects.none { it.id == CHAT_PROJECT } &&
                            state.projectList.deletingId == null &&
                            state.listPhase == ChatReadPhase.Failed
                    }
                }
            }
            assertEquals(
                destinationId,
                waiting.threads.single { it.id == CHAT_IN_PROJECT }.projectId,
            )
            assertTrue(device.wait(Until.gone(selector(sourceName)), 10_000))
            val confirmation = selector(app.getString(R.string.chat_project_deleted))
            device.waitForIdle()
            assertFalse(device.hasObject(confirmation))
            text(chatName)
            ScreenshotCapture.capture("project-delete-readback-pending.png")

            chatReadRecovered.set(true)
            app.connectivity.value = false
            runBlocking { withTimeout(10_000) { chats.uiState.first { it.offline } } }
            app.connectivity.value = true
            assertTrue(device.wait(Until.hasObject(confirmation), 10_000))
            val regrouped = chats.uiState.value.threads.single { it.id == CHAT_IN_PROJECT }
            assertNull(regrouped.projectId)
            assertEquals("a1", regrouped.pinOrder)
            assertTrue(text(outsideChat).visibleBounds.top < text(chatName).visibleBounds.top)
            ScreenshotCapture.capture("project-delete-regrouped.png")
        } catch (error: Throwable) {
            failures += error
            runCatching { ScreenshotCapture.capture("project-regrouping-failure.png") }
                .exceptionOrNull()
                ?.let(error::addSuppressed)
        } finally {
            val cleanup =
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { chatJob?.join() } } },
                    { fixture.close() },
                    { cache.restore() },
                    { app.restoreApiPreferences(preferences) },
                    { app.chatService = savedService },
                    { app.connectivity.value = savedConnectivity },
                    { auth.state.value = savedAuth },
                )
            for (step in cleanup) runCatching(step).exceptionOrNull()?.let(failures::add)
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private fun configureFixture(fixture: ChatListApiFixture, chatReadRecovered: AtomicBoolean) {
        val initial =
            listOf(
                chatEventWire(title = outsideChat),
                chatEventWire(
                    id = eventId(18),
                    seq = 18,
                    thread = CHAT_IN_PROJECT,
                    title = chatName,
                    extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                ),
                chatEventWire(
                    id = eventId(19),
                    seq = 19,
                    kind = "pinned",
                    extra = ",\"pinOrder\":\"a0\"",
                ),
                chatEventWire(
                    id = eventId(20),
                    seq = 20,
                    thread = CHAT_IN_PROJECT,
                    kind = "pinned",
                    extra = ",\"pinOrder\":\"a1\"",
                ),
            )
        fixture.events = {
            jsonResponse("""{"events":[${initial.joinToString(",")}],"hasMore":false}""")
        }
        val tail = fixture.rowEventTail()
        val readEvents = fixture.events
        val deletionId = AtomicReference<String>()
        fixture.events = { request ->
            if (deletionId.get() != null && !chatReadRecovered.get())
                MockResponse().setResponseCode(503)
            else readEvents(request)
        }
        fixture.indicators = {
            jsonResponse("""{"threads":{"$CHAT_IN_PROJECT":"active"},"unreadAt":{}}""")
        }
        fixture.projects = {
            jsonResponse(
                """{"projects":[{"id":"$CHAT_PROJECT","name":"$sourceName","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","sortOrder":"a0"},{"id":"$destinationId","name":"$destinationName","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","sortOrder":"a1"}],"latestEventId":null,"latestSeqId":0}"""
            )
        }
        fixture.projectEvents = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0
            val event =
                deletionId
                    .get()
                    ?.takeIf { since < 1 }
                    ?.let { id ->
                        """{"id":"$id","seqId":1,"projectId":"$CHAT_PROJECT","kind":"deleted","name":null,"createdAt":"$CHAT_DATE"}"""
                    }
                    .orEmpty()
            jsonResponse("""{"events":[$event],"hasMore":false}""")
        }
        fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_IN_PROJECT/project" -> {
                    assertEquals("PUT", request.method)
                    MockResponse().setResponseCode(503)
                }
                "/api/projects/$CHAT_PROJECT" -> {
                    assertEquals("DELETE", request.method)
                    val id =
                        Json.parseToJsonElement(request.body.clone().readUtf8())
                            .jsonObject
                            .getValue("eventId")
                            .jsonPrimitive
                            .content
                    tail +=
                        21L to
                            chatEventWire(
                                id = eventId(21),
                                seq = 21,
                                thread = CHAT_IN_PROJECT,
                                kind = "project_updated",
                                extra = ",\"projectId\":null",
                            )
                    deletionId.set(id)
                    MockResponse().setResponseCode(204)
                }
                else -> null
            }
        }
    }

    private fun eventId(seq: Int) = "${seq.toString().padStart(8, '0')}-0000-4000-8000-000000000000"
}
