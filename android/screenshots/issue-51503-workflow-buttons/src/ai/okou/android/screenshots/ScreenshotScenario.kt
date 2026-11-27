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
import android.view.WindowInsets
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
    fun workflowButtonsAndWindowInsets() {
        val originalSize = displayOverride("size", "\\d+x\\d+")
        val originalDensity = displayOverride("density", "\\d+")
        val originalScale = device.executeShellCommand("settings get system font_scale").trim()
        try {
            withWindow(null, null, 1f, UserPreferencesTheme.LIGHT) { fixture, scenario ->
                openDirectory()
                action(fixture.releaseTitle).click()
                text("工作流说明")
                checkUseInset(scenario, "original")
                ScreenshotCapture.capture("original-window-detail.png")
            }
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

    private fun capturePhone(fixture: WorkflowApiFixture, scenario: ActivityScenario<MainActivity>) {
        openDirectory()
        assertTrue(action("新建").visibleBounds.height() >= 48)
        ScreenshotCapture.capture("phone-directory.png")
        action(fixture.releaseTitle).click()
        text("工作流说明")
        val footer = checkUseInset(scenario, "phone")
        assertEquals(20, footer.left)
        assertEquals(392, footer.right)
        ScreenshotCapture.capture("phone-detail.png")
        tab("自动化").click()
        assertTrue(action("添加自动化").visibleBounds.height() >= 48)
        ScreenshotCapture.capture("phone-automations.png")
        tab("说明").click()
        captureEditor(fixture, "phone")
    }

    private fun captureWide(fixture: WorkflowApiFixture, scenario: ActivityScenario<MainActivity>) {
        openDirectory()
        action(fixture.releaseTitle).click()
        text("工作流说明")
        val footer = checkUseInset(scenario, "wide")
        assertTrue(footer.right > 1000)
        ScreenshotCapture.capture("wide-detail.png")
        captureEditor(fixture, "wide")
    }

    private fun checkUseInset(scenario: ActivityScenario<MainActivity>, label: String): android.graphics.Rect {
        val use = action("在聊天中使用").visibleBounds
        var navigationTop = 0
        scenario.onActivity { activity ->
            val window = activity.windowManager.currentWindowMetrics.bounds
            val insets = checkNotNull(activity.window.decorView.rootWindowInsets)
            navigationTop = window.bottom - insets.getInsets(WindowInsets.Type.navigationBars()).bottom
        }
        val sys = device.findObject(By.res("com.android.systemui", "navigation_bar_frame"))
        TestStorage().openOutputFile("workflow-insets-$label.txt").bufferedWriter().use {
            it.write("button=$use, insetTop=$navigationTop, systemBar=${sys?.visibleBounds}")
        }
        assertTrue(use.bottom <= navigationTop)
        assertTrue(use.height() >= 48)
        return use
    }

    private fun captureEditor(fixture: WorkflowApiFixture, prefix: String) {
        action("编辑说明").click()
        node(By.clazz("android.widget.EditText").desc("用途")).text = "重新核对上线资料"
        val save = action("保存")
        assertTrue(save.isEnabled)
        val before = save.visibleBounds
        ScreenshotCapture.capture("$prefix-editor.png")
        withReadHeld({ fixture.beforeInstructionSave = it }) {
            save.click()
            val pending = ancestor(node(By.desc("保存"))) { !it.isEnabled }
            assertEquals(before, pending.visibleBounds)
            ScreenshotCapture.capture("$prefix-editor-saving.png")
        }
        action("编辑说明")
        text("重新核对上线资料")
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
        width: Int?,
        height: Int?,
        scale: Float,
        theme: UserPreferencesTheme,
        capture: (WorkflowApiFixture, ActivityScenario<MainActivity>) -> Unit,
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
                if (width != null && height != null)
                    device.executeShellCommand("wm size ${width}x${height}")
                device.executeShellCommand("settings put system font_scale $scale")
                app.chatService = fixture.service
                app.composerService = fixture.service
                app.workflows = fixture.service
                app.restoreApiPreferences(emptyMap())
                app.initialPreferences =
                    testPreferences()
                        .copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = theme,
                            timezone = "Asia/Shanghai",
                        )
                auth.state.value =
                    testAuthenticationState(
                        user = "user-a",
                        session = "workflow-loading-${UUID.randomUUID()}",
                    )
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    try {
                        scenario.onActivity { activity ->
                            val config = activity.resources.configuration
                            if (width != null) {
                                assertEquals(width, config.screenWidthDp)
                                assertEquals(160, config.densityDpi)
                            }
                            assertEquals(scale, config.fontScale, .001f)
                        }
                        capture(fixture, scenario)
                    } catch (failure: Throwable) {
                        runCatching {
                            TestStorage()
                                .openOutputFile("workflow-failure-${width}.xml")
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
            .find(device.executeShellCommand("wm $setting"))
            ?.groupValues
            ?.get(1)

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
