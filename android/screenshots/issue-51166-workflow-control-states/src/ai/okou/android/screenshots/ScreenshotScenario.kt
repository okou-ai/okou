package ai.okou.android.screenshots

import ai.okou.android.ConnectorApiFixture
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
    fun workflowLoadingAndPendingControls() {
        val originalSize = displayOverride("size", "\\d+x\\d+")
        val originalDensity = displayOverride("density", "\\d+")
        val originalScale = device.executeShellCommand("settings get system font_scale").trim()
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            withWindow(412, 892, UserPreferencesTheme.LIGHT, ::capturePhone)
            withWindow(1180, 820, UserPreferencesTheme.DARK, ::captureWide)
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
        val release = CountDownLatch(1)
        fixture.beforeReleaseDetailRead = { release.await() }
        val pendingBounds = try {
            action(fixture.releaseTitle).click()
            node(By.desc("工作流"))
            disabledControl(text("在聊天中使用")).visibleBounds.also { bounds ->
                assertTrue(bounds.height() >= 48)
                assertEquals(20, bounds.left)
                ScreenshotCapture.capture("workflow-phone-loading.png")
            }
        } catch (failure: Throwable) {
            captureFailure("phone-loading-failure")
            throw failure
        } finally {
            release.countDown()
        }
        text("工作流说明")
        val tabs = listOf("说明", "自动化", "运行记录").map { tab(it).visibleBounds }
        assertTrue(tabs.all { it.height() >= 48 })
        assertTrue(tabs.maxOf { it.width() } - tabs.minOf { it.width() } <= 1)
        assertEquals(pendingBounds, action("在聊天中使用").visibleBounds)
        ScreenshotCapture.capture("workflow-phone-detail.png")
    }

    private fun captureWide(fixture: WorkflowApiFixture) {
        openDirectory()
        action("仅自己").click()
        action(fixture.releaseTitle).click()
        tab("自动化").click()
        text("触发规则")
        text("已启用")
        val pause = action("暂停")
        val pauseBounds = pause.visibleBounds
        assertTrue(pauseBounds.height() >= 48)
        ScreenshotCapture.capture("workflow-wide-automations.png")

        val release = CountDownLatch(1)
        fixture.beforeWeekdayToggle = { release.await() }
        try {
            pause.click()
            val pending = disabledControl(node(By.desc("暂停")))
            assertEquals(pauseBounds, pending.visibleBounds)
            text("已启用")
            assertTrue(fixture.active.get())
            ScreenshotCapture.capture("workflow-wide-pausing.png")
        } catch (failure: Throwable) {
            captureFailure("wide-pausing-failure")
            throw failure
        } finally {
            release.countDown()
        }
        text("已暂停")
        action("启用")
        action("添加自动化").click()
        text("执行频率")
        assertTrue(action("工作日").visibleBounds.height() >= 56)
        assertTrue(action("保存").visibleBounds.height() >= 48)
        disabledControl(node(By.desc("搜索工作流")))
        ScreenshotCapture.capture("workflow-wide-editor.png")
        action("取消").click()
        text("触发规则")
        assertTrue(searchInput().isEnabled)
    }

    private fun withWindow(
        width: Int,
        height: Int,
        theme: UserPreferencesTheme,
        capture: (WorkflowApiFixture) -> Unit,
    ) {
        WorkflowApiFixture(chinese = true).use { fixture ->
            ConnectorApiFixture().use { connectors ->
                val originalPreferences = app.initialPreferences
                val originalPreferenceData = app.snapshotApiPreferences()
                val auth = app.authentication as TestAuthentication
                val originalAuth = auth.state.value
                val originalChats = app.chatService
                val originalComposer = app.composerService
                val originalFlows = app.workflows
                val originalConnectors = app.connectorService
                try {
                    fixture.active.set(true)
                    app.chatService = fixture.service
                    app.composerService = fixture.service
                    app.workflows = fixture.service
                    app.connectorService = connectors.service
                    app.restoreApiPreferences(emptyMap())
                    app.initialPreferences =
                        testPreferences().copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = theme,
                            timezone = "Asia/Shanghai",
                        )
                    auth.state.value = testAuthenticationState(
                        user = "user-a",
                        session = "workflow-controls-${UUID.randomUUID()}",
                    )
                    device.executeShellCommand("wm size ${width}x${height}")
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        try {
                            scenario.onActivity {
                                assertEquals(width, it.resources.configuration.screenWidthDp)
                                assertEquals(160, it.resources.configuration.densityDpi)
                                assertEquals(1f, it.resources.configuration.fontScale, .001f)
                            }
                            capture(fixture)
                        } catch (failure: Throwable) {
                            captureFailure("capture-failure")
                            throw failure
                        }
                    }
                } finally {
                    app.chatService = originalChats
                    app.composerService = originalComposer
                    app.workflows = originalFlows
                    app.connectorService = originalConnectors
                    auth.state.value = originalAuth
                    app.initialPreferences = originalPreferences
                    app.restoreApiPreferences(originalPreferenceData)
                }
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

    private fun disabledControl(label: UiObject2): UiObject2 =
        checkNotNull(generateSequence(label) { it.parent }.firstOrNull { !it.isEnabled }) {
            "The labelled control is still enabled"
        }

    private fun searchInput(): UiObject2 =
        checkNotNull(
            generateSequence(node(By.desc("搜索工作流"))) { it.parent }
                .firstOrNull { it.className == "android.widget.EditText" },
        ) { "Missing workflow search input" }

    private fun captureFailure(name: String) {
        runCatching {
            TestStorage().openOutputFile("$name.xml").use(device::dumpWindowHierarchy)
        }
        runCatching { ScreenshotCapture.capture("$name.png") }
    }

    private fun tab(label: String): UiObject2 =
        checkNotNull(generateSequence(text(label)) { it.parent }.firstOrNull { it.isFocusable }) {
            "Missing workflow tab $label"
        }

    private fun action(label: String): UiObject2 =
        checkNotNull(generateSequence(text(label)) { it.parent }.firstOrNull { it.isClickable }) {
            "Missing workflow action $label"
        }
}
