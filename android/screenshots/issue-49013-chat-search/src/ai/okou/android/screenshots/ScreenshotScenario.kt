package ai.okou.android.screenshots

import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_OTHER_AGENT
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
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
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun searchOnPhoneAndWideWindow() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val oldService = app.chatService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val oldSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1)
        val oldDensity =
            Regex("Override density: (\\d+)")
                .find(device.executeShellCommand("wm density"))
                ?.groupValues
                ?.get(1)
        val project =
            chatEventWire(
                id = "77777777-7777-4777-8777-777777777777",
                seq = 23,
                thread = CHAT_IN_PROJECT,
                extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                title = "Launch research notes",
                agent = CHAT_OTHER_AGENT,
            )
        val archived =
            chatEventWire(
                id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                seq = 24,
                thread = CHAT_IN_PROJECT,
                kind = "archived",
                agent = CHAT_OTHER_AGENT,
            )
        fixture.events = { request ->
            if (request.requestUrl?.queryParameter("sinceSeqId") != null) {
                jsonResponse("""{"events":[],"hasMore":false}""")
            } else {
                jsonResponse(
                    """{"events":[${chatEventWire(title = "Launch checklist")},$project,$archived],"hasMore":false}"""
                )
            }
        }
        app.chatService = fixture.service
        app.restoreApiPreferences(emptyMap())

        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        val failures = mutableListOf<Throwable>()
        fun text(label: String) = By.pkg(app.packageName).text(label)
        fun description(label: String) = By.pkg(app.packageName).desc(label)
        fun find(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing $selector" }
        fun query() = find(By.pkg(app.packageName).clazz("android.widget.EditText"))
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            find(text("Launch checklist"))
            scenario.onActivity { activity ->
                chatJob =
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
            find(description("Search")).click()
            find(text("Recent chats"))
            query().text = "launch"
            find(text("Research · Archived"))
            ScreenshotCapture.capture("01-phone-search.png")
            find(text("Launch research notes")).click()
            check(device.wait(Until.gone(By.pkg(app.packageName).desc("Search chats")), 10_000))
            find(description("Back")).click()
            find(text("Research · Archived"))
            check(query().text == "launch")
            ScreenshotCapture.capture("02-phone-restored-search.png")
            find(description("Back")).click()

            device.executeShellCommand("wm size 1200x900")
            device.executeShellCommand("wm density 160")
            check(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean {
                            var isWide = false
                            checkNotNull(scenario).onActivity { activity ->
                                val configuration = activity.resources.configuration
                                isWide =
                                    configuration.screenWidthDp >= 840 &&
                                        configuration.screenHeightDp >= 480
                            }
                            return isWide
                        }
                    },
                    10_000,
                )
            )
            find(description("Search")).click()
            query().text = "research"
            find(text("Research · Archived"))
            ScreenshotCapture.capture("03-wide-search.png")
            find(text("Launch research notes")).click()
            find(description("Search"))
            find(text("Launch research notes"))
            find(text("Launch checklist"))
            ScreenshotCapture.capture("04-wide-result.png")
        } catch (failure: Throwable) {
            failures += failure
            runCatching { ScreenshotCapture.capture("failure.png") }
                .onFailure(failure::addSuppressed)
        } finally {
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { chatJob?.join() } } },
                    { fixture.close() },
                    { cache.restore() },
                    { app.restoreApiPreferences(preferences) },
                    { app.chatService = oldService },
                    { device.executeShellCommand("wm size ${oldSize ?: "reset"}") },
                    { device.executeShellCommand("wm density ${oldDensity ?: "reset"}") },
                )) runCatching(cleanup).onFailure(failures::add)
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
