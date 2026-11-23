package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ConversationHistoryModel
import ai.okou.android.chat.HistoryPhase
import ai.okou.android.testAuthenticationState
import android.graphics.Color
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun captureAutomaticHistoryRecovery() {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldService = app.chatService
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val previousAnimationScale = device.executeShellCommand("settings get global animator_duration_scale").trim()
        val fail = AtomicBoolean(true)
        var owner: Job? = null
        ChatListApiFixture().use { fixture ->
            val rows = fixture.historyRows
            fixture.historyRows = { request ->
                if (fail.get()) MockResponse().setResponseCode(503) else rows(request)
            }
            fixture.historyCatchUp = { MockResponse().setResponseCode(503) }
            app.chatService = fixture.service
            auth.state.value = testAuthenticationState(user = "history-capture-${UUID.randomUUID()}")
            try {
                device.executeShellCommand("settings put global animator_duration_scale 1")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    device.awaitChatList(app)
                    checkNotNull(device.wait(Until.findObject(By.text("Personal chat")), 15_000)).click()
                    lateinit var history: ConversationHistoryModel
                    scenario.onActivity { activity ->
                        val ready = checkNotNull(ViewModelProvider(activity)[SessionModel::class.java].uiState.value.ready)
                        history = ready.chats.history
                        owner = ready.chats.viewModelScope.coroutineContext[Job]
                    }
                    val skeleton = By.desc(app.getString(R.string.history_loading))
                    val bar = By.desc(app.getString(R.string.history_syncing))
                    val message = By.text("Hello history")
                    awaitState("first read failed with the skeleton visible") {
                        history.uiState.value.consecutiveReadFailures > 0 && device.hasObject(skeleton)
                    }
                    check(!device.hasObject(By.text(app.getString(R.string.chat_list_first_load_failed))))
                    ScreenshotCapture.capture("01-first-read-retrying.png")
                    fail.set(false)
                    awaitState("cold history recovered") {
                        history.uiState.value.phase == HistoryPhase.Ready && device.hasObject(message)
                    }
                    fail.set(true)
                    scenario.onActivity { history.refresh() }
                    awaitState("third refresh failure with the fixed progress bar") {
                        history.uiState.value.consecutiveReadFailures >= 3 && device.hasObject(bar)
                    }
                    check(device.hasObject(message))
                    awaitState("animated primary segment") {
                        val bounds = device.findObject(bar)?.visibleBounds ?: return@awaitState false
                        val screenshot = instrumentation.uiAutomation.takeScreenshot() ?: return@awaitState false
                        try {
                            val pixel = screenshot.getPixel(bounds.centerX(), bounds.centerY())
                            Color.red(pixel) >= 230 && Color.green(pixel) in 102..210 && Color.blue(pixel) < 80
                        } finally {
                            screenshot.recycle()
                        }
                    }
                    ScreenshotCapture.capture("02-cached-refresh-retrying.png")
                    fail.set(false)
                    awaitState("cached refresh recovered") {
                        history.uiState.value.phase == HistoryPhase.Ready &&
                            !device.hasObject(bar) && device.hasObject(message)
                    }
                    ScreenshotCapture.capture("03-history-recovered.png")
                }
            } finally {
                try {
                    runBlocking { withTimeout(10_000) { owner?.join() } }
                    cache.restore()
                } finally {
                    app.chatService = oldService
                    auth.state.value = oldAuth
                    val scale = previousAnimationScale.toFloatOrNull()
                    if (scale == null) device.executeShellCommand("settings delete global animator_duration_scale")
                    else device.executeShellCommand("settings put global animator_duration_scale $scale")
                }
            }
        }
    }

    private fun awaitState(label: String, condition: () -> Boolean) {
        val check = object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice) = condition()
        }
        kotlin.check(device.wait(check, 20_000)) { "Did not observe $label" }
    }
}
