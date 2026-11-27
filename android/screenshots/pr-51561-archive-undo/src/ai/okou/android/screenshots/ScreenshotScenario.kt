package ai.okou.android.screenshots

import ai.okou.android.CHAT_PERSONAL
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
import ai.okou.android.chat.ChatRowAction
import ai.okou.android.rowEvent
import ai.okou.android.rowEventTail
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun archiveReceiptOffersUndoWhileListReadFailsAndLateSyncRestoresTheRow() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldService = app.chatService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val events = fixture.rowEventTail()
        val eventsPage = fixture.events
        val listReadUnavailable = AtomicBoolean()
        val archiveReadFailures = AtomicInteger()
        val archivedEvent = AtomicReference<String>()
        fixture.events = { request ->
            if (listReadUnavailable.get()) {
                archiveReadFailures.incrementAndGet()
                MockResponse().setResponseCode(503)
            } else eventsPage(request)
        }
        val inverse = AtomicReference<String>()
        val inverseRequests = AtomicInteger()
        val submitted = CountDownLatch(1)
        val release = CountDownLatch(1)
        fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                    archivedEvent.set(request.rowEvent(24, CHAT_PERSONAL, "archived"))
                    listReadUnavailable.set(true)
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/unarchive" -> {
                    inverseRequests.incrementAndGet()
                    inverse.set(request.rowEvent(25, CHAT_PERSONAL, "unarchived"))
                    submitted.countDown()
                    check(release.await(15, TimeUnit.SECONDS))
                    MockResponse().setResponseCode(503)
                }
                else -> null
            }
        }
        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun find(value: String) = checkNotNull(device.wait(Until.findObject(text(value)), 10_000)) {
            "Missing $value"
        }
        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        val personal = "Personal chat"
        val undo = app.getString(R.string.chat_undo)
        val failure = app.getString(R.string.chat_undo_failed)
        try {
            app.chatService = fixture.service
            auth.state.value = testAuthenticationState(user = "rollback-${UUID.randomUUID()}")
            val launched = ActivityScenario.launch(MainActivity::class.java)
            scenario = launched
            device.awaitChatList(app)
            find(personal)
            val projectBounds = find("Research").visibleBounds
            lateinit var session: SessionModel
            launched.onActivity { activity ->
                session = ViewModelProvider(activity)[SessionModel::class.java]
            }
            val chats: ChatListModel = runBlocking {
                withTimeout(10_000) { checkNotNull(session.uiState.first { it.ready != null }.ready).chats }
            }
            launched.onActivity { activity ->
                chatJob = chats.viewModelScope.coroutineContext[Job]
                check(chats.performRowAction(CHAT_PERSONAL, ChatRowAction.Archive))
            }
            find(undo)
            check(device.wait(Until.gone(text(personal)), 10_000))
            check(archiveReadFailures.get() > 0)
            ScreenshotCapture.capture("01-archive-undo.png")

            events += 24L to checkNotNull(archivedEvent.get())
            listReadUnavailable.set(false)
            find(undo).click()
            check(submitted.await(10, TimeUnit.SECONDS))
            find(personal)
            release.countDown()
            val failureBounds = find(failure).visibleBounds
            check(device.wait(Until.gone(text(personal)), 10_000))
            check(!device.hasObject(text(undo)))
            check(projectBounds == find("Research").visibleBounds)
            check(failureBounds.bottom < find(app.getString(R.string.composer_new)).visibleBounds.top)
            ScreenshotCapture.capture("02-undo-failed.png")

            events += 25L to checkNotNull(inverse.get())
            launched.onActivity { chats.refreshList() }
            find(personal)
            check(!device.hasObject(text(undo)))
            check(inverseRequests.get() == 1)
            check(device.wait(Until.gone(text(failure)), 10_000))
            ScreenshotCapture.capture("03-late-confirmation.png")
        } catch (error: Throwable) {
            failures += error
        } finally {
            release.countDown()
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
