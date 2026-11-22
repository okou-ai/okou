package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.BuildConfig
import ai.okou.android.CONNECTOR_CALENDAR_SECONDARY
import ai.okou.android.ChatListApiFixture
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
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
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun builtInConnectorDirectoryAndAccountManagement() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val previousService = app.connectorService
        val previousChats = app.chatService
        val previousConnectivity = app.connectivity.value
        val preferences = app.snapshotApiPreferences()
        val previousLocales = AppCompatDelegate.getApplicationLocales()
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val size = device.executeShellCommand("wm size")
        val density = device.executeShellCommand("wm density")
        val previousFontScale = device.executeShellCommand("settings get system font_scale").trim()
        val previousSize = Regex("Override size: (\\d+x\\d+)").find(size)?.groupValues?.get(1)
        val previousDensity = Regex("Override density: (\\d+)").find(density)?.groupValues?.get(1)
        val releaseDirectory = CountDownLatch(1)

        fun text(label: String): UiObject2 =
            checkNotNull(
                device.wait(
                    Until.findObject(
                        By.pkg(app.packageName).clazz("android.widget.TextView").textContains(label)
                    ),
                    12_000,
                )
            ) {
                "Missing visible text: $label"
            }

        fun description(label: String): UiObject2 =
            checkNotNull(
                device.wait(Until.findObject(By.pkg(app.packageName).desc(label)), 12_000)
            ) {
                "Missing content description: $label"
            }

        fun defaultSwitch(checked: Boolean, enabled: Boolean = true): UiObject2 =
            checkNotNull(
                device.wait(
                    Until.findObject(
                        By.pkg(app.packageName)
                            .hasDescendant(By.text("默认启用"))
                            .checkable(true)
                            .checked(checked)
                            .enabled(enabled)
                    ),
                    12_000,
                )
            ) {
                "Missing default enablement control with checked=$checked enabled=$enabled"
            }

        fun awaitUncachedOfflineContent() {
            val packageName = app.packageName
            assertTrue(device.wait(Until.hasObject(By.pkg(packageName).text("联网后加载…")), 12_000))
            assertFalse(device.hasObject(By.pkg(packageName).text("离线")))
        }

        fun capture(name: String) {
            device.waitForIdle()
            ScreenshotCapture.capture(name)
        }

        fun click(label: String) {
            checkNotNull(
                    device.wait(
                        Until.findObject(By.pkg(app.packageName).enabled(true).text(label)),
                        12_000,
                    )
                ) {
                    "Missing enabled action: $label"
                }
                .click()
        }

        fun enter(label: String, value: String) {
            val editor =
                By.pkg(app.packageName)
                    .clazz("android.widget.EditText")
                    .hasDescendant(By.desc(label))
            checkNotNull(device.wait(Until.findObject(editor), 12_000)) { "Missing editor: $label" }
                .click()
            checkNotNull(device.wait(Until.findObject(editor.focused(true)), 12_000)) {
                    "Editor did not take focus: $label"
                }
                .text = value
            assertTrue(
                "Editor did not show the entered value: $label",
                device.wait(Until.hasObject(editor.text(value)), 12_000),
            )
        }

        fun search(keyword: String) {
            enter("搜索连接器", keyword)
            checkNotNull(
                    device.wait(
                        Until.findObject(By.pkg("com.android.inputmethod.latin").desc("Search")),
                        12_000,
                    )
                ) {
                    "Search action was not available on the emulator keyboard"
                }
                .click()
        }

        ChatListApiFixture().use { chatFixture ->
            ConnectorApiFixture().use { fixture ->
                val artifactFixture =
                    ArtifactApiFixture(chatFixture, chinese = true).also { it.install() }
                try {
                    device.executeShellCommand("wm size 412x892")
                    device.executeShellCommand("wm density 160")
                    fixture.discoveryGate = releaseDirectory
                    app.connectorService = fixture.service
                    app.chatService = chatFixture.service
                    val user = "connectors-${UUID.randomUUID()}"
                    app.restoreApiPreferences(
                        preferences +
                            (Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                                testPreferences()
                                    .copy(
                                        locale = UserPreferencesLocale.ZH_HANS,
                                        theme = UserPreferencesTheme.LIGHT,
                                    ))
                    )
                    auth.state.value = testAuthenticationState(user = user)
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        try {
                            text(artifactFixture.sourceTitle)
                            val connectorEntry =
                                checkNotNull(
                                    device.wait(
                                        Until.findObject(
                                            By.pkg(app.packageName).desc("连接器").enabled(true)
                                        ),
                                        12_000,
                                    )
                                )
                            val workflows = description("工作流")
                            val artifacts = description("成果")
                            assertFalse(workflows.isEnabled)
                            assertTrue(artifacts.isEnabled)
                            assertTrue(
                                workflows.visibleBounds.right <= connectorEntry.visibleBounds.left
                            )
                            assertTrue(
                                connectorEntry.visibleBounds.right <= artifacts.visibleBounds.left
                            )
                            capture("chat-list-connectors.png")
                            app.connectivity.value = false
                            text("离线")
                            description("连接器").click()
                            text("发现")
                            awaitUncachedOfflineContent()
                            assertFalse(device.hasObject(By.text("Google Calendar")))
                            capture("directory-uncached-offline.png")

                            app.connectivity.value = true
                            description("正在读取连接器…")
                            assertFalse(device.hasObject(By.text("Google Calendar")))
                            capture("directory-loading.png")
                            releaseDirectory.countDown()
                            text("Google Calendar")
                            text("需要重新授权")

                            app.connectivity.value = false
                            text("离线")
                            text("Gmail").click()
                            awaitUncachedOfflineContent()
                            assertFalse(device.hasObject(By.text("连接账号")))
                            capture("detail-accounts-uncached-offline.png")
                            app.connectivity.value = true
                            text("连接账号")
                            assertFalse(device.hasObject(By.text("联网后加载…")))

                            app.connectivity.value = false
                            text("联网后可以管理账号。")
                            capture("detail-cached-offline.png")
                            text("服务可申请的权限").click()
                            awaitUncachedOfflineContent()
                            capture("permissions-uncached-offline.png")
                            app.connectivity.value = true
                            text("读取日历与日程")
                            click("关闭")
                            description("返回").click()
                            text("需要重新授权")

                            // Load the precise scope state once before returning to the directory.
                            text("Google Calendar").click()
                            text("需要更新权限")
                            text("calendar@example.com").click()
                            defaultSwitch(checked = true)
                            capture("account-panel-phone.png")
                            device.pressBack()
                            text("服务可申请的权限")
                            description("返回").click()
                            text("有账号需要处理")
                            capture("discover.png")

                            checkNotNull(
                                    device.wait(
                                        Until.findObject(By.pkg(app.packageName).text("已连接")),
                                        12_000,
                                    )
                                )
                                .click()
                            text("Slack")
                            assertFalse(device.hasObject(By.text("Gmail")))
                            capture("connected.png")

                            search("team@example.com")
                            text("Google Calendar")
                            assertTrue(device.wait(Until.gone(By.text("Slack")), 12_000))
                            description("清除关键词").click()
                            text("发现").click()
                            description("筛选服务类别").click()
                            click("文档与文件")
                            text("Google Drive")
                            assertFalse(device.hasObject(By.text("Gmail")))
                            search("Gmail")
                            text("没有匹配的连接器")
                            description("清除关键词").click()
                            description("筛选服务类别").click()
                            click("不限类别")
                            text("推荐")
                            val globalSearchRequested = CountDownLatch(1)
                            fixture.discoveryRequested = globalSearchRequested
                            search("Google Drive")
                            assertTrue(
                                "Submitted directory search did not reach the catalog",
                                globalSearchRequested.await(10, TimeUnit.SECONDS),
                            )
                            text("Google Drive").click()
                            text("连接账号")
                            device.pressBack()
                            description("清除关键词")
                            text("Google Drive")
                            assertFalse(device.hasObject(By.text("Gmail")))
                            description("清除关键词").click()
                            text("Gmail").click()
                            text("连接账号").click()
                            text("前往服务方")
                            capture("authorization.png")
                            text("取消").click()
                            text("连接账号")
                            description("返回").click()
                            text("推荐")

                            device.executeShellCommand("wm size 1180x820")
                            text("选择连接器查看详情")
                            text("Google Calendar").click()
                            text("需要更新权限")
                            val directory = text("推荐").visibleBounds
                            val detail = text("服务可申请的权限").visibleBounds
                            assertTrue(directory.right < detail.left)
                            capture("wide-detail.png")

                            text("服务可申请的权限").click()
                            text("读取日历与日程")
                            capture("permissions.png")
                            text("关闭").click()

                            text("calendar@example.com").click()
                            val wideSwitch = defaultSwitch(checked = true).visibleBounds
                            assertEquals(device.displayWidth / 2, wideSwitch.centerX())
                            assertEquals(428, wideSwitch.width())
                            assertTrue(wideSwitch.bottom < device.displayHeight * 4 / 5)
                            capture("account-panel.png")
                            click("默认启用")
                            defaultSwitch(checked = false)
                            capture("account-panel-off.png")
                            app.connectivity.value = false
                            defaultSwitch(checked = false, enabled = false)
                            capture("account-panel-offline.png")
                            app.connectivity.value = true
                            defaultSwitch(checked = false)
                            click("重命名")
                            text("首尾空格会自动去除，最长 255 个字符。")
                            capture("rename.png")
                            enter("账号名称", "会议日历")
                            fixture.loseRenameReply = true
                            click("保存")
                            text("会议日历")
                            text("断开账号").click()
                            text("2 个聊天明确选择了此账号。")
                            capture("disconnect-confirmation.png")
                            text("取消").click()
                            text("默认启用")
                            text("断开账号").click()
                            text("断开此账号？")
                            text("2 个聊天明确选择了此账号。")
                            val buttons = device.findObjects(By.pkg(app.packageName).text("断开账号"))
                            checkNotNull(buttons.lastOrNull()).click()
                            assertTrue(device.wait(Until.gone(By.textContains("会议日历")), 12_000))
                            text("team@example.com")
                            text("添加账号")
                            app.connectivity.value = false
                            text("联网后可以管理账号。")
                            text("需要更新权限")
                            app.connectivity.value = true
                            text("team@example.com").click()
                            click("重命名")
                            text("重命名账号")
                            scenario.moveToState(Lifecycle.State.CREATED)
                            fixture.removeAccount(CONNECTOR_CALENDAR_SECONDARY)
                            scenario.moveToState(Lifecycle.State.RESUMED)
                            text("此账号已不可用。")
                            capture("account-removed.png")
                            click("关闭")
                            text("连接账号")

                            device.pressBack()
                            assertTrue(description("连接器").isEnabled)
                            assertFalse(description("工作流").isEnabled)
                            description("成果").click()
                            text(artifactFixture.checklist.title)
                            device.pressBack()
                            assertTrue(description("连接器").isEnabled)
                            assertTrue(description("成果").isEnabled)
                            text(artifactFixture.sourceTitle)
                            capture("chat-list-connectors-wide.png")

                            device.executeShellCommand("wm size 280x892")
                            device.executeShellCommand("settings put system font_scale 2.0")
                            assertTrue(
                                device.wait(
                                    object : Condition<UiDevice, Boolean> {
                                        override fun apply(device: UiDevice): Boolean {
                                            val config = app.resources.configuration
                                            val entry =
                                                device.findObject(
                                                    By.pkg(app.packageName).desc("连接器")
                                                )
                                            return config.screenWidthDp <= 280 &&
                                                config.fontScale == 2f &&
                                                (entry?.visibleBounds?.height() ?: 0) > 48
                                        }
                                    },
                                    12_000,
                                )
                            )
                            assertTrue(description("连接器").isEnabled)
                            text(artifactFixture.sourceTitle)
                            capture("chat-list-connectors-large-text.png")
                        } catch (error: Throwable) {
                            try {
                                ScreenshotCapture.capture("failure.png")
                                TestStorage()
                                    .openOutputFile("failure-window.xml")
                                    .use(device::dumpWindowHierarchy)
                            } catch (diagnostic: Throwable) {
                                error.addSuppressed(diagnostic)
                            }
                            throw error
                        }
                    }
                    ConnectorApiFixture().use { darkFixture ->
                        app.connectorService = darkFixture.service
                        val darkUser = "connectors-dark-${UUID.randomUUID()}"
                        app.restoreApiPreferences(
                            preferences +
                                (Triple(BuildConfig.API_ORIGIN, darkUser, "org-a") to
                                    testPreferences()
                                        .copy(
                                            locale = UserPreferencesLocale.ZH_HANS,
                                            theme = UserPreferencesTheme.DARK,
                                        ))
                        )
                        device.executeShellCommand("wm size 412x892")
                        device.executeShellCommand("settings put system font_scale 1.0")
                        auth.state.value = testAuthenticationState(user = darkUser)
                        ActivityScenario.launch(MainActivity::class.java).use {
                            text(artifactFixture.sourceTitle)
                            description("连接器").click()
                            text("Google Calendar").click()
                            text("calendar@example.com").click()
                            defaultSwitch(checked = true)
                            capture("account-panel-dark.png")
                            click("默认启用")
                            defaultSwitch(checked = false)
                            capture("account-panel-dark-off.png")
                        }
                    }
                } finally {
                    releaseDirectory.countDown()
                    app.connectorService = previousService
                    app.chatService = previousChats
                    app.connectivity.value = previousConnectivity
                    app.restoreApiPreferences(preferences)
                    auth.state.value = previousAuth
                    instrumentation.runOnMainSync {
                        AppCompatDelegate.setApplicationLocales(previousLocales)
                    }
                    device.executeShellCommand("wm size ${previousSize ?: "reset"}")
                    device.executeShellCommand("wm density ${previousDensity ?: "reset"}")
                    if (previousFontScale.toFloatOrNull() == null)
                        device.executeShellCommand("settings delete system font_scale")
                    else
                        device.executeShellCommand(
                            "settings put system font_scale $previousFontScale"
                        )
                }
            }
        }
    }
}
