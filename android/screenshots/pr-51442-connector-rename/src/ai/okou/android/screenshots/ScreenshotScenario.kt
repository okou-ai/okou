package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ComposerApiFixture
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
import android.accessibilityservice.AccessibilityServiceInfo
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.platform.app.InstrumentationRegistry
import androidx.appcompat.app.AppCompatDelegate
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun phoneRetainsTheFocusedDraft() = onDevice("phone-rename", 412, 892) { scenario, connector ->
        beginRename()
        capture("phone-connector-rename.png")
        textField().click()
        textField().setText("团队协作日历")
        selectRange(2, 4)
        scenario.recreate()
        action("保存")
        check(textField().text == "团队协作日历")
        awaitSelection(2, 4)
        capture("phone-connector-rename-restored.png")

        action("取消").click()
        action("重命名").click()
        check(textField().text == "工作日历")
        check(connector.renameRequests.get() == 0)
    }

    @Test
    fun wideKeepsOneInFlightSave() = onDevice("wide-rename", 1180, 820) { scenario, connector ->
        beginRename()
        textField().setText("跨团队日历")
        capture("wide-connector-rename.png")
        val reply = CountDownLatch(1)
        connector.renameReplyGate = reply
        try {
            action("保存").click()
            text("正在保存…")
            scenario.recreate()
            text("正在保存…")
            check(textField().text == "跨团队日历")
        } finally {
            reply.countDown()
        }
        action("重命名")
        text("跨团队日历")
        check(connector.renameRequests.get() == 1)
        capture("wide-connector-account-confirmed.png")
    }

    @Test
    fun shortRetainsValidationAndKeepsItsActionsReachable() =
        onDevice("short-rename", 820, 440) { scenario, connector ->
            beginRename()
            textField().setText("   ")
            text("请输入账号名称。")
            scenario.recreate()
            text("请输入账号名称。")
            action("取消")
            capture("short-connector-rename-validation.png")

            awaitEditable()
            textField().setText("团队日历")
            action("保存").click()
            action("重命名")
            text("团队日历")
            check(connector.renameRequests.get() == 1)
        }

    private class Controls(val device: UiDevice, private val app: TestOkouApplication) {
        private fun find(selector: BySelector, label: String): UiObject2 =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $label" }

        fun text(label: String) = find(By.pkg(app.packageName).text(label), label)

        fun description(label: String) = find(By.pkg(app.packageName).desc(label), label)

        fun action(label: String, enabled: Boolean = true): UiObject2 =
            checkNotNull(device.wait(object : Condition<UiDevice, UiObject2?> {
                override fun apply(device: UiDevice): UiObject2? =
                    device.findObjects(By.pkg(app.packageName).text(label)).firstNotNullOfOrNull { node ->
                        try {
                            generateSequence(node) { it.parent }.firstOrNull { it.isClickable }
                                ?.takeIf { it.isEnabled == enabled }
                        } catch (_: StaleObjectException) {
                            null
                        }
                    }
            }, 12_000)) { "Missing action $label with enabled=$enabled" }

        fun textField(): UiObject2 =
            find(By.pkg(app.packageName).clazz("android.widget.EditText"), "text field")

        fun beginRename() {
            description("连接器").click()
            action("Google Calendar").click()
            action("工作日历").click()
            action("重命名").click()
            text("重命名账号")
            action("取消")
        }

        fun selectRange(start: Int, end: Int) {
            val arguments = Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start)
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end)
            }
            check(editableNode(requireFocus = true)?.performAction(
                AccessibilityNodeInfo.ACTION_SET_SELECTION,
                arguments,
            ) == true)
            awaitSelection(start, end)
        }

        fun awaitSelection(start: Int, end: Int) {
            var observed = "no focused editable node"
            check(device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean {
                    val field = editableNode(requireFocus = true) ?: return false
                    observed = "${field.textSelectionStart}..${field.textSelectionEnd}"
                    return field.textSelectionStart == start && field.textSelectionEnd == end
                }
            }, 12_000)) { "Expected focused selection $start..$end, observed $observed" }
        }

        fun awaitEditable() {
            check(device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean = editableNode() != null
            }, 12_000)) { "Expected writable account name" }
        }

        private fun editableNode(requireFocus: Boolean = false): AccessibilityNodeInfo? {
            val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
            val info = automation.serviceInfo
            val retrieveWindows = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            if (info.flags and retrieveWindows == 0) {
                info.flags = info.flags or retrieveWindows
                automation.serviceInfo = info
            }
            return editableChild(automation.rootInActiveWindow, requireFocus)
                ?: automation.windows.firstNotNullOfOrNull { editableChild(it.root, requireFocus) }
        }

        private fun editableChild(
            node: AccessibilityNodeInfo?,
            requireFocus: Boolean,
        ): AccessibilityNodeInfo? {
            if (node == null) return null
            if (node.packageName == app.packageName && node.isEditable &&
                (!requireFocus || node.isFocused)
            ) return node
            for (index in 0 until node.childCount) {
                editableChild(node.getChild(index), requireFocus)?.let { return it }
            }
            return null
        }

        fun capture(name: String) {
            device.waitForIdle()
            ScreenshotCapture.capture(name)
        }
    }

    private fun onDevice(
        scene: String,
        width: Int,
        height: Int,
        exercise: Controls.(ActivityScenario<MainActivity>, ConnectorApiFixture) -> Unit,
    ) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val oldConnectors = app.connectorService
        val oldChat = app.chatService
        val oldComposer = app.composerService
        val oldWorkflows = app.workflows
        val oldPreferences = app.snapshotApiPreferences()
        val oldLocales = AppCompatDelegate.getApplicationLocales()
        val authentication = app.authentication as TestAuthentication
        val oldAuthentication = authentication.state.value
        val size = overrideValue("size", device.executeShellCommand("wm size"))
        val density = overrideValue("density", device.executeShellCommand("wm density"))
        val font = device.executeShellCommand("settings get system font_scale").trim()
        ComposerApiFixture().use { composer ->
            WorkflowApiFixture(chinese = true).use { workflow ->
                ConnectorApiFixture(includeGrantExamples = true).use { connector ->
                    try {
                        device.executeShellCommand("wm size ${width}x$height")
                        device.executeShellCommand("wm density 160")
                        device.executeShellCommand("settings put system font_scale 1")
                        app.connectorService = connector.service
                        app.chatService = composer.service
                        app.composerService = composer.service
                        app.workflows = workflow.service
                        val user = "connector-rename-${UUID.randomUUID()}"
                        app.restoreApiPreferences(
                            oldPreferences + (Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                                testPreferences().copy(
                                    locale = UserPreferencesLocale.ZH_HANS,
                                    theme = UserPreferencesTheme.LIGHT,
                                )),
                        )
                        authentication.state.value = testAuthenticationState(user = user)
                        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                            try {
                                assertTrue(device.wait(object : Condition<UiDevice, Boolean> {
                                    override fun apply(device: UiDevice): Boolean =
                                        device.displayWidth == width && device.displayHeight == height &&
                                            app.resources.configuration.densityDpi == 160 &&
                                            app.resources.configuration.fontScale == 1f
                                }, 12_000))
                                Controls(device, app).exercise(scenario, connector)
                            } catch (error: Throwable) {
                                try {
                                    ScreenshotCapture.capture("failure-$scene.png")
                                    TestStorage().openOutputFile("failure-$scene-window.xml")
                                        .use(device::dumpWindowHierarchy)
                                } catch (diagnostic: Throwable) {
                                    error.addSuppressed(diagnostic)
                                }
                                throw error
                            }
                        }
                    } finally {
                        app.connectorService = oldConnectors
                        app.chatService = oldChat
                        app.composerService = oldComposer
                        app.workflows = oldWorkflows
                        app.restoreApiPreferences(oldPreferences)
                        authentication.state.value = oldAuthentication
                        instrumentation.runOnMainSync { AppCompatDelegate.setApplicationLocales(oldLocales) }
                        device.executeShellCommand("wm size ${size ?: "reset"}")
                        device.executeShellCommand("wm density ${density ?: "reset"}")
                        if (font == "null") device.executeShellCommand("settings delete system font_scale")
                        else device.executeShellCommand("settings put system font_scale $font")
                    }
                }
            }
        }
    }

    private fun overrideValue(kind: String, output: String): String? =
        Regex("Override $kind: ([0-9x]+)").find(output)?.groupValues?.get(1)
}
