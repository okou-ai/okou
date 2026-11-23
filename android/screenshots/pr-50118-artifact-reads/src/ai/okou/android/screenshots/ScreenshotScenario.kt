package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.artifacts.ArtifactItem
import ai.okou.android.artifacts.ArtifactKind
import ai.okou.android.artifacts.ArtifactPage
import ai.okou.android.artifacts.ConfirmedArtifactCatalog
import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ChatCacheStore
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.graphics.Color
import android.graphics.Rect
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.regex.Pattern
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    private class ReadFailure(
        val threadId: String?,
        val cursor: String?,
        val status: Int,
        val release: CountDownLatch? = null,
    ) {
        val attempts = AtomicInteger()
        val entered = CountDownLatch(1)
    }

    @Test
    fun captureCatalogAndChatResourceReadsOnPhoneAndWideWindows() {
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalService = app.chatService
        val originalLocale = app.initialPreferences
        val originalPreferences = app.snapshotApiPreferences()
        val originalConnectivity = app.connectivity.value
        val originalSize = device.executeShellCommand("wm size")
        val originalDensity = device.executeShellCommand("wm density")
        val originalFont = device.executeShellCommand("settings get system font_scale").trim()
        val originalAnimator =
            device.executeShellCommand("settings get global animator_duration_scale").trim()
        val disk = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val selectedFailure = AtomicReference<ReadFailure?>()
        var thrown: Throwable? = null
        ChatListApiFixture().use { api ->
            val data = ArtifactApiFixture(api, chinese = true)
            data.install()
            val respond = api.commandResponse
            api.commandResponse = { request ->
                val failure = selectedFailure.get()
                val url = request.requestUrl
                if (
                    failure != null &&
                        url?.encodedPath == "/api/artifacts/catalog" &&
                        url.queryParameter("chatThreadId") == failure.threadId &&
                        url.queryParameter("cursor") == failure.cursor
                ) {
                    val attempt = failure.attempts.incrementAndGet()
                    if (attempt == 1) {
                        failure.entered.countDown()
                        check(failure.release?.await(45, TimeUnit.SECONDS) != false) {
                            "First resource response was not released"
                        }
                    }
                    MockResponse().setResponseCode(failure.status)
                } else respond(request)
            }
            try {
                val user = "artifact-reads-${UUID.randomUUID()}"
                auth.state.value = testAuthenticationState(user = user)
                app.chatService = api.service
                app.initialPreferences =
                    testPreferences()
                        .copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = UserPreferencesTheme.LIGHT,
                            timezone = "Asia/Shanghai",
                        )
                app.connectivity.value = true
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("settings put system font_scale 1.0")
                device.executeShellCommand("settings put global animator_duration_scale 1.0")
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    assertWidth(activity, 412)
                    openArtifacts(data)
                    node(containsText(data.checklist.title))
                    node(containsText(data.slides.title))
                    assertTrue(
                        node(By.desc("搜索成果")).visibleBounds.top <
                            node(By.text("今天")).visibleBounds.top,
                    )
                    ScreenshotCapture.capture("artifacts-phone-catalog.png")
                    val owner = AtomicReference<ChatCacheStore.Lease>()
                    activity.onActivity {
                        val ready =
                            checkNotNull(
                                ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready,
                            )
                        owner.set(ready.chats.cache)
                    }
                    val rows =
                        listOf(
                                data.checklist to ArtifactKind.File,
                                data.summary to ArtifactKind.File,
                                data.site to ArtifactKind.Website,
                                data.slides to ArtifactKind.Presentation,
                            )
                            .map { (item, kind) ->
                                ArtifactItem(
                                    item.id,
                                    item.title,
                                    kind,
                                    Instant.parse(item.date).toEpochMilli(),
                                )
                            }
                    runBlocking {
                        owner
                            .get()
                            .saveArtifactCatalog(
                                CHAT_PERSONAL,
                                ConfirmedArtifactCatalog(
                                    ArtifactPage(rows, null),
                                    System.currentTimeMillis() - 11 * 60_000,
                                ),
                                appendedTo = null,
                            )
                    }
                }
                runBlocking { app.chatCache.close() }

                val refresh = ReadFailure(CHAT_PERSONAL, null, 503, CountDownLatch(1))
                selectedFailure.set(refresh)
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    assertWidth(activity, 412)
                    val row = containsText(data.summary.title)
                    val sync = By.desc("正在同步对话资料")
                    val originalRow =
                        try {
                            openResources(data)
                            val toolbar = node(By.text("对话资料"))
                            val indicator = node(sync)
                            val visible = node(row).visibleBounds
                            assertTrue(toolbar.visibleBounds.bottom <= indicator.visibleBounds.top)
                            assertTrue(indicator.visibleBounds.bottom < visible.top)
                            assertTrue(refresh.entered.await(10, TimeUnit.SECONDS))
                            assertEquals(1, refresh.attempts.get())
                            assertFalse(
                                device.hasObject(By.pkg(app.packageName).text("暂时无法更新，显示已加载的成果")),
                            )
                            awaitProgressActivity(indicator.visibleBounds)
                            ScreenshotCapture.capture("chat-resources-phone-sync.png")
                            visible
                        } finally {
                            refresh.release?.countDown()
                        }
                    node(By.text("暂时无法更新，显示已加载的成果"))
                    assertEquals(3, refresh.attempts.get())
                    assertEquals(originalRow, node(row).visibleBounds)
                    assertFalse(device.hasObject(By.copy(sync).pkg(app.packageName)))
                    ScreenshotCapture.capture("chat-resources-phone-refresh-error.png")
                }

                auth.state.value = testAuthenticationState(user = "$user-wide")
                device.executeShellCommand("wm size 1180x820")
                data.pageSize = 2
                val failedPage = ReadFailure(CHAT_PERSONAL, "2", 400)
                selectedFailure.set(failedPage)
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    assertWidth(activity, 1180)
                    openResources(data)
                    val notice = node(By.text("暂时无法加载更多成果"))
                    val row = node(containsText(data.summary.title))
                    assertTrue(row.visibleBounds.bottom < notice.visibleBounds.top)
                    assertTrue(node(By.desc("成果")).visibleBounds.right < row.visibleBounds.left)
                    assertEquals(1, failedPage.attempts.get())
                    ScreenshotCapture.capture("chat-resources-wide-page-error.png")

                    val firstRead = ReadFailure(null, null, 400)
                    selectedFailure.set(firstRead)
                    device.pressBack()
                    node(By.desc("成果").enabled(true)).click()
                    val catalogError = node(By.text("暂时无法加载成果"))
                    val query = node(By.desc("搜索成果"))
                    assertTrue(query.visibleBounds.bottom < catalogError.visibleBounds.top)
                    assertEquals(1, firstRead.attempts.get())
                    node(By.desc("返回工作区").enabled(true))
                    ScreenshotCapture.capture("artifacts-wide-first-read-error.png")
                }
            } catch (error: Throwable) {
                thrown = error
                runCatching { ScreenshotCapture.capture("artifact-read-diagnostic.png") }
                    .exceptionOrNull()
                    ?.let(error::addSuppressed)
                throw error
            } finally {
                selectedFailure.get()?.release?.countDown()
                cleanup(
                    thrown,
                    { restoreDisplay("size", originalSize) },
                    { restoreDisplay("density", originalDensity) },
                    {
                        if (originalFont.toFloatOrNull() == null) {
                            device.executeShellCommand("settings delete system font_scale")
                        } else
                            device.executeShellCommand(
                                "settings put system font_scale $originalFont",
                            )
                    },
                    { auth.state.value = originalAuth },
                    { app.chatService = originalService },
                    { app.initialPreferences = originalLocale },
                    { app.restoreApiPreferences(originalPreferences) },
                    { app.connectivity.value = originalConnectivity },
                    {
                        if (originalAnimator.toFloatOrNull() == null) {
                            device.executeShellCommand(
                                "settings delete global animator_duration_scale",
                            )
                        } else {
                            device.executeShellCommand(
                                "settings put global animator_duration_scale $originalAnimator",
                            )
                        }
                    },
                    { disk.restore() },
                )
            }
        }
    }

    private fun openArtifacts(data: ArtifactApiFixture) {
        node(By.text(data.sourceTitle))
        node(By.desc("成果").enabled(true)).click()
    }

    private fun openResources(data: ArtifactApiFixture) {
        node(By.text(data.sourceTitle)).click()
        node(By.desc("聊天操作").enabled(true)).click()
        node(By.text("对话资料")).click()
    }

    private fun containsText(label: String): BySelector =
        By.text(Pattern.compile("(?s).*" + Pattern.quote(label) + ".*"))

    private fun node(selector: BySelector) =
        checkNotNull(
            device.wait(Until.findObject(By.copy(selector).pkg(app.packageName)), 15_000),
        ) {
            val texts = device.findObjects(By.pkg(app.packageName)).mapNotNull { it.text }
            "Missing native state $selector. Visible text $texts"
        }

    private fun awaitProgressActivity(bounds: Rect) {
        val painted =
            device.wait(
                Condition<UiDevice, Boolean> {
                    val frame = takeScreenshot()
                    try {
                        (bounds.left until bounds.right).count { x ->
                            val color = frame.getPixel(x, bounds.centerY())
                            Color.red(color) > 225 &&
                                Color.green(color) < 220 &&
                                Color.blue(color) < 90
                        } >= 24
                    } finally {
                        frame.recycle()
                    }
                },
                12_000L,
            )
        assertTrue("The progress bar needs a visible activity segment", painted == true)
    }

    private fun assertWidth(activity: ActivityScenario<MainActivity>, width: Int) {
        activity.onActivity {
            assertEquals(width, it.resources.configuration.screenWidthDp)
            assertEquals(160, it.resources.configuration.densityDpi)
        }
    }

    private fun restoreDisplay(setting: String, original: String) {
        val override =
            original.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
        device.executeShellCommand("wm $setting ${override ?: "reset"}")
    }

    private fun cleanup(original: Throwable?, vararg steps: () -> Unit) {
        val errors = steps.mapNotNull { runCatching(it).exceptionOrNull() }
        if (errors.isEmpty()) return
        if (original != null) errors.forEach(original::addSuppressed)
        else throw errors.first().apply { errors.drop(1).forEach(::addSuppressed) }
    }
}
