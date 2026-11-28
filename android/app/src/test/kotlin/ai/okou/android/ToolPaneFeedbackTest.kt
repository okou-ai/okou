package ai.okou.android

import ai.okou.android.connectors.ConnectorReadFeedbackHost
import ai.okou.android.connectors.ConnectorReadNotice
import androidx.activity.ComponentActivity
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w440dp-h800dp")
class ToolPaneFeedbackTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun connectorPaneShowsBothEligibleReadRoundsInConfirmationOrder() {
        val announcements = PaneReadAnnouncements()
        val older = ConnectorReadNotice(1, R.string.connector_refresh_failed)
        val newer = ConnectorReadNotice(2, R.string.connector_accounts_failed)
        val notices = mutableStateOf(listOf(newer, older))
        compose.setContent {
            OkouTheme {
                ConnectorReadFeedbackHost(notices.value, announcements, Modifier)
            }
        }
        val first = compose.onNodeWithText(compose.activity.getString(older.message))
        val second = compose.onNodeWithText(compose.activity.getString(newer.message))
        first.assertIsDisplayed()
        second.assertDoesNotExist()
        compose.mainClock.advanceTimeBy(5_300)
        second.assertIsDisplayed()

        // A successful refresh retires the active notice immediately.
        compose.runOnIdle { notices.value = listOf(older) }
        first.assertDoesNotExist()
        second.assertDoesNotExist()
    }

    @Test
    fun leavingAConnectorScopeRetiresTheDisplayedAndWaitingReadNotices() {
        val announcements = PaneReadAnnouncements()
        val older = ConnectorReadNotice(1, R.string.connector_refresh_failed)
        val newer = ConnectorReadNotice(2, R.string.connector_accounts_failed)
        val notices = mutableStateOf(listOf(older, newer))
        val scope = mutableStateOf(0)
        compose.setContent {
            OkouTheme {
                key(scope.value) { ConnectorReadFeedbackHost(notices.value, announcements) }
            }
        }
        val first = compose.onNodeWithText(compose.activity.getString(older.message))
        val second = compose.onNodeWithText(compose.activity.getString(newer.message))
        first.assertIsDisplayed()
        second.assertDoesNotExist()

        compose.runOnIdle { scope.value++ }
        first.assertDoesNotExist()
        second.assertDoesNotExist()

        compose.runOnIdle { notices.value = listOf(newer.copy(round = 3)) }
        second.assertIsDisplayed()
    }
}
