package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.WorkspaceMembership
import ai.okou.android.awaitChatList
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val auth = app.authentication as TestAuthentication

    @Test
    fun capturesChooserPendingAndFailureFromSettings() {
        val previousSession = auth.state.value
        val previousMemberships = auth.available
        val activate = auth.selectAction
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val previousName = app.workspaceDisplayName
        val previousPrefs = app.snapshotApiPreferences()
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocale = localeManager.applicationLocales
        val previousSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1) ?: "reset"
        val reject = CompletableDeferred<Unit>()
        ChatListApiFixture().use { api ->
            try {
                DefaultModelApiFixture(api).selectAutoElsewhere()
                auth.available =
                    listOf(
                        WorkspaceMembership("org-a", "我的空间", "org:member"),
                        WorkspaceMembership("org-b", "团队空间", "org:member"),
                    )
                auth.selectAction = { _, _ ->
                    reject.await()
                    error("Fixture rejected workspace activation")
                }
                val user = "workspace-screenshot-${UUID.randomUUID()}"
                auth.state.value = testAuthenticationState(user = user)
                app.chatService = api.service
                app.recoveryService = api.service
                app.workspaceDisplayName = "我的空间"
                val preferences =
                    testPreferences()
                        .copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = UserPreferencesTheme.LIGHT,
                            timezone = "Asia/Shanghai",
                        )
                app.restoreApiPreferences(
                    listOf("org-a", "org-b").associate {
                        Triple(BuildConfig.API_ORIGIN, user, it) to preferences
                    },
                )
                device.executeShellCommand("wm size 1080x2340")
                ActivityScenario.launch(MainActivity::class.java).use {
                    device.awaitChatList(app)
                    val settings = app.getString(R.string.settings)
                    val direct = device.findObject(By.pkg(app.packageName).desc(settings))
                    if (direct != null) direct.click()
                    else {
                        await(
                                By.pkg(app.packageName)
                                    .desc(app.getString(R.string.chat_more_actions)),
                            )
                            .click()
                        click(text(settings))
                    }
                    val current = text("我的空间")
                    ScreenshotCapture.capture("00-settings.png")
                    click(current)
                    val target = text("团队空间")
                    ScreenshotCapture.capture("01-workspace-chooser.png")
                    click(target)
                    await(By.pkg(app.packageName).descContains("正在切换工作区"))
                    ScreenshotCapture.capture("02-workspace-switching.png")
                    reject.complete(Unit)
                    text("暂时无法切换到此工作区")
                    ScreenshotCapture.capture("03-workspace-switch-failed.png")
                    auth.selectAction = activate
                    click(text("团队空间"))
                    device.awaitChatList(app)
                    check(auth.state.value.session?.workspaceId == "org-b")
                }
            } finally {
                reject.complete(Unit)
                auth.state.value = previousSession
                auth.available = previousMemberships
                auth.selectAction = activate
                app.chatService = previousChat
                app.recoveryService = previousRecovery
                app.workspaceDisplayName = previousName
                app.restoreApiPreferences(previousPrefs)
                localeManager.applicationLocales = previousLocale
                device.executeShellCommand("wm size $previousSize")
            }
        }
    }

    private fun text(label: String) = await(By.pkg(app.packageName).text(label))

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing ${selector}" }

    private fun click(view: UiObject2) {
        generateSequence(view) { it.parent }.first { it.isClickable }.click()
    }
}
