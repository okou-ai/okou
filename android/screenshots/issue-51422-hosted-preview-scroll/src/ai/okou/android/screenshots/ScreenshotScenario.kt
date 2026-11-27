package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
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
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
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

    @Test fun retainsNativeWebsiteScrollOnPhone() = captureScroll(412, 892, "phone")

    @Test fun retainsNativeWebsiteScrollBesideCatalog() = captureScroll(1180, 820, "wide")

    private fun captureScroll(width: Int, height: Int, layout: String) =
        withWorkspace(width, height) { api, fixture, activity ->
            val resourceRequested = CountDownLatch(1)
            val releaseResource = CountDownLatch(1)
            val respond = api.commandResponse
            api.commandResponse = { request ->
                when (request.requestUrl?.encodedPath) {
                    "/artifact-bytes/site" ->
                        MockResponse()
                            .setHeader("Content-Type", "text/html; charset=utf-8")
                            .setBody(hostedPage())
                    "/artifact-bytes/held-preview-image" -> {
                        resourceRequested.countDown()
                        check(releaseResource.await(12, TimeUnit.SECONDS))
                        MockResponse().setResponseCode(204)
                    }
                    else -> respond(request)
                }
            }
            try {
                tap(By.desc("成果"))
                tap(By.text(fixture.site.title))
                assertTrue(resourceRequested.await(8, TimeUnit.SECONDS))
                node(By.text("产品发布核对"))
                val source = node(By.text("查看来源对话")).visibleBounds
                var anchor = 0
                activity.onActivity {
                    val web = checkNotNull(it.window.decorView.hostedView())
                    check(web.progress < 100) { "Held document already completed" }
                    web.scrollTo(0, 235)
                    anchor = web.scrollY
                    check(anchor > 0) { "Visible hosted content did not scroll" }
                }
                releaseResource.countDown()
                awaitFinished(activity)
                device.waitForIdle()
                activity.onActivity {
                    val web = checkNotNull(it.window.decorView.hostedView())
                    assertEquals(anchor, web.scrollY)
                }
                assertEquals(source, node(By.text("查看来源对话")).visibleBounds)
                if (layout == "wide") node(By.text("今天"))
                ScreenshotCapture.capture("hosted-preview-scroll-$layout.png")
            } finally {
                releaseResource.countDown()
            }
        }

    private fun awaitFinished(activity: ActivityScenario<MainActivity>) {
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            var finished = false
            activity.onActivity { finished = it.window.decorView.hostedView()?.progress == 100 }
            if (finished) return
            SystemClock.sleep(40)
        }
        error("Hosted document did not finish after the resource was released")
    }

    private fun View.hostedView(): WebView? {
        if (this is WebView) return this
        if (this is ViewGroup) {
            for (index in 0 until childCount) getChildAt(index).hostedView()?.let {
                return it
            }
        }
        return null
    }

    private fun hostedPage() =
        """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body{font:16px system-ui,sans-serif;color:#302218;background:#fff8f0;margin:0}
          header,section{padding:20px 24px}
          header{background:#fae9d7;min-height:194px}
          h1{font-size:26px;margin:6px 0}
          h2{font-size:19px;margin:0 0 10px}
          p{line-height:1.5;margin:0}
          section{min-height:140px;border-top:1px solid #eaddd0}
          small{color:#71513a}
        </style>
        <header><small>项目资料</small><h1>产品发布核对</h1><p>官网、邮件和社区素材的发布准备。</p></header>
        <section><h2>官网素材</h2><p>首页长版文案与产品截图已完成核对。</p></section>
        <section><h2>邮件内容</h2><p>主题、正文与跳转链接已确认。</p></section>
        <section><h2>社区发布</h2><p>配图、发布时间和负责人已整理。</p></section>
        <img src="/artifact-bytes/held-preview-image" width="1" height="1" alt="">
        </html>"""

    private fun withWorkspace(
        width: Int,
        height: Int,
        block: (ChatListApiFixture, ArtifactApiFixture, ActivityScenario<MainActivity>) -> Unit,
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
                val fixture = ArtifactApiFixture(api, chinese = true)
                fixture.install()
                auth.state.value =
                    testAuthenticationState(user = "hosted-scroll-${UUID.randomUUID()}")
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
                        block(api, fixture, activity)
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
