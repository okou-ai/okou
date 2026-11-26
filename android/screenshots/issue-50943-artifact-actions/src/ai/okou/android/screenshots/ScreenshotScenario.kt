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
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.SearchCondition
import androidx.test.uiautomator.Searchable
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import java.util.UUID
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
    fun capturesSharedPreviewActions() {
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
                val artifacts = ArtifactApiFixture(api, chinese = true)
                artifacts.install()
                val respond = api.commandResponse
                api.commandResponse = { request ->
                    if (request.requestUrl?.encodedPath == "/artifact-bytes/site") {
                        MockResponse().setHeader("Content-Type", "text/html; charset=utf-8")
                            .setBody("""<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;padding:28px;background:#fcf8f4;color:#30251c;font-family:sans-serif"><h1>发布计划</h1><p>产品发布介绍页</p><ul><li>确认发布范围和时间</li><li>准备官网与邮件素材</li><li>同步发布后的跟进事项</li></ul></body></html>""")
                    } else respond(request)
                }
                auth.state.value = testAuthenticationState(user = "artifact-actions-${UUID.randomUUID()}")
                app.chatService = api.service
                app.initialPreferences = testPreferences().copy(
                    locale = UserPreferencesLocale.ZH_HANS,
                    theme = UserPreferencesTheme.LIGHT,
                    timezone = "Asia/Shanghai",
                )
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 1.0")
                device.executeShellCommand("wm size 412x892")
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    activity.onActivity { assertEquals(412, it.resources.configuration.screenWidthDp) }
                    openCatalog(artifacts)
                    tap(By.text(artifacts.checklist.title))
                    val save = node(By.text("保存文件"))
                    assertTrue(save.isEnabled)
                    ScreenshotCapture.capture("artifact-save-phone.png")
                }
                device.executeShellCommand("wm size 1180x820")
                ActivityScenario.launch(MainActivity::class.java).use { activity ->
                    activity.onActivity { assertEquals(1180, it.resources.configuration.screenWidthDp) }
                    openCatalog(artifacts)
                    tap(By.text(artifacts.site.title))
                    assertTrue(node(By.text("查看来源对话")).isEnabled)
                    assertTrue(node(By.text("打开网页")).isEnabled)
                    node(By.text("发布计划"))
                    ScreenshotCapture.capture("artifact-source-website-wide.png")
                }
            } catch (failure: Throwable) {
                runCatching { ScreenshotCapture.capture("diagnostic.png") }
                throw failure
            } finally {
                restoreDisplay("size", oldSize)
                restoreDisplay("density", oldDensity)
                if (oldScale.toFloatOrNull() == null) {
                    device.executeShellCommand("settings delete system font_scale")
                } else device.executeShellCommand("settings put system font_scale $oldScale")
                auth.state.value = oldAuth
                app.chatService = oldService
                app.initialPreferences = oldPreferences
                app.restoreApiPreferences(oldApiPreferences)
                cache.restore()
            }
        }
    }

    private fun openCatalog(artifacts: ArtifactApiFixture) {
        node(By.text(artifacts.sourceTitle))
        tap(By.desc("成果"))
        node(By.text(artifacts.checklist.title))
    }

    private fun tap(selector: BySelector) {
        val bounds = node(selector).visibleBounds
        assertTrue(device.click(bounds.centerX(), bounds.centerY()))
    }

    private fun node(selector: BySelector): UiObject2 {
        val scoped = By.copy(selector).pkg(app.packageName)
        return checkNotNull(device.wait(object : SearchCondition<UiObject2>() {
            override fun apply(searchable: Searchable): UiObject2? =
                try {
                    searchable.findObject(scoped)
                } catch (_: StaleObjectException) {
                    null
                }
        }, 15_000)) { "Missing $selector" }
    }

    private fun restoreDisplay(setting: String, previous: String) {
        val value = previous.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
        device.executeShellCommand("wm $setting ${value ?: "reset"}")
    }
}
