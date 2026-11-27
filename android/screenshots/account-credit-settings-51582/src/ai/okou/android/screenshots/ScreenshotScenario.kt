package ai.okou.android.screenshots

import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.SettingsApiFixture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.OrganizationRole
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.awaitChatList
import ai.okou.android.jsonResponse
import ai.okou.android.openChatListSettings
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.os.LocaleList
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app =
        InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
            as TestOkouApplication

    @Test
    fun modelAccountsAndUnconfirmedSwitch() = withSettings { api, fixture, open ->
        fixture.activationStatus = 500
        val existing = api.commandResponse
        api.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == accountsPath && fixture.activations.isNotEmpty()) {
                jsonResponse("""{"error":{"code":"BAD_REQUEST","message":"Read unavailable"}}""")
                    .setResponseCode(400)
            } else existing(request)
        }
        open(R.string.settings_model_accounts)
        await(text("personal@example.com"))
        await(text("work@example.com"))
        await(label(R.string.settings_account_current))
        capture("01-model-accounts.png")

        reveal(text("work@example.com")).click()
        val notice = label(R.string.settings_account_switch_failed)
        await(notice)
        await(label(R.string.settings_account_current))
        check(device.findObjects(notice).size == 1)
        check(!device.hasObject(label(R.string.settings_accounts_update_failed)))
        check(fixture.activations == listOf(SettingsApiFixture.alternateAccount))
        capture("02-model-account-switch-unconfirmed.png")
    }

    @Test
    fun modelAccountEmptyCard() = withSettings { api, _, open ->
        val existing = api.commandResponse
        api.commandResponse = { request ->
            if (request.requestUrl?.encodedPath == accountsPath) {
                jsonResponse("""{"subscriptions":[]}""")
            } else existing(request)
        }
        open(R.string.settings_model_accounts)
        await(label(R.string.settings_accounts_empty))
        await(label(R.string.settings_accounts_empty_help))
        await(label(R.string.settings_accounts_web_connect))
        capture("03-model-accounts-empty.png")
    }

    @Test
    fun scopedCreditBalance() = withSettings { _, _, open ->
        open(R.string.settings_credit_balance)
        await(label(R.string.settings_credit_member))
        await(label(R.string.settings_credit_workspace))
        await(text("860"))
        await(text("2,400"))
        reveal(label(R.string.settings_credit_web))
        capture("04-credit-balance.png")
    }

    private fun withSettings(
        scenario: (ChatListApiFixture, SettingsApiFixture, (Int) -> Unit) -> Unit,
    ) {
        val auth = app.authentication as TestAuthentication
        val locale = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocale = locale.applicationLocales
        val previousSession = auth.state.value
        val previousAccount = auth.account.value
        val previousMemberships = auth.available
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val previousRole = app.workspaceRole
        val previousPreferences = app.initialPreferences
        val apiPreferences = app.snapshotApiPreferences()
        ChatListApiFixture().use { api ->
            val fixture = SettingsApiFixture(api)
            try {
                val user = "account-settings-${UUID.randomUUID()}"
                app.chatService = api.service
                app.recoveryService = api.service
                app.workspaceRole = OrganizationRole.ADMIN
                auth.available = previousMemberships.map {
                    if (it.id == "org-a") it.copy(role = "org:admin") else it
                }
                app.initialPreferences =
                    testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                    )
                locale.applicationLocales = LocaleList.forLanguageTags("zh-Hans")
                auth.account.value = NativeAccount(user, "account@example.com")
                auth.state.value = testAuthenticationState(user = user)
                ActivityScenario.launch(MainActivity::class.java).use {
                    device.awaitChatList(app)
                    scenario(api, fixture) { destination ->
                        device.openChatListSettings(app)
                        reveal(label(destination)).click()
                    }
                }
            } finally {
                locale.applicationLocales = previousLocale
                auth.state.value = previousSession
                auth.account.value = previousAccount
                auth.available = previousMemberships
                app.chatService = previousChat
                app.recoveryService = previousRecovery
                app.workspaceRole = previousRole
                app.initialPreferences = previousPreferences
                app.restoreApiPreferences(apiPreferences)
            }
        }
    }

    private fun capture(file: String) {
        device.waitForIdle()
        ScreenshotCapture.capture(file)
    }

    private fun label(id: Int) = text(app.getString(id))

    private fun text(label: String) = By.pkg(app.packageName).text(label)

    private fun reveal(selector: BySelector): UiObject2 {
        if (!device.hasObject(selector)) {
            val body = await(By.pkg(app.packageName).scrollable(true))
            body.scrollUntil(Direction.DOWN, Until.findObject(selector))
        }
        return await(selector)
    }

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Expected ${selector}" }

    private companion object {
        const val accountsPath = "/api/me/3rd-party-subscriptions"
    }
}
