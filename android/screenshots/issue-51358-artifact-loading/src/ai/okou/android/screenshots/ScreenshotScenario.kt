package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun capturesColdAndLoadedCatalogOnPhone() =
        withWorkspace(412, 892) { _, fixture ->
            val releaseCatalog = CountDownLatch(1)
            fixture.beforeCatalog = { check(releaseCatalog.await(16, TimeUnit.SECONDS)) }
            try {
                tap(By.desc("成果"))
                val filterBottom = node(By.text("全部")).visibleBounds.bottom
                verifyCatalogPlaceholder(filterBottom)
                ScreenshotCapture.capture("artifact-catalog-loading-phone.png")
                releaseCatalog.countDown()
                node(By.text(fixture.summary.title))
                for (label in listOf("今天", "昨天", "更早")) {
                    assertEquals(label, 16, node(By.text(label)).visibleBounds.left)
                }
                val avatarRow = node(By.text(fixture.image.title)).visibleBounds
                awaitPixels("The catalog thumbnail did not finish loading") { image ->
                    (avatarRow.top - 8 until avatarRow.bottom).any { y ->
                        (32 until 64).any { x ->
                            val pixel = image.getPixel(x, y)
                            Color.blue(pixel) > 120 && Color.blue(pixel) - Color.red(pixel) > 50
                        }
                    }
                }
                ScreenshotCapture.capture("artifact-catalog-phone.png")
            } finally {
                releaseCatalog.countDown()
            }
        }

    @Test
    fun capturesHostedFirstDocumentAndFailureWithTheWideCatalog() =
        withWorkspace(1180, 820) { api, fixture ->
            val address = InetAddress.getByName("127.0.0.1")
            ServerSocket(0, 1, address).use { stalledDocument ->
                stalledDocument.soTimeout = 12_000
                val origin = "https://127.0.0.1:${stalledDocument.localPort}"
                val respond = api.commandResponse
                api.commandResponse = { request ->
                    if (request.requestUrl?.encodedPath == "/api/host/sites/fixture/preview") {
                        jsonResponse("""{"url":"$origin/site","expiresAt":null}""")
                    } else respond(request)
                }
                tap(By.desc("成果"))
                tap(By.text(fixture.site.title))
                // Accept a real WebView connection after the app has received the preview grant.
                stalledDocument.accept().use {
                    node(By.text("正在加载预览"))
                    node(By.text("今天"))
                    val source = node(By.text("查看来源对话")).visibleBounds
                    ScreenshotCapture.capture("artifact-website-loading-wide.png")
                    stalledDocument.close()
                    it.close()

                    node(By.text("暂时无法加载预览"), timeout = 20_000)
                    assertEquals(source, node(By.text("查看来源对话")).visibleBounds)
                    node(By.text("打开网页"))
                    ScreenshotCapture.capture("artifact-website-failed-wide.png")
                }

                tap(By.text("查看来源对话"))
                tap(By.desc("返回成果预览"))
                node(By.text("查看来源对话"))
                tap(By.text(fixture.summary.title))
                node(By.textContains("定位"))
                node(By.text("今天"))
                assertTrue(
                    device.findObjects(By.text(fixture.summary.title).pkg(app.packageName)).any {
                        it.visibleBounds.left == 410
                    },
                )
                ScreenshotCapture.capture("artifact-document-wide.png")
            }
        }

    @Test
    fun showsTheHostedDocumentAfterItsFirstVisibleFrame() =
        withWorkspace(1180, 820) { api, fixture ->
            val heading = "发布准备就绪"
            val respond = api.commandResponse
            api.commandResponse = { request ->
                if (request.requestUrl?.encodedPath == "/artifact-bytes/site") {
                    MockResponse()
                        .setHeader("Content-Type", "text/html; charset=utf-8")
                        .setBody(
                            """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1">
                        <style>body{font-family:system-ui,sans-serif;margin:32px;color:#211a13;background:#fff8f4}</style>
                        <h1>$heading</h1><p>官网长版、邮件短版和社区配图已完成核对。</p></html>""",
                        )
                } else respond(request)
            }
            tap(By.desc("成果"))
            tap(By.text(fixture.site.title))
            node(By.text(heading))
            assertTrue(!device.hasObject(By.text("正在加载预览").pkg(app.packageName)))
            node(By.text("查看来源对话"))
            ScreenshotCapture.capture("artifact-website-ready-wide.png")
        }

    private fun verifyCatalogPlaceholder(filterBottom: Int) {
        awaitPixels("The held catalog read did not display two skeleton rows") { screenshot ->
            val rows = barRows(screenshot, filterBottom + 4)
            if (rows.size < 4) return@awaitPixels false
            assertEquals(listOf(14, 14, 14, 14), rows.take(4).map { it.count() })
            assertEquals(80, rows[2].first - rows[0].first)
            assertEquals(80, rows[3].first - rows[1].first)
            true
        }
    }

    private fun awaitPixels(message: String, matches: (Bitmap) -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            val screenshot = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            try {
                if (matches(screenshot)) return
            } finally {
                screenshot.recycle()
            }
            SystemClock.sleep(40)
        }
        error(message)
    }

    private fun barRows(screenshot: Bitmap, from: Int): List<IntRange> = buildList {
        // At 160 dpi, x=104 crosses both text bars and x=8 samples the page surface.
        var start = -1
        for (y in from until from + 240) {
            val filled = screenshot.getPixel(104, y) != screenshot.getPixel(8, y)
            if (filled && start < 0) start = y
            if (!filled && start >= 0) {
                add(start until y)
                start = -1
            }
        }
    }

    private fun withWorkspace(
        width: Int,
        height: Int,
        block: (ChatListApiFixture, ArtifactApiFixture) -> Unit,
    ) {
        val auth = app.authentication as TestAuthentication
        val oldAuth = auth.state.value
        val oldService = app.chatService
        val oldPreferences = app.initialPreferences
        val oldApiPreferences = app.snapshotApiPreferences()
        val oldSize = device.executeShellCommand("wm size")
        val oldDensity = device.executeShellCommand("wm density")
        val oldScale = device.executeShellCommand("settings get system font_scale").trim()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        ChatListApiFixture().use { api ->
            try {
                val fixture = ArtifactApiFixture(api, chinese = true, imageBody = avatarImage())
                fixture.install()
                auth.state.value =
                    testAuthenticationState(user = "artifact-loading-${UUID.randomUUID()}")
                app.chatService = api.service
                app.initialPreferences =
                    testPreferences()
                        .copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = UserPreferencesTheme.LIGHT,
                            timezone = "Asia/Shanghai",
                        )
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("wm size ${width}x$height")
                device.executeShellCommand("settings put system font_scale 1.0")
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    activity.onActivity {
                        assertEquals(width, it.resources.configuration.screenWidthDp)
                        assertEquals(1f, it.resources.configuration.fontScale, 0f)
                    }
                    node(By.text(fixture.sourceTitle))
                    try {
                        block(api, fixture)
                    } catch (error: Throwable) {
                        runCatching { ScreenshotCapture.capture("diagnostic-$width.png") }
                        throw error
                    }
                }
            } finally {
                restoreDisplay("size", oldSize)
                restoreDisplay("density", oldDensity)
                if (oldScale.toFloatOrNull() == null) {
                    device.executeShellCommand("settings delete system font_scale")
                } else {
                    device.executeShellCommand("settings put system font_scale $oldScale")
                }
                auth.state.value = oldAuth
                app.chatService = oldService
                app.initialPreferences = oldPreferences
                app.restoreApiPreferences(oldApiPreferences)
                cache.restore()
            }
        }
    }

    private fun avatarImage(): ByteArray {
        val bitmap =
            BitmapFactory.decodeResource(app.resources, R.drawable.okou_conversation_avatar)
        return try {
            ByteArrayOutputStream().use { output ->
                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
                output.toByteArray()
            }
        } finally {
            bitmap.recycle()
        }
    }

    private fun restoreDisplay(kind: String, output: String) {
        val override =
            output
                .lineSequence()
                .firstOrNull { it.startsWith("Override ") }
                ?.substringAfter(": ")
                ?.trim()
        device.executeShellCommand("wm $kind ${override ?: "reset"}")
    }

    private fun tap(selector: BySelector) {
        val bounds = node(selector).visibleBounds
        assertTrue(device.click(bounds.centerX(), bounds.centerY()))
    }

    private fun node(selector: BySelector, timeout: Long = 10_000): UiObject2 =
        checkNotNull(
            device.wait(Until.findObject(By.copy(selector).pkg(app.packageName)), timeout),
        ) {
            "Missing $selector"
        }
}
