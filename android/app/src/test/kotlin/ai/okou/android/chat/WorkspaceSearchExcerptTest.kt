package ai.okou.android.chat

import org.junit.Assert.assertEquals
import org.junit.Test

class WorkspaceSearchExcerptTest {
    @Test
    fun formattedPassageUsesTheIndexedOccurrence() {
        val source =
            "Launch in the first paragraph.\r\n\r\n📣 Read [**Launch**](/artifacts/brief) before Launch."
        val start = source.lastIndexOf("Launch")
        val excerpt = workspaceSearchMarkdownExcerpt(source, listOf(start until start + 6))

        assertEquals("📣 Read Launch before Launch.", excerpt.text)
        val match = excerpt.text.lastIndexOf("Launch")
        assertEquals(listOf(match until match + 6), excerpt.ranges)
    }

    @Test
    fun nestedListItemAndTableCellUseTheirVisibleText() {
        val list = "1. Confirm release timing\n   - Check **approval** today\n   - Send the brief"
        val table = "| Phase | Owner |\n| --- | --- |\n| Rollout | Ask `approval` owner |"
        assertExcerpt(list, "approval", "Check approval today", 6)
        assertExcerpt(table, "approval", "Ask approval owner", 4)
    }

    @Test
    fun imageInTableUsesItsDescriptionWithoutTheLinkOrNeighbor() {
        val source =
            "| Phase | Schedule |\n| --- | --- |\n" +
                "| Review | Check [![发布**排期**图](/artifacts/rollout)](https://example.org) before launch |"
        assertExcerpt(source, "排期", "发布排期图", 2)
    }

    @Test
    fun escapedTablePipesKeepFollowingMatchesWhole() {
        val source =
            "| Phase | Schedule |\n| --- | --- |\n" +
                "| Review | Mobile \\| Web \\| **approval** owner |"
        assertExcerpt(source, "approval", "Mobile | Web | approval owner", 15)
    }

    @Test
    fun linkDestinationMatchKeepsReadableContextWithoutFalseEmphasis() {
        val source = "Inspect the [schedule](https://release.example) before release."
        val start = source.indexOf("release")
        val range = start until start + 7
        val excerpt = workspaceSearchMarkdownExcerpt(source, listOf(range))
        assertEquals("Inspect the schedule before release.", excerpt.text)
        assertEquals(emptyList<IntRange>(), excerpt.ranges)
        assertEquals(range, excerpt.sourceRange)
    }

    @Test
    fun referenceDefinitionMatchUsesTheFirstReadablePassage() {
        val source = "Read the [guide][docs].\n\n[docs]: https://example.org/release"
        val start = source.indexOf("release")
        val excerpt = workspaceSearchMarkdownExcerpt(source, listOf(start until start + 7))
        assertEquals("Read the guide.", excerpt.text)
        assertEquals(emptyList<IntRange>(), excerpt.ranges)
    }

    @Test
    fun decodedInlineTextPreservesTheSelectedOccurrence() {
        val source = "Plan &amp; Launch and Launch."
        val start = source.lastIndexOf("Launch")
        val excerpt = workspaceSearchMarkdownExcerpt(source, listOf(start until start + 6))
        assertEquals("Plan & Launch and Launch.", excerpt.text)
        assertEquals(listOf(18..23), excerpt.ranges)
    }

    private fun assertExcerpt(source: String, keyword: String, text: String, offset: Int) {
        val start = source.indexOf(keyword)
        val excerpt =
            workspaceSearchMarkdownExcerpt(source, listOf(start until start + keyword.length))
        assertEquals(text, excerpt.text)
        assertEquals(listOf(offset until offset + keyword.length), excerpt.ranges)
    }
}
