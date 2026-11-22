package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.BuildConfig
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.graphics.Color
import android.os.SystemClock
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt
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

    @Test
    fun capturesCatalogReturnAndPreviewRecovery() {
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousService = app.chatService
        val previousPreferences = app.snapshotApiPreferences()
        val previousConnectivity = app.connectivity.value
        val chatCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val user = "artifact-recovery-${UUID.randomUUID()}"
        val size = device.executeShellCommand("wm size")
        val density = device.executeShellCommand("wm density")
        ChatListApiFixture().use { api ->
            val data = ArtifactApiFixture(api, chinese = true, imageBody = releaseAvatarThumbnail)
            data.install()
            val previewUnavailable = AtomicBoolean(false)
            val previewFailures = CopyOnWriteArrayList<Long>()
            val response = api.commandResponse
            api.commandResponse = { request ->
                if (
                    previewUnavailable.get() &&
                        request.requestUrl?.encodedPath == "/artifact-bytes/summary"
                ) {
                    previewFailures.add(SystemClock.elapsedRealtime())
                    MockResponse().setResponseCode(503)
                } else response(request)
            }
            app.chatService = api.service
            app.restoreApiPreferences(
                previousPreferences +
                    (Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                        testPreferences()
                            .copy(
                                locale = UserPreferencesLocale.ZH_HANS,
                                theme = UserPreferencesTheme.LIGHT,
                            ))
            )
            app.connectivity.value = true
            auth.state.value = testAuthenticationState(user = user)
            try {
                device.executeShellCommand("wm size 1080x2340")
                device.executeShellCommand("wm density 420")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    node(By.text(data.sourceTitle))
                    node(By.desc("成果").enabled(true)).click()
                    node(By.text("今天"))
                    node(By.text("昨天"))
                    node(By.text("更早"))
                    expectThumbnail(data.image.title)
                    ScreenshotCapture.capture("artifacts-catalog.png")

                    node(By.text("文件")).click()
                    val editor = By.clazz("android.widget.EditText").enabled(true)
                    node(editor).click()
                    node(editor).text = "产品发布"
                    assertTrue(
                        device.wait(
                            Condition { data.catalogQueries.contains("file" to "产品发布") },
                            12_000,
                        )
                    )
                    val summary = By.textContains(data.summary.title)
                    val body = By.textContains("定位：帮助团队")
                    node(summary)
                    var keyboardVisible = false
                    scenario.onActivity {
                        keyboardVisible =
                            ViewCompat.getRootWindowInsets(it.window.decorView)
                                ?.isVisible(WindowInsetsCompat.Type.ime()) == true
                    }
                    if (keyboardVisible) assertTrue(device.pressBack())
                    node(summary).click()
                    val source = By.textContains("查看来源对话")
                    node(By.textContains("仅供预览"))
                    node(source)
                    assertFalse(device.hasObject(By.pkg(app.packageName).text("保存文件")))
                    val bodyBounds = node(body).visibleBounds
                    ScreenshotCapture.capture("artifacts-preview.png")

                    node(source).click()
                    node(By.desc("返回成果预览")).click()
                    assertEquals(bodyBounds, node(body).visibleBounds)
                    node(By.desc("返回成果列表")).click()
                    node(summary)
                    assertEquals("产品发布", node(editor).text)
                    assertFalse(device.hasObject(By.pkg(app.packageName).text("昨天")))
                    assertFalse(
                        device.hasObject(By.pkg(app.packageName).textContains(data.site.title))
                    )
                    ScreenshotCapture.capture("artifacts-search-return.png")

                    node(summary).click()
                    node(body)
                    node(source).click()
                    val backToPreview = node(By.desc("返回成果预览"))
                    previewUnavailable.set(true)
                    backToPreview.click()
                    node(By.text("暂时无法加载"))
                    assertEquals(3, previewFailures.size)
                    assertTrue(previewFailures.zipWithNext().all { (a, b) -> b - a >= 3_000 })
                    assertEquals(bodyBounds, node(body).visibleBounds)
                    node(source).let { assertTrue(it.isEnabled) }
                    ScreenshotCapture.capture("artifacts-preview-failed.png")

                    previewUnavailable.set(false)
                    node(By.desc("返回成果列表")).click()
                    node(By.desc("清除搜索")).click()
                    node(By.text("全部")).click()
                    node(By.text("更早"))
                    node(summary).click()
                    node(body)
                    device.executeShellCommand("wm size 1180x820")
                    device.executeShellCommand("wm density 160")
                    node(By.text("更早"))
                    val catalog = node(By.desc("搜索成果"))
                    assertTrue(catalog.visibleBounds.right < node(body).visibleBounds.left)
                    assertTrue(
                        device.wait(Until.gone(By.pkg(app.packageName).text("暂时无法加载")), 12_000)
                    )
                    expectThumbnail(data.image.title)
                    ScreenshotCapture.capture("artifacts-wide.png")
                }
            } catch (error: Throwable) {
                runCatching { ScreenshotCapture.capture("artifacts-diagnostic.png") }
                    .exceptionOrNull()
                    ?.let(error::addSuppressed)
                throw error
            } finally {
                restoreSetting("size", size)
                restoreSetting("density", density)
                auth.state.value = previousAuth
                app.connectivity.value = previousConnectivity
                app.chatService = previousService
                app.restoreApiPreferences(previousPreferences)
                chatCache.restore()
            }
        }
    }

    private fun node(selector: BySelector) =
        checkNotNull(
            device.wait(Until.findObject(By.copy(selector).pkg(app.packageName)), 12_000)
        ) {
            val visibleText = device.findObjects(By.pkg(app.packageName)).mapNotNull { it.text }
            "Missing artifact screenshot state: $selector. Visible fixture text: $visibleText"
        }

    private fun expectThumbnail(title: String) {
        val density = instrumentation.targetContext.resources.displayMetrics.density
        val center = node(By.textContains(title)).visibleBounds.centerY()
        val radius = (16 * density).roundToInt()
        val x = (32 * density).roundToInt()..(62 * density).roundToInt()
        assertTrue(
            device.wait(
                Condition {
                    instrumentation.uiAutomation.takeScreenshot()?.let { frame ->
                        try {
                            (center - radius..center + radius).any { y ->
                                x.any { px ->
                                    val pixel = frame.getPixel(px, y)
                                    Color.red(pixel) >= 200 &&
                                        Color.green(pixel) in 100..200 &&
                                        Color.blue(pixel) <= 80
                                }
                            }
                        } finally {
                            frame.recycle()
                        }
                    } == true
                },
                12_000,
            )
        )
    }

    private fun restoreSetting(setting: String, receipt: String) {
        val override =
            receipt.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
                ?: "reset"
        device.executeShellCommand("wm $setting $override")
    }
}
