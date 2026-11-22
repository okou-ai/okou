package ai.okou.android.screenshots

import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workflowDirectoryDetailAndDraft() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val previousComposer = app.composerService
        val previousWorkflows = app.workflows
        val previousPreferences = app.initialPreferences
        val previousPreferenceData = app.snapshotApiPreferences()
        val size = device.executeShellCommand("wm size")
        val density = device.executeShellCommand("wm density")
        val originalSize = Regex("Override size: (\\d+x\\d+)").find(size)?.groupValues?.get(1)
        val originalDensity = Regex("Override density: (\\d+)").find(density)?.groupValues?.get(1)
        val originalScale = device.executeShellCommand("settings get system font_scale").trim()
        val fixture = WorkflowApiFixture(chinese = true)
        fun text(value: String) =
            checkNotNull(
                device.wait(Until.findObject(By.pkg(app.packageName).textContains(value)), 10_000)
            ) {
                "Missing native text: $value"
            }
        fun back() {
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
        }
        try {
            app.chatService = fixture.service
            app.composerService = fixture.service
            app.workflows = fixture.service
            app.initialPreferences =
                testPreferences()
                    .copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                    )
            auth.state.value =
                testAuthenticationState(user = "workflow-screenshots-${UUID.randomUUID()}")
            device.executeShellCommand("wm size 412x892")
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")

            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                text("Personal chat")
                val entry =
                    checkNotNull(
                        device.wait(
                            Until.findObject(By.pkg(app.packageName).text("工作流").enabled(true)),
                            10_000,
                        )
                    )
                val search =
                    checkNotNull(
                        device.wait(Until.findObject(By.pkg(app.packageName).desc("搜索工作区")), 10_000)
                    )
                assertTrue(entry.visibleBounds.top >= search.visibleBounds.bottom)
                ScreenshotCapture.capture("workflows-chat-list-entry.png")
                entry.click()
                text(fixture.releaseTitle)
                text("发布后跟进")
                text("客户反馈汇总")
                text("需连接")
                ScreenshotCapture.capture("workflows-phone-list.png")

                text(fixture.releaseTitle).click()
                text("核对发布文案和产品说明")
                text("在聊天中使用")
                ScreenshotCapture.capture("workflows-phone-instructions.png")

                text("编辑说明").click()
                text("保存")
                ScreenshotCapture.capture("workflows-phone-edit.png")
                text("取消").click()
                text("在聊天中使用")

                text("自动化").click()
                text(fixture.ruleTitle)
                text("已暂停 · 需连接")
                ScreenshotCapture.capture("workflows-phone-automations.png")

                text("运行记录").click()
                text("最近自动化运行")
                ScreenshotCapture.capture("workflows-phone-history.png")
                text(fixture.ruleTitle).click()
                text("Personal chat")
                back()
                text("最近自动化运行")
                checkNotNull(
                        device.wait(Until.findObject(By.pkg(app.packageName).text("自动化")), 10_000)
                    )
                    .click()
                text("已暂停 · 需连接")

                text("在聊天中使用").click()
                text("/release-review 保留原有草稿")
                assertTrue(
                    device.wait(Until.gone(By.pkg(app.packageName).textContains("正在同步草稿")), 10_000)
                )
                assertFalse(
                    fixture.requests.any {
                        it.method == "POST" &&
                            it.requestUrl?.encodedPath in
                                setOf("/api/chat-threads", "/api/chat/events")
                    }
                )
                ScreenshotCapture.capture("workflows-phone-draft.png")

                back()
                text(fixture.ruleTitle)
                device.executeShellCommand("wm size 1180x820")
                text("搜索工作流")
                val ruleBounds = text(fixture.ruleTitle).visibleBounds
                assertTrue(text("搜索工作流").visibleBounds.right < ruleBounds.left)
                text("在聊天中使用")
                ScreenshotCapture.capture("workflows-wide-automations.png")

                device.executeShellCommand("wm size 900x450")
                device.executeShellCommand("settings put system font_scale 2.0")
                assertTrue(
                    device.wait(Until.gone(By.pkg(app.packageName).textContains("搜索工作流")), 10_000)
                )
                text("在聊天中使用")
                scenario.onActivity { activity ->
                    assertTrue(activity.resources.configuration.fontScale >= 2f)
                    assertTrue(activity.resources.configuration.screenHeightDp < 480)
                }
                checkNotNull(
                        device.wait(
                            Until.findObject(By.pkg(app.packageName).scrollable(true)),
                            10_000,
                        )
                    )
                    .scroll(Direction.DOWN, 0.85f)
                text(fixture.ruleTitle)
                ScreenshotCapture.capture("workflows-short-large-text.png")
            }
        } finally {
            app.chatService = previousChats
            app.composerService = previousComposer
            app.workflows = previousWorkflows
            app.initialPreferences = previousPreferences
            app.restoreApiPreferences(previousPreferenceData)
            auth.state.value = previousAuth
            fixture.close()
            if (originalScale.toFloatOrNull() == null) {
                device.executeShellCommand("settings delete system font_scale")
            } else {
                device.executeShellCommand("settings put system font_scale $originalScale")
            }
            device.executeShellCommand("wm size ${originalSize ?: "reset"}")
            device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
        }
    }
}
