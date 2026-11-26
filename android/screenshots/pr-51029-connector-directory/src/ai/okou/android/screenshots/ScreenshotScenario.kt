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
import androidx.appcompat.app.AppCompatDelegate
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun phoneDirectoryKeepsSearchAndCategoryAcrossTabsAndBack() =
        onDevice("connector-directory-phone", 412, 892) {
            openDirectoryWithAccountStatus()
            val calendar = action("Google Calendar")
            val gmail = action("Gmail")
            val slack = action("Slack")
            check(calendar.visibleBounds.top < gmail.visibleBounds.top)
            check(gmail.visibleBounds.top < slack.visibleBounds.top)
            check(text("推荐").accessibilityNodeInfo.isHeading)
            check(!device.hasObject(By.text("Google Drive")))
            val discover = checkNotNull(text("发现").parent)
            val connected = action("已连接")
            check(discover.isSelected)
            check(discover.visibleBounds.height() == 48)
            check(connected.visibleBounds.height() == 48)
            check(discover.visibleBounds.width() == connected.visibleBounds.width())
            val filterBounds = actionByDescription("筛选服务类别").visibleBounds
            check(filterBounds.width() == 48 && filterBounds.height() == 48)
            capture("phone-connectors-discover.png")

            search("Drive")
            action("Google Drive")
            gone("推荐")
            selectCategory("文档与文件")
            action("Google Drive")
            action("已连接").click()
            text("没有匹配的连接器")
            check(searchField().text == "Drive")
            assertCategory("文档与文件")

            selectCategory("会议与日程")
            search("team@example.com")
            action("Google Calendar")
            check(checkNotNull(text("已连接").parent).isSelected)
            assertCategory("会议与日程")
            gone("Slack")
            action("发现").click()
            text("没有匹配的连接器")
            check(searchField().text == "team@example.com")
            assertCategory("会议与日程")
            action("已连接").click()
            action("Google Calendar").click()
            text("协作日历")
            text("team@example.com")
            text("需要更新权限")
            device.pressBack()
            action("Google Calendar")
            check(searchField().text == "team@example.com")
            check(checkNotNull(text("已连接").parent).isSelected)
            assertCategory("会议与日程")
            capture("phone-connectors-connected.png")
        }

    @Test
    fun wideDirectoryShowsDetailsAndSelectedAccount() =
        onDevice("connector-directory-wide", 1180, 820) {
            description("连接器").click()
            val directoryEdge = action("已连接").visibleBounds.right
            action("Google Calendar").click()
            check(text("推荐").visibleBounds.right <= directoryEdge)
            check(action("协作日历").visibleBounds.left > directoryEdge)
            text("calendar@example.com")
            text("team@example.com")
            text("需要更新权限")
            action("添加账号")
            action("服务可申请的权限")
            capture("wide-connectors-detail.png")
            action("协作日历").click()
            action("更新权限")
            capture("wide-connector-account.png")
        }

    @Test
    fun phoneDirectoryShowsTheSharedFirstReadFailure() =
        onDevice("connector-directory-first-read", 412, 892) { fixture ->
            fixture.discoveryRetryAfterSeconds = 0
            fixture.failDiscovery = true
            description("连接器").click()
            val error = text("暂时无法加载").visibleBounds
            check(kotlin.math.abs(error.centerX() - device.displayWidth / 2) <= 1)
            check(checkNotNull(text("发现").parent).isSelected)
            action("已连接")
            actionByDescription("筛选服务类别")
            gone("Google Calendar")
            capture("phone-connectors-first-read-failed.png")
        }

    @Test
    fun phoneDirectoryShowsRefreshFeedbackOverTheSameRows() =
        onDevice("connector-directory-refresh", 412, 892) { fixture ->
            openDirectoryWithAccountStatus()
            val row = action("Google Calendar").visibleBounds
            fixture.discoveryRetryAfterSeconds = 0
            fixture.failDiscovery = true
            resume()
            val feedback = text("暂时无法刷新连接器。").visibleBounds
            check(feedback.top > row.bottom)
            check(action("Google Calendar").visibleBounds == row)
            check(checkNotNull(text("发现").parent).isSelected)
            capture("phone-connectors-refresh-failed.png")
            fixture.failDiscovery = false
            resume()
            gone("暂时无法刷新连接器。")
            check(action("Google Calendar").visibleBounds == row)
        }

    @Test
    fun phonePermissionFeedbackKeepsTheCloseActionVisible() =
        onDevice("connector-permission-refresh", 412, 892) { fixture ->
            description("连接器").click()
            action("Google Calendar").click()
            action("服务可申请的权限").click()
            val permissionBounds = text("读取日历与日程").visibleBounds
            val closeBounds = action("关闭").visibleBounds
            fixture.failPermissionReads = true
            resume()
            val notice = text("暂时无法刷新连接器。").visibleBounds
            check(notice.bottom < closeBounds.top)
            check(action("关闭").visibleBounds == closeBounds)
            check(text("读取日历与日程").visibleBounds == permissionBounds)
            capture("phone-connector-permission-refresh.png")
            action("关闭").click()
            action("服务可申请的权限")
        }

    private class Controls(
        val device: UiDevice,
        private val app: TestOkouApplication,
        private val activity: ActivityScenario<MainActivity>,
    ) {
        fun text(label: String): UiObject2 =
            checkNotNull(device.wait(Until.findObject(By.pkg(app.packageName).text(label)), 12_000)) {
                "Missing text $label"
            }

        fun description(label: String): UiObject2 =
            checkNotNull(device.wait(Until.findObject(By.pkg(app.packageName).desc(label)), 12_000)) {
                "Missing description $label"
            }

        fun action(label: String): UiObject2 =
            checkNotNull(device.wait(object : Condition<UiDevice, UiObject2?> {
                override fun apply(device: UiDevice): UiObject2? =
                    device.findObjects(By.pkg(app.packageName).text(label)).firstNotNullOfOrNull { node ->
                        try {
                            generateSequence(node) { it.parent }.firstOrNull { it.isClickable }
                                ?.takeIf { it.isEnabled }
                        } catch (_: StaleObjectException) {
                            null
                        }
                    }
            }, 12_000)) { "Missing enabled action $label" }

        fun actionByDescription(label: String): UiObject2 =
            checkNotNull(generateSequence(description(label)) { it.parent }.firstOrNull {
                it.isClickable && it.isEnabled
            }) { "Missing enabled action with description $label" }

        fun selectCategory(label: String) {
            actionByDescription("筛选服务类别").click()
            action(label).click()
            assertCategory(label)
        }

        fun assertCategory(label: String) {
            check(
                generateSequence(description("筛选服务类别")) { it.parent }.any {
                    it.accessibilityNodeInfo.stateDescription?.toString() == label
                },
            ) { "Expected selected category: $label" }
        }

        fun gone(label: String) {
            check(device.wait(Until.gone(By.pkg(app.packageName).text(label)), 12_000)) {
                "Expected $label to disappear"
            }
        }

        fun openDirectoryWithAccountStatus() {
            description("连接器").click()
            text("需要重新授权")
            action("Google Calendar").click()
            text("需要更新权限")
            device.pressBack()
            text("1 个账号可用 · 有账号需要处理")
        }

        fun searchField(): UiObject2 =
            checkNotNull(
                device.wait(Until.findObject(By.pkg(app.packageName).clazz("android.widget.EditText")), 12_000),
            ) { "Missing connector search editor" }

        fun search(value: String) {
            searchField().setText(value)
            text(value)
        }

        fun resume() {
            activity.moveToState(Lifecycle.State.CREATED)
            activity.moveToState(Lifecycle.State.RESUMED)
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
        exercise: Controls.(ConnectorApiFixture) -> Unit,
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
                ConnectorApiFixture().use { connector ->
                    try {
                        connector.icons = connectorDesignIcons
                        connector.omittedFromDefaultBrowse = setOf("google-drive")
                        device.executeShellCommand("wm size ${width}x$height")
                        device.executeShellCommand("wm density 160")
                        device.executeShellCommand("settings put system font_scale 1")
                        app.connectorService = connector.service
                        app.chatService = composer.service
                        app.composerService = composer.service
                        app.workflows = workflow.service
                        val user = "connector-v376-${UUID.randomUUID()}"
                        app.restoreApiPreferences(
                            oldPreferences + (Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                                testPreferences().copy(
                                    locale = UserPreferencesLocale.ZH_HANS,
                                    theme = UserPreferencesTheme.LIGHT,
                                )),
                        )
                        authentication.state.value = testAuthenticationState(user = user)
                        ActivityScenario.launch(MainActivity::class.java).use { activity ->
                            try {
                                assertTrue(device.wait(object : Condition<UiDevice, Boolean> {
                                    override fun apply(device: UiDevice): Boolean =
                                        device.displayWidth == width && device.displayHeight == height &&
                                            app.resources.configuration.densityDpi == 160 &&
                                            app.resources.configuration.fontScale == 1f
                                }, 12_000))
                                Controls(device, app, activity).exercise(connector)
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
                        instrumentation.resetInTouchMode()
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
