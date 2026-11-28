package ai.okou.android.screenshots

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
import ai.okou.android.testAuthenticationState
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
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
    fun ambiguousRenamesRestoreSaveAndRetainTheNativeFields() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldService = app.chatService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val started = List(2) { CountDownLatch(1) }
        val release = List(2) { CountDownLatch(1) }
        val writes = AtomicInteger()
        fixture.commandResponse = { request ->
            val index =
                when (request.requestUrl?.encodedPath) {
                    "/api/chat-threads/$CHAT_PERSONAL/rename" -> 0
                    "/api/projects/$CHAT_PROJECT" -> if (request.method == "PATCH") 1 else null
                    else -> null
                }
            if (index == null) null
            else {
                check(writes.getAndIncrement() == index)
                val expected = if (index == 0) "Design notes" else "Field notes"
                check(expected in request.body.clone().readUtf8())
                started[index].countDown()
                check(release[index].await(20, TimeUnit.SECONDS))
                MockResponse().setResponseCode(503)
            }
        }
        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun find(value: String) =
            checkNotNull(device.wait(Until.findObject(text(value)), 10_000)) { "Missing $value" }

        val save = app.getString(R.string.chat_project_rename_save)
        val saving = app.getString(R.string.settings_saving)
        val cancel = app.getString(R.string.chat_rename_cancel)
        val failure = app.getString(R.string.chat_rename_save_failed)
        fun verifyRename(
            index: Int,
            oldName: String,
            menu: String,
            draft: String,
            pendingImage: String,
            failureImage: String,
        ) {
            find(oldName).longClick()
            find(menu).click()
            val field = By.pkg(app.packageName).clazz("android.widget.EditText")
            checkNotNull(device.wait(Until.findObject(field), 10_000)).setText(draft)
            val button = checkNotNull(device.wait(Until.findObject(text(save).enabled(true)), 10_000))
            val readyBounds = button.visibleBounds
            button.click()
            check(started[index].await(10, TimeUnit.SECONDS))
            val pending = find(saving)
            val pendingBounds = pending.visibleBounds
            check(!pending.isEnabled)
            check(abs(pendingBounds.centerX() - readyBounds.centerX()) <= 1)
            check(abs(pendingBounds.centerY() - readyBounds.centerY()) <= 1)
            check(!find(cancel).isEnabled)
            find(draft)
            ScreenshotCapture.capture(pendingImage)

            release[index].countDown()
            val support = find(failure)
            val restored = find(save)
            check(restored.isEnabled && restored.visibleBounds == readyBounds)
            check(support.visibleBounds.bottom < restored.visibleBounds.top)
            find(draft)
            ScreenshotCapture.capture(failureImage)
            find(cancel).click()
            check(device.wait(Until.gone(text(failure)), 10_000))
            find(oldName)
        }
        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        try {
            app.chatService = fixture.service
            auth.state.value = testAuthenticationState(user = "rename-feedback-${UUID.randomUUID()}")
            val launched = ActivityScenario.launch(MainActivity::class.java)
            scenario = launched
            device.awaitChatList(app)
            find("Research")
            lateinit var session: SessionModel
            launched.onActivity { activity ->
                session = ViewModelProvider(activity)[SessionModel::class.java]
            }
            val chats = runBlocking {
                withTimeout(10_000) { checkNotNull(session.uiState.first { it.ready != null }.ready).chats }
            }
            chatJob = chats.viewModelScope.coroutineContext[Job]
            verifyRename(0, "Personal chat", "Rename chat", "Design notes", "01-chat-saving.png", "02-chat-rename-failed.png")
            verifyRename(1, "Research", "Rename", "Field notes", "03-project-saving.png", "04-project-rename-failed.png")
            check(writes.get() == 2)
        } catch (error: Throwable) {
            failures += error
            for (diagnostic in listOf<() -> Unit>(
                { ScreenshotCapture.capture("failure-diagnostic.png") },
                { TestStorage().openOutputFile("failure-hierarchy.xml").use(device::dumpWindowHierarchy) },
            )) {
                try {
                    diagnostic()
                } catch (failure: Throwable) {
                    error.addSuppressed(failure)
                }
            }
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
