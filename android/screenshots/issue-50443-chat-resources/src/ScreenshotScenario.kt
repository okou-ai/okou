package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.TestRealtimeService
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ChatChanges
import ai.okou.android.testAuthenticationState
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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
    fun conversationResourceFeedback() {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldChats = app.chatService
        val oldRealtime = app.realtimeService
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val realtime = TestRealtimeService()
        val readStarted = CountDownLatch(1)
        val releaseRead = CountDownLatch(1)
        val failRefresh = AtomicBoolean(false)
        var owner: Job? = null
        ChatListApiFixture().use { api ->
            val fixture = ArtifactApiFixture(api)
            fixture.pageSize = 2
            fixture.install()
            val respond = api.commandResponse
            api.commandResponse = { request ->
                val url = checkNotNull(request.requestUrl)
                when {
                    url.encodedPath != "/api/artifacts/catalog" -> respond(request)
                    url.queryParameter("cursor") != null || failRefresh.get() ->
                        MockResponse().setResponseCode(400)
                    else -> {
                        readStarted.countDown()
                        check(releaseRead.await(20, TimeUnit.SECONDS))
                        respond(request)
                    }
                }
            }
            app.chatService = api.service
            app.realtimeService = realtime
            auth.state.value = testAuthenticationState(user = "resource-capture-${UUID.randomUUID()}")
            try {
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    device.awaitChatList(app)
                    lateinit var ready: SessionModel
                    scenario.onActivity { activity ->
                        ready = ViewModelProvider(activity)[SessionModel::class.java]
                        owner = ready.uiState.value.ready?.chats?.viewModelScope?.coroutineContext?.get(Job)
                    }
                    node(By.text(fixture.sourceTitle)).click()
                    node(By.desc(app.getString(R.string.chat_actions))).click()
                    node(By.text(app.getString(R.string.chat_resources))).click()
                    node(By.text(app.getString(R.string.artifact_title)))
                    check(readStarted.await(10, TimeUnit.SECONDS))
                    awaitSkeleton()
                    ScreenshotCapture.capture("01-initial-loading.png")
                    releaseRead.countDown()

                    val secondRow = By.text(fixture.summary.title)
                    val pageError = By.text(app.getString(R.string.artifact_catalog_page_failed))
                    check(node(pageError).visibleBounds.top > node(secondRow).visibleBounds.bottom)
                    ScreenshotCapture.capture("02-page-failed.png")

                    failRefresh.set(true)
                    realtime.invalidate(ChatChanges(artifactThreads = setOf(CHAT_PERSONAL)))
                    val refreshError =
                        By.text(app.getString(R.string.artifact_catalog_refresh_failed))
                    check(node(refreshError).visibleBounds.bottom < node(secondRow).visibleBounds.top)
                    check(!device.hasObject(pageError))
                    ScreenshotCapture.capture("03-refresh-failed.png")

                    node(secondRow).click()
                    val previewBack = By.desc(app.getString(R.string.chat_resources_back))
                    node(previewBack)
                    api.historyDetail = { MockResponse().setResponseCode(403) }
                    scenario.onActivity {
                        checkNotNull(ready.uiState.value.ready).chats.history.invalidateDetail(CHAT_PERSONAL)
                    }
                    node(By.text(app.getString(R.string.history_missing)))
                    check(!device.hasObject(secondRow) && !device.hasObject(previewBack))
                    node(By.desc(app.getString(R.string.back)))
                    ScreenshotCapture.capture("04-access-unavailable.png")
                }
            } finally {
                releaseRead.countDown()
                try {
                    runBlocking { withTimeout(10_000) { owner?.join() } }
                    cache.restore()
                } finally {
                    app.chatService = oldChats
                    app.realtimeService = oldRealtime
                    auth.state.value = oldAuth
                }
            }
        }
    }

    private fun node(selector: BySelector) =
        checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing ${selector}" }

    private fun awaitSkeleton() {
        val condition = object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean {
                val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: return false
                try {
                    val density = app.resources.displayMetrics.density
                    val x = (48 * density).toInt()
                    val top = (105 * density).toInt()
                    val bottom = (315 * density).toInt().coerceAtMost(bitmap.height)
                    return (top until bottom).count { bitmap.getPixel(x, it) == 0xFFFAF5F3.toInt() } >
                        60 * density
                } finally {
                    bitmap.recycle()
                }
            }
        }
        check(device.wait(condition, 10_000)) { "Expected the three static skeleton rows" }
    }
}
