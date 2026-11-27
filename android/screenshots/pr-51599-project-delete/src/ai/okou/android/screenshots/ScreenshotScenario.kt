package ai.okou.android.screenshots

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
import ai.okou.android.testAuthenticationState
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun unknownProjectDeletionUsesTheVisibleConfirmationOrList() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldService = app.chatService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val eventIds = CopyOnWriteArrayList<String>()
        val started = List(2) { CountDownLatch(1) }
        val release = List(2) { CountDownLatch(1) }
        fixture.commandResponse = { request ->
            if (request.method == "DELETE" && request.requestUrl?.encodedPath == "/api/projects/$CHAT_PROJECT") {
                val attempt = eventIds.size
                val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                eventIds += body.getValue("eventId").jsonPrimitive.content
                started[attempt].countDown()
                check(release[attempt].await(20, TimeUnit.SECONDS))
                MockResponse().setResponseCode(503)
            } else null
        }
        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun find(value: String) = checkNotNull(device.wait(Until.findObject(text(value)), 10_000)) {
            "Missing $value"
        }
        fun button(label: String) =
            checkNotNull(generateSequence(find(label)) { it.parent }.firstOrNull {
                it.className == "android.widget.Button"
            }) { "Missing Button ancestor for $label" }
        fun waitForGone(value: String) {
            check(device.wait(Until.gone(text(value)), 10_000)) { "$value is still visible" }
        }
        val project = "Research"
        val projectChat = "Project chat"
        val delete = app.getString(R.string.chat_project_delete)
        val title = app.getString(R.string.chat_project_delete_title)
        val pendingButton = app.getString(R.string.chat_delete_pending)
        val pendingRow = app.getString(R.string.chat_project_delete_pending)
        val failure = app.getString(R.string.chat_project_delete_rejected)
        val cancel = app.getString(R.string.settings_cancel)
        val newChat = app.getString(R.string.composer_new)
        fun openConfirmation() {
            find(project).longClick()
            find(delete).click()
            find(title)
        }
        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        try {
            app.chatService = fixture.service
            auth.state.value = testAuthenticationState(user = "project-delete-${UUID.randomUUID()}")
            val launched = ActivityScenario.launch(MainActivity::class.java)
            scenario = launched
            device.awaitChatList(app)
            find(project).click()
            find(projectChat)
            lateinit var session: SessionModel
            launched.onActivity { activity ->
                session = ViewModelProvider(activity)[SessionModel::class.java]
            }
            val chats = runBlocking {
                withTimeout(10_000) { checkNotNull(session.uiState.first { it.ready != null }.ready).chats }
            }
            chatJob = chats.viewModelScope.coroutineContext[Job]

            openConfirmation()
            val confirm = button(delete)
            val confirmBounds = confirm.visibleBounds
            confirm.click()
            check(started[0].await(10, TimeUnit.SECONDS))
            val pending = button(pendingButton)
            check(!pending.isEnabled) { "The submitting action is enabled" }
            check(pending.visibleBounds == confirmBounds) {
                "Submitting action bounds ${pending.visibleBounds} differ from $confirmBounds"
            }
            release[0].countDown()
            val dialogError = find(failure).visibleBounds
            val restored = button(delete)
            check(restored.isEnabled && restored.visibleBounds == confirmBounds) {
                "The action did not restore: enabled=${restored.isEnabled}, bounds=${restored.visibleBounds}"
            }
            check(dialogError.bottom < confirmBounds.top) {
                "Error bounds $dialogError overlap the action at $confirmBounds"
            }
            ScreenshotCapture.capture("01-delete-dialog-failure.png")

            restored.click()
            check(started[1].await(10, TimeUnit.SECONDS))
            find(pendingButton)
            button(cancel).click()
            waitForGone(title)
            val pendingBounds = find(pendingRow).visibleBounds
            val projectBounds = find(project).visibleBounds
            check(pendingBounds.top >= projectBounds.bottom) {
                "Pending status $pendingBounds is not below the Project at $projectBounds"
            }
            find(projectChat)
            ScreenshotCapture.capture("02-delete-pending-row.png")
            release[1].countDown()

            val listError = find(failure).visibleBounds
            val newChatBounds = find(newChat).visibleBounds
            check(listError.bottom < newChatBounds.top) {
                "List feedback $listError is not above New chat at $newChatBounds"
            }
            waitForGone(pendingRow)
            find(project)
            find(projectChat)
            check(!device.hasObject(text(app.getString(R.string.retry))))
            check(eventIds.size == 2 && eventIds.distinct().size == 2)
            ScreenshotCapture.capture("03-delete-list-failure.png")
            waitForGone(failure)
        } catch (error: Throwable) {
            failures += error
        } finally {
            release.forEach { it.countDown() }
            for (cleanup in listOf<() -> Unit>(
                { scenario?.close() },
                { runBlocking { withTimeout(10_000) { chatJob?.join() } } },
                { fixture.close() },
                { cache.restore() },
                { app.restoreApiPreferences(preferences) },
                { app.chatService = oldService },
                { auth.state.value = oldAuth },
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
