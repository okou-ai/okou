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
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication

    @Test
    fun workflowColdReadsAndConfirmedData() {
        val originalSize = displayOverride("size", "\\d+x\\d+")
        val originalDensity = displayOverride("density", "\\d+")
        val originalScale = device.executeShellCommand("settings get system font_scale").trim()
        try {
            device.executeShellCommand("wm density 160")
            withWindow(412, 892, 1f, UserPreferencesTheme.LIGHT, ::capturePhone)
            withWindow(1180, 820, 2f, UserPreferencesTheme.DARK, ::captureWide)
        } finally {
            try {
                device.executeShellCommand("wm size ${originalSize ?: "reset"}")
            } finally {
                try {
                    device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
                } finally {
                    if (originalScale.toFloatOrNull() == null) {
                        device.executeShellCommand("settings delete system font_scale")
                    } else {
                        device.executeShellCommand("settings put system font_scale $originalScale")
                    }
                }
            }
        }
    }

    private fun capturePhone(fixture: WorkflowApiFixture) {
        openDirectory()
        val pendingButton = withReadHeld({ fixture.beforeReleaseDetailRead = it }) {
            action(fixture.releaseTitle).click()
            node(By.desc("工作流"))
            val button = ancestor(text("在聊天中使用")) { !it.isEnabled }
            val bounds = button.visibleBounds
            assertEquals(20, bounds.left)
            assertTrue(bounds.height() >= 48)
            ScreenshotCapture.capture("phone-detail-loading.png")
            bounds
        }
        text("工作流说明")
        val tabs = listOf("说明", "自动化", "运行记录").map { tab(it).visibleBounds }
        assertTrue(tabs.all { it.height() >= 48 })
        assertTrue(tabs.maxOf { it.width() } - tabs.minOf { it.width() } <= 1)
        assertEquals(pendingButton, action("在聊天中使用").visibleBounds)
        ScreenshotCapture.capture("phone-detail.png")
        captureHistory(fixture, "phone")
    }

    private fun captureWide(fixture: WorkflowApiFixture) {
        withReadHeld({ fixture.beforeCatalog = it }) {
            openDirectory()
            node(By.desc("工作流"))
            ScreenshotCapture.capture("wide-directory-loading.png")
        }
        action(fixture.releaseTitle)
        ScreenshotCapture.capture("wide-directory.png")
        action(fixture.releaseTitle).click()
        text("工作流说明")
        captureHistory(fixture, "wide")
    }

    private fun captureHistory(fixture: WorkflowApiFixture, prefix: String) {
        val useBounds = action("在聊天中使用").visibleBounds
        withReadHeld({ fixture.beforeHistoryRead = it }) {
            tab("运行记录").click()
            node(By.desc("正在加载运行记录…"))
            assertEquals(useBounds, action("在聊天中使用").visibleBounds)
            ScreenshotCapture.capture("$prefix-history-loading.png")
        }
        assertTrue(action("运行中").isEnabled)
        text("失败")
        text("已完成")
        assertEquals(useBounds, action("在聊天中使用").visibleBounds)
        ScreenshotCapture.capture("$prefix-history.png")
    }

    private inline fun <T> withReadHeld(setGate: (() -> Unit) -> Unit, capture: () -> T): T {
        val gate = CountDownLatch(1)
        setGate { gate.await() }
        return try {
            capture()
        } finally {
            gate.countDown()
        }
    }

    private fun withWindow(
        width: Int,
        height: Int,
        scale: Float,
        theme: UserPreferencesTheme,
        capture: (WorkflowApiFixture) -> Unit,
    ) {
        WorkflowApiFixture(chinese = true).use { fixture ->
            val originalPreferences = app.initialPreferences
            val originalPreferenceData = app.snapshotApiPreferences()
            val auth = app.authentication as TestAuthentication
            val originalAuth = auth.state.value
            val originalChats = app.chatService
            val originalComposer = app.composerService
            val originalFlows = app.workflows
            try {
                device.executeShellCommand("wm size ${width}x${height}")
                device.executeShellCommand("settings put system font_scale $scale")
                app.chatService = fixture.service
                app.composerService = fixture.service
                app.workflows = fixture.service
                app.restoreApiPreferences(emptyMap())
                app.initialPreferences =
                    testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = theme,
                        timezone = "Asia/Shanghai",
                    )
                auth.state.value = testAuthenticationState(
                    user = "user-a",
                    session = "workflow-loading-${UUID.randomUUID()}",
                )
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    try {
                        scenario.onActivity { activity ->
                            val config = activity.resources.configuration
                            assertEquals(width, config.screenWidthDp)
                            assertEquals(160, config.densityDpi)
                            assertEquals(scale, config.fontScale, .001f)
                        }
                        capture(fixture)
                    } catch (failure: Throwable) {
                        runCatching {
                            TestStorage().openOutputFile("workflow-failure-${width}.xml")
                                .use(device::dumpWindowHierarchy)
                        }
                        runCatching { ScreenshotCapture.capture("workflow-failure-${width}.png") }
                        throw failure
                    }
                }
            } finally {
                app.chatService = originalChats
                app.composerService = originalComposer
                app.workflows = originalFlows
                auth.state.value = originalAuth
                app.initialPreferences = originalPreferences
                app.restoreApiPreferences(originalPreferenceData)
            }
        }
    }

    private fun displayOverride(setting: String, pattern: String): String? =
        Regex("Override $setting: ($pattern)")
            .find(device.executeShellCommand("wm $setting"))?.groupValues?.get(1)

    private fun openDirectory() {
        text("Personal chat")
        node(By.desc("工作流").enabled(true)).click()
        text("仅自己")
    }

    private fun node(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector.pkg(app.packageName)), 15_000)) {
            "Missing workflow selector $selector"
        }

    private fun text(label: String): UiObject2 = node(By.text(label))

    private fun ancestor(label: UiObject2, match: (UiObject2) -> Boolean): UiObject2 =
        checkNotNull(generateSequence(label) { it.parent }.firstOrNull(match)) {
            "Missing native control for ${label.text}"
        }

    private fun action(label: String): UiObject2 = ancestor(text(label)) { it.isClickable }

    private fun tab(label: String): UiObject2 = ancestor(text(label)) { it.isFocusable }
}
