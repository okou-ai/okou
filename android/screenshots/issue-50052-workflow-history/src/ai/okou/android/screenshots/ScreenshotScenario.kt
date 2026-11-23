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
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workflowHistoryInCompactAndWideWindows() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val previousComposer = app.composerService
        val previousWorkflows = app.workflows
        val previousConnectivity = app.connectivity.value
        val previousPreferences = app.initialPreferences
        val previousPreferenceData = app.snapshotApiPreferences()
        val originalSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1)
        val originalDensity =
            Regex("Override density: (\\d+)")
                .find(device.executeShellCommand("wm density"))
                ?.groupValues
                ?.get(1)
        val originalScale = device.executeShellCommand("settings get system font_scale").trim()
        val fixture = WorkflowApiFixture(chinese = true)

        fun text(value: String): UiObject2 =
            checkNotNull(
                device.wait(Until.findObject(By.pkg(app.packageName).text(value)), 10_000)
            ) {
                "Missing native text: $value"
            }

        fun openDetail() {
            text("Personal chat")
            val entry =
                checkNotNull(
                    device.wait(
                        Until.findObject(By.pkg(app.packageName).desc("工作流").enabled(true)),
                        10_000,
                    )
                )
            entry.click()
            text(fixture.releaseTitle).click()
            text("在聊天中使用")
        }

        fun historyRows() {
            val running = text("运行中").visibleBounds
            val failed = text("失败").visibleBounds
            val completed = text("已完成").visibleBounds
            assertTrue(running.top < failed.top && failed.top < completed.top)
            assertTrue(text("在聊天中使用").visibleBounds.top > completed.bottom)
            text("收到邮件")
        }

        try {
            app.chatService = fixture.service
            app.composerService = fixture.service
            app.workflows = fixture.service
            app.connectivity.value = true
            app.initialPreferences =
                testPreferences()
                    .copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                    )
            auth.state.value =
                testAuthenticationState(user = "workflow-history-screenshots-${UUID.randomUUID()}")
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 412x892")
            device.executeShellCommand("settings put system font_scale 1.0")

            ActivityScenario.launch(MainActivity::class.java).use {
                openDetail()
                val requested = CountDownLatch(1)
                val release = CountDownLatch(1)
                fixture.beforeHistoryRead = {
                    requested.countDown()
                    release.await()
                }
                try {
                    text("运行记录").click()
                    assertTrue(requested.await(10, TimeUnit.SECONDS))
                    assertTrue(
                        device.wait(
                            Until.hasObject(By.pkg(app.packageName).desc("正在加载运行记录…")),
                            10_000,
                        )
                    )
                    text("在聊天中使用")
                    ScreenshotCapture.capture("workflow-history-phone-loading.png")
                } finally {
                    fixture.beforeHistoryRead = {}
                    release.countDown()
                }

                historyRows()
                text("失败").click()
                historyRows()
                ScreenshotCapture.capture("workflow-history-phone.png")
                text("运行中").click()
                text("Personal chat")
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                historyRows()
            }

            device.executeShellCommand("wm size 360x920")
            device.executeShellCommand("settings put system font_scale 1.5")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                openDetail()
                scenario.onActivity { assertTrue(it.resources.configuration.fontScale >= 1.5f) }
                text("运行记录").click()
                text("运行中")
                text("失败")
                text("在聊天中使用")
                ScreenshotCapture.capture("workflow-history-phone-large-text.png")
            }

            device.executeShellCommand("settings put system font_scale 1.0")
            device.executeShellCommand("wm size 1180x820")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                openDetail()
                scenario.onActivity { assertTrue(it.resources.configuration.screenWidthDp == 1180) }
                text("运行记录").click()
                historyRows()
                val directory = text(fixture.sharedTitle).visibleBounds
                val history = text("最近自动化运行").visibleBounds
                assertTrue(directory.right < history.left)
                ScreenshotCapture.capture("workflow-history-wide.png")

                text(fixture.sharedTitle).click()
                text("运行记录").click()
                text("还没有自动化运行记录")
                text("在聊天中使用")
                ScreenshotCapture.capture("workflow-history-wide-empty.png")
            }
        } finally {
            app.chatService = previousChats
            app.composerService = previousComposer
            app.workflows = previousWorkflows
            app.connectivity.value = previousConnectivity
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
