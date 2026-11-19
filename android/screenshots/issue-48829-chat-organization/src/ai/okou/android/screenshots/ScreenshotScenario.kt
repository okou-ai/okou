package ai.okou.android.screenshots

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_OTHER_AGENT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun organizeChatsOnPhoneAndTablet() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val previous = app.chatService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val brief = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val links = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        val launch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        val updatedTitle = "Interview synthesis"
        val events = CopyOnWriteArrayList<Pair<Long, String>>()
        val sequence = AtomicLong(16)
        fun seed(
            thread: String,
            title: String,
            project: Boolean = false,
            agent: String = CHAT_AGENT,
            pinOrder: String? = null,
        ) {
            val seq = sequence.incrementAndGet()
            fun id(number: Long) = "00000000-0000-4000-8000-${number.toString().padStart(12, '0')}"
            val membership = if (project) ",\"projectId\":\"$CHAT_PROJECT\"" else ""
            events.add(
                seq to chatEventWire(id(seq), seq, thread, "created", membership, title, agent)
            )
            if (pinOrder != null) {
                val pinSeq = sequence.incrementAndGet()
                events.add(
                    pinSeq to
                        chatEventWire(
                            id(pinSeq),
                            pinSeq,
                            thread,
                            "pinned",
                            ",\"pinOrder\":\"$pinOrder\"",
                            title,
                            agent,
                        )
                )
            }
        }
        seed(CHAT_IN_PROJECT, "Interview notes", true, CHAT_OTHER_AGENT, "a0")
        seed(brief, "Research brief", project = true, pinOrder = "a1")
        seed(links, "Source links", project = true)
        seed(CHAT_PERSONAL, "Weekly planning", pinOrder = "a0")
        seed(launch, "Launch checklist")
        fixture.events = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0
            val tail = events.filter { it.first > since }.joinToString(",") { it.second }
            jsonResponse("""{"events":[$tail],"hasMore":false}""")
        }
        fixture.commandResponse = { request ->
            val path = request.requestUrl?.encodedPath
            when (path) {
                "/api/chat-threads/$CHAT_IN_PROJECT/rename",
                "/api/chat-threads/$brief/pin-order" -> {
                    val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                    val eventId = body.getValue("eventId").jsonPrimitive.content
                    val seq = sequence.incrementAndGet()
                    val event =
                        if (path == "/api/chat-threads/$CHAT_IN_PROJECT/rename") {
                            check(body.getValue("title").jsonPrimitive.content == updatedTitle)
                            chatEventWire(
                                eventId,
                                seq,
                                CHAT_IN_PROJECT,
                                "renamed",
                                title = updatedTitle,
                                agent = CHAT_OTHER_AGENT,
                            )
                        } else {
                            val order = body.getValue("pinOrder")
                            chatEventWire(
                                eventId,
                                seq,
                                brief,
                                "sort_touched",
                                ",\"pinOrder\":$order",
                            )
                        }
                    events.add(seq to event)
                    MockResponse().setResponseCode(204)
                }
                else -> null
            }
        }
        app.chatService = fixture.service
        var scenario: ActivityScenario<MainActivity>? = null
        var chats: Job? = null
        val failures = mutableListOf<Throwable>()
        fun selector(value: String) = By.pkg(app.packageName).text(value)
        fun text(value: String) =
            checkNotNull(device.wait(Until.findObject(selector(value)), 10_000)) {
                "Missing $value"
            }
        fun label(id: Int) = text(app.getString(id))
        val originalSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1)
        val originalDensity =
            Regex("Override density: (\\d+)")
                .find(device.executeShellCommand("wm density"))
                ?.groupValues
                ?.get(1)
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            label(R.string.chat_list_title)
            scenario.onActivity { activity ->
                chats =
                    checkNotNull(
                            ViewModelProvider(activity)[SessionModel::class.java]
                                .uiState
                                .value
                                .ready
                        )
                        .chats
                        .viewModelScope
                        .coroutineContext[Job]
            }
            text("Interview notes").longClick()
            label(R.string.chat_move_pin_down)
            label(R.string.chat_unpin)
            ScreenshotCapture.capture("phone-chat-menu.png")

            label(R.string.chat_rename).click()
            val editText = "android.widget.EditText"
            val editor = checkNotNull(device.wait(Until.findObject(By.clazz(editText)), 10_000))
            check(editor.text == "Interview notes")
            check(!label(R.string.chat_rename_confirm).isEnabled)
            editor.click()
            val focusedEditor =
                checkNotNull(
                    device.wait(Until.findObject(By.clazz(editText).focused(true)), 10_000)
                )
            focusedEditor.text = updatedTitle
            val renameSelector = selector(app.getString(R.string.chat_rename_confirm))
            val rename =
                checkNotNull(device.wait(Until.findObject(renameSelector.enabled(true)), 10_000))
            ScreenshotCapture.capture("phone-rename-chat.png")
            rename.click()
            assertTrue(device.wait(Until.gone(By.clazz(editText)), 10_000))
            text(updatedTitle)

            device.executeShellCommand("wm size 1200x900")
            device.executeShellCommand("wm density 160")
            val newChat = selector(app.getString(R.string.composer_new))
            assertTrue(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) = device.findObjects(newChat).size == 2
                    },
                    10_000,
                )
            )
            val briefSelector = selector("Research brief")
            val updatedSelector = selector(updatedTitle)
            text("Research brief").longClick()
            label(R.string.chat_move_pin_up).click()
            assertTrue(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean {
                            val moved = device.findObject(briefSelector) ?: return false
                            val peer = device.findObject(updatedSelector) ?: return false
                            return moved.visibleBounds.top < peer.visibleBounds.top
                        }
                    },
                    10_000,
                )
            )
            text(updatedTitle).click()
            val list = label(R.string.chat_list_title)
            val conversation = label(R.string.history_completed)
            check(list.visibleBounds.right < conversation.visibleBounds.left)
            ScreenshotCapture.capture("tablet-pinned-chats.png")
        } catch (failure: Throwable) {
            failures.add(failure)
            try {
                takeScreenshot().writeToTestStorage("chat-organization-failure.png")
            } catch (diagnostic: Throwable) {
                failure.addSuppressed(diagnostic)
            }
        } finally {
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { chats?.join() } } },
                    { fixture.close() },
                    { cache.restore() },
                    { app.restoreApiPreferences(preferences) },
                    { app.chatService = previous },
                    { device.executeShellCommand("wm size ${originalSize ?: "reset"}") },
                    { device.executeShellCommand("wm density ${originalDensity ?: "reset"}") },
                )) {
                try {
                    cleanup()
                } catch (failure: Throwable) {
                    failures.add(failure)
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
