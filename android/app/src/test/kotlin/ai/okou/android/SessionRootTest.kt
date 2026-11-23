package ai.okou.android

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ApplicationProvider
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = PendingAuthenticationApplication::class)
class SessionRootTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun pendingAuthenticationShowsBrandWithoutWorkspaceContentAcrossRecreation() {
        compose.onNodeWithText("Okou").assertExists()
        compose.onNodeWithTag("chat_list").assertDoesNotExist()
        compose.onNodeWithContentDescription("Settings").assertDoesNotExist()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Okou").assertExists()
        compose.onNodeWithTag("chat_list").assertDoesNotExist()
    }

    @Test
    fun keyboardCheckKeepsFocusAndBoundsWhilePendingAndAfterFailure() {
        val app = ApplicationProvider.getApplicationContext<TestOkouApplication>()
        val auth = app.authentication as TestAuthentication
        val previousState = auth.state.value
        val previousWorkspaces = auth.available
        val previousMemberships = auth.membershipsAction
        val response = CompletableDeferred<Unit>()
        val requests = AtomicInteger()
        val check = compose.onNodeWithText(app.getString(R.string.auth_check_workspace))
        val setup = compose.onNodeWithText(app.getString(R.string.auth_workspace_setup))
        val signOut = compose.onNodeWithText(app.getString(R.string.auth_sign_out))
        try {
            compose.runOnIdle {
                auth.available = emptyList()
                auth.state.value = testAuthenticationState(workspace = null)
            }
            compose.waitUntilExactlyOneExists(
                hasText(app.getString(R.string.auth_no_workspace)),
                5_000,
            )
            compose.runOnIdle {
                auth.membershipsAction = {
                    requests.incrementAndGet()
                    response.await()
                    error("Workspace check failed")
                }
            }
            check.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
            val bounds = check.getUnclippedBoundsInRoot()
            check.performKeyInput { pressKey(Key.Enter) }
            compose.waitUntil(5_000) { requests.get() > 0 }

            check.assertIsFocused().assertIsNotEnabled()
            assertEquals(bounds, check.getUnclippedBoundsInRoot())
            setup.assertIsEnabled()
            signOut.assertIsEnabled()
            compose.onNodeWithText(app.getString(R.string.auth_checking_workspace)).assertExists()
            check.performKeyInput { pressKey(Key.Enter) }

            response.complete(Unit)
            compose.waitUntilExactlyOneExists(
                hasText(app.getString(R.string.auth_check_failed)),
                5_000,
            )
            check.assertIsFocused().assertIsEnabled()
            assertEquals(bounds, check.getUnclippedBoundsInRoot())
            assertEquals(1, requests.get())
        } finally {
            response.complete(Unit)
            compose.runOnIdle {
                auth.membershipsAction = previousMemberships
                auth.available = previousWorkspaces
                auth.state.value = previousState
            }
        }
    }

    @Test
    fun inPlaceCheckFailureKeepsTheSignOutConfirmationForTheSameSession() {
        val app = ApplicationProvider.getApplicationContext<TestOkouApplication>()
        val auth = app.authentication as TestAuthentication
        val check = CompletableDeferred<Unit>()
        val restartedCheck = CompletableDeferred<Unit>()
        val confirmation = compose.onNodeWithText(app.getString(R.string.settings_sign_out_title))
        val empty = app.getString(R.string.auth_no_workspace)
        val replacementWorkspace = auth.available.last()
        try {
            compose.runOnIdle {
                auth.available = emptyList()
                auth.state.value = testAuthenticationState(workspace = null)
            }
            compose.waitUntilExactlyOneExists(hasText(empty), 5_000)
            compose.runOnIdle {
                auth.membershipsAction = {
                    if (auth.state.value.membershipAccess != null) restartedCheck.complete(Unit)
                    check.await()
                    error("Workspace check failed")
                }
            }
            compose.onNodeWithText(app.getString(R.string.auth_check_workspace)).performClick()
            compose
                .onNodeWithText(app.getString(R.string.auth_checking_workspace))
                .assertIsDisplayed()
            compose.onNodeWithText(app.getString(R.string.auth_sign_out)).performClick()
            confirmation.assertIsDisplayed()

            compose.runOnIdle {
                auth.state.value = auth.state.value.copy(membershipAccess = emptyList())
            }
            compose.waitUntil(5_000) { restartedCheck.isCompleted }
            confirmation.assertIsDisplayed()

            check.complete(Unit)
            compose.waitUntilExactlyOneExists(
                hasText(app.getString(R.string.auth_check_failed)),
                5_000,
            )
            confirmation.assertIsDisplayed()

            compose.runOnIdle {
                auth.available = listOf(replacementWorkspace)
                auth.membershipsAction = { auth.available }
                auth.state.value = testAuthenticationState("user-b", "session-b", workspace = null)
            }
            compose.waitUntilExactlyOneExists(hasText(replacementWorkspace.name), 5_000)
            confirmation.assertDoesNotExist()
        } finally {
            check.complete(Unit)
        }
    }
}
