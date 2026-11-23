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
import ai.okou.android.chatListRegion
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import android.graphics.Color
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
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.SocketPolicy
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
        val previousAnimationScale =
            device.executeShellCommand("settings get global animator_duration_scale").trim()
        val interruptArchive = AtomicBoolean(true)
        val failRows = AtomicBoolean(false)
        var owner: Job? = null
        ChatListApiFixture().use { fixture ->
            val archiveBody =
                historyEventWire(
                    "input",
                    17,
                    type = "input.prompt",
                    payload = """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Hello history"}]}}""",
                ) + "\n"
            fixture.historySnapshot = {
                val url = fixture.server.url("/history-archive")
                jsonResponse(
                    """{"url":"$url","expiresInSeconds":60,"lastEventId":"input","lastSeqId":17}""",
                )
            }
            fixture.historyArchive = {
                MockResponse().setBody(archiveBody).apply {
                    if (interruptArchive.get())
                        setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)
                }
            }
            val rows = fixture.historyRows
            fixture.historyRows = { request ->
                if (failRows.get()) MockResponse().setResponseCode(503) else rows(request)
            }
            fixture.historyCatchUp = { MockResponse().setResponseCode(503) }
            app.chatService = fixture.service
            auth.state.value = testAuthenticationState(user = "history-review-${UUID.randomUUID()}")
            try {
                device.executeShellCommand("settings put global animator_duration_scale 1")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    device.awaitChatList(app)
                    checkNotNull(device.wait(Until.findObject(By.text("Personal chat")), 15_000))
                        .click()
                    lateinit var history: ConversationHistoryModel
                    fun readOwner() = scenario.onActivity { activity ->
                        val ready =
                            checkNotNull(
                                ViewModelProvider(activity)[SessionModel::class.java]
                                    .uiState
                                    .value
                                    .ready,
                            )
                        history = ready.chats.history
                        owner = ready.chats.viewModelScope.coroutineContext[Job]
                    }
                    readOwner()
                    val skeleton = By.desc(app.getString(R.string.history_loading))
                    val bar = By.desc(app.getString(R.string.history_syncing))
                    val message = By.text("Hello history")
                    awaitState("the interrupted archive with the skeleton visible") {
                        history.uiState.value.consecutiveReadFailures > 0 && device.hasObject(skeleton)
                    }
                    check(!device.hasObject(By.text(app.getString(R.string.chat_list_first_load_failed))))
                    ScreenshotCapture.capture("01-first-read-retrying.png")
                    interruptArchive.set(false)
                    awaitState("the archive recovered") {
                        history.uiState.value.phase == HistoryPhase.Ready && device.hasObject(message)
                    }

                    fun showCachedRetry() {
                        failRows.set(true)
                        scenario.onActivity { history.invalidate() }
                        awaitState("the third refresh failure with the fixed progress bar") {
                            history.uiState.value.consecutiveReadFailures >= 3 &&
                                device.hasObject(bar) && device.hasObject(message)
                        }
                        awaitPrimarySegment(bar)
                    }
                    showCachedRetry()
                    ScreenshotCapture.capture("02-cached-refresh-retrying.png")
                    failRows.set(false)
                    awaitState("the cached refresh recovered") {
                        history.uiState.value.phase == HistoryPhase.Ready &&
                            !device.hasObject(bar) && device.hasObject(message)
                    }
                    ScreenshotCapture.capture("03-history-recovered.png")

                    withWideDisplay {
                        val list = chatListRegion(app)
                        awaitState("the resized two-pane conversation") {
                            app.resources.configuration.densityDpi == 160 &&
                                device.displayWidth >= 1_200 &&
                                device.hasObject(list) && device.hasObject(message)
                        }
                        readOwner()
                        awaitState("the resized conversation finished its initial refresh") {
                            history.uiState.value.phase == HistoryPhase.Ready
                        }
                        showCachedRetry()
                        val progressBounds = checkNotNull(device.findObject(bar)).visibleBounds
                        val listBounds = checkNotNull(device.findObject(list)).visibleBounds
                        check(progressBounds.width() > 768) { "Progress did not span the pane" }
                        check(progressBounds.left - listBounds.right in 0..2) {
                            "Progress did not start at the conversation divider"
                        }
                        ScreenshotCapture.capture("04-wide-conversation-progress.png")
                        failRows.set(false)
                    }
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

    private fun withWideDisplay(content: () -> Unit) {
        val originalSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues?.get(1)
        val originalDensity =
            Regex("Override density: (\\d+)")
                .find(device.executeShellCommand("wm density"))
                ?.groupValues?.get(1)
        try {
            device.executeShellCommand("wm size 1280x1024")
            device.executeShellCommand("wm density 160")
            content()
        } finally {
            try {
                device.executeShellCommand("wm size ${originalSize ?: "reset"}")
            } finally {
                device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            }
        }
    }

    private fun awaitPrimarySegment(bar: BySelector) = awaitState("the animated primary segment") {
        val bounds = device.findObject(bar)?.visibleBounds ?: return@awaitState false
        val screenshot = instrumentation.uiAutomation.takeScreenshot() ?: return@awaitState false
        try {
            val pixel = screenshot.getPixel(bounds.centerX(), bounds.centerY())
            Color.red(pixel) >= 230 && Color.green(pixel) in 102..210 && Color.blue(pixel) < 80
        } finally {
            screenshot.recycle()
        }
    }

    private fun awaitState(label: String, condition: () -> Boolean) {
        val check = object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice) = condition()
        }
        kotlin.check(device.wait(check, 20_000)) { "Did not observe $label" }
    }
}
