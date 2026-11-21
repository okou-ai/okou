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
import android.view.KeyEvent
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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun capturesCatalogSearchAndPreviewInBothLayouts() {
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousService = app.chatService
        val previousPreferences = app.snapshotApiPreferences()
        val chatCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val user = "artifact-screenshot-${UUID.randomUUID()}"
        val size = device.executeShellCommand("wm size").trim()
        val density = device.executeShellCommand("wm density").trim()
        ChatListApiFixture().use { api ->
            val data = ArtifactApiFixture(api, chinese = true)
            data.install()
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
            auth.state.value = testAuthenticationState(user = user)
            try {
                device.executeShellCommand("wm size 1080x2340")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    node(By.desc("成果")).click()
                    node(By.text(data.checklist.title))
                    node(By.text("今天"))
                    node(By.text("昨天"))
                    node(By.text("更早"))
                    ScreenshotCapture.capture("artifacts-catalog.png")

                    val editor = By.clazz("android.widget.EditText").enabled(true)
                    node(editor).click()
                    node(editor).text = "产品发布"
                    assertTrue(
                        "Native query reaches the catalog",
                        device.wait(
                            Condition { data.catalogQueries.contains(null to "产品发布") },
                            12_000,
                        ),
                    )
                    assertTrue(
                        "Matching results render without date sections",
                        device.wait(
                            Condition {
                                instrumentation.uiAutomation.clearCache()
                                device.hasObject(
                                    By.pkg(app.packageName).text(data.summary.title)
                                ) && !device.hasObject(By.pkg(app.packageName).text("昨天"))
                            },
                            10_000,
                        ),
                    )
                    var keyboardVisible = false
                    scenario.onActivity {
                        keyboardVisible =
                            ViewCompat.getRootWindowInsets(it.window.decorView)
                                ?.isVisible(WindowInsetsCompat.Type.ime()) == true
                    }
                    if (keyboardVisible) assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                    ScreenshotCapture.capture("artifacts-search.png")

                    node(By.text(data.summary.title)).click()
                    node(By.textContains("定位：帮助团队"))
                    node(By.textContains("仅供预览"))
                    node(By.text("查看来源对话"))
                    ScreenshotCapture.capture("artifacts-preview.png")
                    node(By.text("查看来源对话")).click()
                    node(By.desc("返回成果预览"))
                    assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                    node(By.textContains("定位：帮助团队"))
                    node(By.desc("返回成果列表")).click()
                    node(By.text(data.summary.title))
                    node(By.desc("清除搜索")).click()
                    node(By.text("昨天"))
                    node(By.text(data.summary.title)).click()
                    node(By.textContains("定位：帮助团队"))

                    device.executeShellCommand("wm size 1180x820")
                    device.executeShellCommand("wm density 160")
                    node(By.text("全部"))
                    val selected = node(By.text(data.summary.title))
                    val preview = node(By.textContains("定位：帮助团队"))
                    assertTrue(selected.visibleBounds.right < preview.visibleBounds.left)
                    node(By.text("文件")).click()
                    assertTrue(
                        "Native file filter reaches the catalog",
                        device.wait(
                            Condition { data.catalogQueries.contains("file" to null) },
                            12_000,
                        ),
                    )
                    node(By.textContains("定位：帮助团队"))
                    node(By.text("全部")).click()
                    node(By.text(data.slides.title))
                    ScreenshotCapture.capture("artifacts-wide.png")
                }
            } finally {
                restoreSetting("size", size)
                restoreSetting("density", density)
                auth.state.value = previousAuth
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
            "Missing Artifacts screenshot state: $selector"
        }

    private fun restoreSetting(setting: String, receipt: String) {
        val override =
            receipt.lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")
                ?: "reset"
        device.executeShellCommand("wm $setting $override")
    }
}
