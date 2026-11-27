package ai.okou.android

import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w320dp-h440dp", application = TestOkouApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WorkspaceToolDirectoryRowTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun narrowRowGrowsForLargeTextAndKeepsItsMediaSpace() {
        val title = "Quarterly planning notes for workspace administrators"
        val description = "Ready for review"
        compose.setContent {
            val density = Density(LocalDensity.current.density, fontScale = 2f)
            CompositionLocalProvider(LocalDensity provides density) {
                OkouTheme(false) {
                    WorkspaceToolDirectoryRow(
                        title = title,
                        selected = true,
                        onClick = {},
                        modifier = Modifier.testTag("directory_row"),
                        leading = {},
                    ) {
                        Text(description)
                    }
                }
            }
        }

        val row =
            compose
                .onNodeWithTag("directory_row")
                .assertIsDisplayed()
                .assertHasClickAction()
                .assertIsSelected()
                .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
                .assertTextContains(title)
                .assertTextContains(description)
                .getUnclippedBoundsInRoot()
        val headingNode = compose.onNodeWithText(title, useUnmergedTree = true)
        val supportingNode = compose.onNodeWithText(description, useUnmergedTree = true)
        val heading = headingNode.getUnclippedBoundsInRoot()
        val supporting = supportingNode.getUnclippedBoundsInRoot()
        val headlineLayouts = mutableListOf<TextLayoutResult>()
        val supportingLayouts = mutableListOf<TextLayoutResult>()
        headingNode.performSemanticsAction(SemanticsActions.GetTextLayoutResult) {
            it(headlineLayouts)
        }
        supportingNode.performSemanticsAction(SemanticsActions.GetTextLayoutResult) {
            it(supportingLayouts)
        }

        assertTrue(row.bottom - row.top > 88.dp)
        assertEquals(68.dp, heading.left - row.left)
        assertTrue(heading.top - row.top >= 10.dp)
        assertEquals(heading.bottom, supporting.top)
        assertTrue(supporting.bottom + 10.dp <= row.bottom)
        val headlineStyle = headlineLayouts.single().layoutInput.style
        val supportingStyle = supportingLayouts.single().layoutInput.style
        assertEquals(16.sp, headlineStyle.fontSize)
        assertEquals(24.sp, headlineStyle.lineHeight)
        assertEquals(14.sp, supportingStyle.fontSize)
        assertEquals(20.sp, supportingStyle.lineHeight)
    }
}
