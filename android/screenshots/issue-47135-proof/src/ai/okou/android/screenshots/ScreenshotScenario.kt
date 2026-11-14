package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiScrollable
import androidx.test.uiautomator.UiSelector
import androidx.test.uiautomator.Until
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun nativeFeatureAcceptance() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val previous = app.chatService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        app.chatService = fixture.service
        var activity: ActivityScenario<MainActivity>? = null
        var owner: Job? = null
        val failures = mutableListOf<Throwable>()
        try {
            activity = ActivityScenario.launch(MainActivity::class.java)
            fun text(value: String) =
                checkNotNull(
                    device.wait(Until.findObject(By.pkg(app.packageName).text(value)), 10_000)
                )
            fun click(value: String) {
                text(value)
                device.findObject(UiSelector().packageName(app.packageName).text(value)).click()
            }
            fun reveal(value: String) {
                if (!device.hasObject(By.pkg(app.packageName).text(value)))
                    assertTrue(
                        UiScrollable(UiSelector().packageName(app.packageName).scrollable(true))
                            .setAsVerticalList()
                            .scrollTextIntoView(value)
                    )
                text(value)
            }
            text(app.getString(R.string.chat_status_observed))
            assertTrue(
                device.wait(Until.gone(By.text(app.getString(R.string.chat_loading))), 10_000)
            )
            assertTrue(
                device.wait(
                    Until.gone(By.text(app.getString(R.string.chat_metadata_loading))),
                    10_000,
                )
            )
            activity.onActivity {
                owner =
                    checkNotNull(
                            ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready
                        )
                        .chats
                        .viewModelScope
                        .coroutineContext[Job]
            }
            reveal("Project chat")
            device.waitForIdle()
            ScreenshotCapture.capture("01-list.png")
            click("Project chat")
            text(app.getString(R.string.history_completed))
            assertTrue(
                UiScrollable(UiSelector().packageName(app.packageName).scrollable(true))
                    .scrollIntoView(UiSelector().textContains("Native history"))
            )
            assertNotNull(device.wait(Until.findObject(By.textContains("Native history")), 10_000))
            assertTrue(device.wait(Until.gone(By.textContains("**Native history**")), 10_000))
            device.waitForIdle()
            ScreenshotCapture.capture("02-history.png")
            click(app.getString(R.string.history_sidebar))
            reveal("Research")
            device.waitForIdle()
            ScreenshotCapture.capture("03-sidebar.png")
            click("Project chat")
            assertTrue(
                device.wait(Until.gone(By.text(app.getString(R.string.chat_list_title))), 10_000)
            )
            device.findObject(UiSelector().description(app.getString(R.string.settings))).click()
            text(app.getString(R.string.appearance))
            device.waitForIdle()
            ScreenshotCapture.capture("04-settings.png")
        } catch (error: Throwable) {
            failures += error
        } finally {
            for (cleanup in
                listOf<() -> Unit>(
                    { activity?.close() },
                    { runBlocking { withTimeout(10_000) { owner?.join() } } },
                    { fixture.close() },
                    { cache.restore() },
                    { app.restoreApiPreferences(preferences) },
                    { app.chatService = previous },
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
