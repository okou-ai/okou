package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
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
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.rowEventTail
import ai.okou.android.testAuthenticationState
import android.view.KeyEvent
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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runners.model.MultipleFailureException

class ScreenshotScenario {
    @Test
    fun organizeChatsFromTheNativeList() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousService = app.chatService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val deletions = AtomicInteger()
        val heldMove = configureFixture(fixture, deletions)

        fun selector(value: String) = By.pkg(app.packageName).text(value)
        fun text(value: String) =
            checkNotNull(device.wait(Until.findObject(selector(value)), 10_000)) {
                "Missing $value"
            }

        fun gone(value: String) =
            assertTrue("Still showing $value", device.wait(Until.gone(selector(value)), 10_000))
        fun capture(name: String) {
            device.waitForIdle()
            ScreenshotCapture.capture(name)
        }

        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        app.chatService = fixture.service
        auth.state.value =
            testAuthenticationState(user = "project-organization-${UUID.randomUUID()}")
        try {
            val activeScenario = ActivityScenario.launch(MainActivity::class.java)
            scenario = activeScenario
            device.awaitChatList(app)
            text("Release planning")
            val move = app.getString(R.string.chat_move_project)
            text("Launch checklist").click()
            val more = By.pkg(app.packageName).desc(app.getString(R.string.chat_actions))
            checkNotNull(device.wait(Until.findObject(more), 10_000)).click()
            val settings = text(app.getString(R.string.settings)).visibleBounds.top
            val conversationMove = text(move).visibleBounds.top
            val deleteChat = text(app.getString(R.string.chat_delete)).visibleBounds.top
            assertTrue(settings < conversationMove && conversationMove < deleteChat)
            capture("conversation-move-menu.png")
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            gone(move)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            device.awaitChatList(app)

            text("Launch checklist").longClick()
            text(move)
            capture("move-menu.png")
            text(move).click()
            // In the phone layout, the list headers and the sheet choices can share labels.
            val destination =
                checkNotNull(
                    device.wait(
                        object : Condition<UiDevice, UiObject2?> {
                            override fun apply(device: UiDevice) =
                                device.findObjects(selector("Release planning")).firstOrNull {
                                    it.visibleBounds.centerY() > device.displayHeight / 2
                                }
                        },
                        10_000,
                    )
                ) {
                    "Missing the destination in the bottom sheet"
                }
            capture("move-destination.png")
            destination.click()
            text(app.getString(R.string.chat_project_moved_named, "Release planning"))
            gone("Launch checklist")
            text("Release planning").click()
            assertTrue(
                text("Launch checklist").visibleBounds.top <
                    text("Prepare release notes").visibleBounds.top
            )
            capture("moved-chat.png")

            val remove = app.getString(R.string.chat_project_delete)
            val confirmation = app.getString(R.string.chat_project_delete_title, "Release planning")
            text("Release planning").longClick()
            text(remove).click()
            text(confirmation)
            capture("project-delete.png")
            text(app.getString(R.string.chat_rename_cancel)).click()
            gone(confirmation)
            assertEquals(0, deletions.get())
            text("Release planning").longClick()
            text(remove).click()
            text(confirmation)
            text(remove).click()
            gone("Release planning")
            text(app.getString(R.string.chat_project_deleted))
            val first = text("Launch checklist").visibleBounds.top
            val middle = text("Prepare release notes").visibleBounds.top
            val last = text("Weekly summary").visibleBounds.top
            assertTrue(first < middle && middle < last)
            assertEquals(1, deletions.get())
            capture("regrouped-chats.png")

            text("Launch checklist").longClick()
            text(app.getString(R.string.chat_move_project_named, "Field notes")).click()
            val unconfirmedMove = app.getString(R.string.chat_row_action_failed)
            text(unconfirmedMove)
            gone("Launch checklist")

            text("Field notes").longClick()
            text(remove).click()
            text(app.getString(R.string.chat_project_delete_title, "Field notes"))
            text(remove).click()
            gone("Field notes")
            gone(unconfirmedMove)
            text(app.getString(R.string.chat_project_deleted))
            assertTrue(
                text("Launch checklist").visibleBounds.top <
                    text("Prepare release notes").visibleBounds.top
            )
            assertEquals(2, deletions.get())
            capture("move-reconciled-after-delete.png")

            gone(app.getString(R.string.chat_project_deleted))
            heldMove.publishDestination()
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
                chats.refresh()
            }
            val target = "Planning archive"
            text(target)
            text("Launch checklist").longClick()
            text(app.getString(R.string.chat_move_project_named, target)).click()
            assertTrue(heldMove.accepted.await(10, TimeUnit.SECONDS))
            heldMove.deleteDestination()
            activeScenario.onActivity { chats.refresh() }
            gone(target)
            text("Launch checklist")
            assertTrue(CHAT_PERSONAL in chats.uiState.value.pendingRowActions)
            heldMove.respond.countDown()
            runBlocking {
                withTimeout(10_000) {
                    chats.uiState.first { CHAT_PERSONAL !in it.pendingRowActions }
                }
            }
            device.waitForIdle()
            assertFalse(
                device.hasObject(selector(app.getString(R.string.chat_project_moved_named, target)))
            )
            capture("late-move-after-deletion.png")
        } catch (error: Throwable) {
            failures += error
            runCatching { ScreenshotCapture.capture("project-organization-failure.png") }
                .exceptionOrNull()
                ?.let(error::addSuppressed)
        } finally {
            heldMove.respond.countDown()
            val cleanup =
                listOf<() -> Unit>(
                    {
                        scenario?.onActivity { activity ->
                            chatJob =
                                ViewModelProvider(activity)[SessionModel::class.java]
                                    .uiState
                                    .value
                                    .ready
                                    ?.chats
                                    ?.viewModelScope
                                    ?.coroutineContext
                                    ?.get(Job)
                        }
                    },
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { chatJob?.join() } } },
                    { fixture.close() },
                    { cache.restore() },
                    { app.restoreApiPreferences(preferences) },
                    { app.chatService = previousService },
                    { auth.state.value = previousAuth },
                )
            for (step in cleanup) runCatching(step).exceptionOrNull()?.let(failures::add)
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private class HeldMove(val publishDestination: () -> Unit, val deleteDestination: () -> Unit) {
        val accepted = CountDownLatch(1)
        val respond = CountDownLatch(1)
    }

    private fun configureFixture(fixture: ChatListApiFixture, deletions: AtomicInteger): HeldMove {
        val otherProject = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        val lateProject = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        val summary = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val initial =
            listOf(
                chatEventWire(title = "Launch checklist"),
                chatEventWire(
                    id = eventId(18),
                    seq = 18,
                    thread = CHAT_IN_PROJECT,
                    title = "Prepare release notes",
                    extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                ),
                chatEventWire(
                    id = eventId(19),
                    seq = 19,
                    thread = summary,
                    title = "Weekly summary",
                ),
                chatEventWire(
                    id = eventId(20),
                    seq = 20,
                    kind = "pinned",
                    extra = ",\"pinOrder\":\"a0\"",
                ),
                chatEventWire(
                    id = eventId(21),
                    seq = 21,
                    thread = CHAT_IN_PROJECT,
                    kind = "pinned",
                    extra = ",\"pinOrder\":\"a1\"",
                ),
                chatEventWire(
                    id = eventId(22),
                    seq = 22,
                    thread = summary,
                    kind = "pinned",
                    extra = ",\"pinOrder\":\"a2\"",
                ),
            )
        fixture.events = {
            jsonResponse("""{"events":[${initial.joinToString(",")}],"hasMore":false}""")
        }
        val tail = fixture.rowEventTail()
        fixture.indicators = {
            jsonResponse("""{"threads":{"$CHAT_IN_PROJECT":"active"},"unreadAt":{}}""")
        }
        fixture.projects = {
            jsonResponse(
                """{"projects":[{"id":"$CHAT_PROJECT","name":"Release planning","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","sortOrder":"a0"},{"id":"$otherProject","name":"Field notes","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","sortOrder":"a1"}],"latestEventId":null,"latestSeqId":0}"""
            )
        }
        val projectEvents = CopyOnWriteArrayList<Pair<Long, String>>()
        fixture.projectEvents = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0
            val events = projectEvents.filter { it.first > since }.joinToString(",") { it.second }
            jsonResponse("""{"events":[$events],"hasMore":false}""")
        }
        val heldMove =
            HeldMove(
                publishDestination = {
                    projectEvents +=
                        3L to
                            """{"id":"${eventId(30)}","seqId":3,"projectId":"$lateProject","kind":"created","name":"Planning archive","sortOrder":"a0","createdAt":"$CHAT_DATE"}"""
                },
                deleteDestination = {
                    tail +=
                        27L to
                            chatEventWire(
                                id = eventId(27),
                                seq = 27,
                                kind = "project_updated",
                                extra = ",\"projectId\":null",
                            )
                    projectEvents +=
                        4L to
                            """{"id":"${eventId(31)}","seqId":4,"projectId":"$lateProject","kind":"deleted","name":null,"createdAt":"$CHAT_DATE"}"""
                },
            )
        fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/project" -> {
                    assertEquals("PUT", request.method)
                    val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                    val id = body.getValue("eventId").jsonPrimitive.content
                    assertEquals(7, UUID.fromString(id).version())
                    val target = body.getValue("projectId").jsonPrimitive.content
                    if (target == otherProject) {
                        MockResponse().setResponseCode(503)
                    } else {
                        assertTrue(target == CHAT_PROJECT || target == lateProject)
                        val sequence = if (target == CHAT_PROJECT) 23L else 26L
                        tail +=
                            sequence to
                                chatEventWire(
                                    id = id,
                                    seq = sequence,
                                    kind = "project_updated",
                                    extra = ",\"projectId\":\"$target\"",
                                )
                        if (target == lateProject) {
                            heldMove.accepted.countDown()
                            check(heldMove.respond.await(30, TimeUnit.SECONDS))
                        }
                        jsonResponse("""{"threadId":"$CHAT_PERSONAL","projectId":"$target"}""")
                    }
                }
                "/api/projects/$CHAT_PROJECT",
                "/api/projects/$otherProject" -> {
                    assertEquals("DELETE", request.method)
                    val project = checkNotNull(request.requestUrl).pathSegments.last()
                    val id =
                        Json.parseToJsonElement(request.body.clone().readUtf8())
                            .jsonObject
                            .getValue("eventId")
                            .jsonPrimitive
                            .content
                    assertEquals(7, UUID.fromString(id).version())
                    if (project == CHAT_PROJECT) {
                        tail +=
                            24L to
                                chatEventWire(
                                    id = eventId(24),
                                    seq = 24,
                                    kind = "project_updated",
                                    extra = ",\"projectId\":null",
                                )
                        tail +=
                            25L to
                                chatEventWire(
                                    id = eventId(25),
                                    seq = 25,
                                    thread = CHAT_IN_PROJECT,
                                    kind = "project_updated",
                                    extra = ",\"projectId\":null",
                                )
                    }
                    val seq = deletions.incrementAndGet().toLong()
                    projectEvents +=
                        seq to
                            """{"id":"$id","seqId":$seq,"projectId":"$project","kind":"deleted","name":null,"createdAt":"$CHAT_DATE"}"""
                    MockResponse().setResponseCode(204)
                }
                else -> null
            }
        }
        return heldMove
    }

    private fun eventId(seq: Int) = "${seq.toString().padStart(8, '0')}-0000-4000-8000-000000000000"
}
