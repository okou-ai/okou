package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.api.generated.ComposerWorkflowsItem
import ai.okou.android.connectors.ConnectorSheet
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
internal fun workflowPanelHeight(anchor: IntRect, appBarHeight: Dp, grouped: Boolean): Int? {
    val density = LocalDensity.current
    val statusBar = WindowInsets.statusBars.getTop(density)
    return with(density) {
        val room =
            (anchor.top - statusBar - (appBarHeight + 16.dp).roundToPx()).coerceAtMost(
                240.dp.roundToPx(),
            )
        val textHeight = 20.sp.roundToPx() + 16.sp.roundToPx()
        val row = maxOf(56.dp.roundToPx(), textHeight + 16.dp.roundToPx())
        val minimum =
            row + 8.dp.roundToPx() + if (grouped) 16.sp.roundToPx() + 8.dp.roundToPx() else 0
        room.takeIf { it >= minimum && anchor.width > 0 }
    }
}

@Composable
internal fun ComposerWorkflowPopup(
    anchor: IntRect,
    heightLimit: Int,
    state: ComposerWorkflowState,
    candidates: WorkflowCandidates,
    position: LazyListState,
    highlighted: String?,
    dismiss: () -> Unit,
    onHeight: (Int) -> Unit,
    select: (ComposerWorkflowsItem) -> Unit,
) {
    val density = LocalDensity.current
    val gap = with(density) { 8.dp.roundToPx() }
    val shape = RoundedCornerShape(12.dp)
    Popup(
        popupPositionProvider =
            remember(anchor, gap) {
                object : PopupPositionProvider {
                    override fun calculatePosition(
                        anchorBounds: IntRect,
                        windowSize: IntSize,
                        layoutDirection: LayoutDirection,
                        popupContentSize: IntSize,
                    ) =
                        IntOffset(
                            anchor.left,
                            anchor.top - gap - popupContentSize.height,
                        )
                }
            },
        onDismissRequest = dismiss,
        properties = PopupProperties(focusable = false, dismissOnBackPress = false),
    ) {
        Surface(
            Modifier.width(with(density) { anchor.width.toDp() })
                .heightIn(max = with(density) { heightLimit.toDp() })
                .onSizeChanged { onHeight(it.height) }
                .testTag("composer-workflow-popup"),
            shape = shape,
            color = MaterialTheme.colorScheme.surface,
            shadowElevation = 2.dp,
            border =
                androidx.compose.foundation.BorderStroke(
                    1.dp,
                    MaterialTheme.colorScheme.outlineVariant,
                ),
        ) {
            ComposerWorkflowRows(
                state,
                candidates,
                position,
                highlighted,
                focusableRows = false,
                select,
                modifier = Modifier.padding(4.dp),
            )
        }
    }
}

@Composable
internal fun ComposerWorkflowPicker(
    catalog: ComposerWorkflowCatalog,
    dismiss: () -> Unit,
    select: (ComposerWorkflowsItem) -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val state by catalog.state.collectAsStateWithLifecycle()
    val candidates =
        remember(state.snapshot, query) {
            state.snapshot?.candidates(query) ?: WorkflowCandidates()
        }
    val position = rememberLazyListState()
    LaunchedEffect(catalog) { catalog.refresh() }
    LaunchedEffect(query) { position.requestScrollToItem(0) }
    ConnectorSheet(
        title = stringResource(R.string.composer_workflow_title),
        dismiss = dismiss,
        expandInShortWindow = true,
        compactForm = true,
        back = dismiss,
    ) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            modifier = Modifier.fillMaxWidth().testTag("composer-workflow-search"),
            label = { Text(stringResource(R.string.composer_workflow_search)) },
            singleLine = true,
        )
        ComposerWorkflowRows(
            state,
            candidates,
            position,
            null,
            focusableRows = true,
            select,
            Modifier.heightIn(max = 320.dp),
        )
    }
}

@Composable
private fun ComposerWorkflowRows(
    state: ComposerWorkflowState,
    candidates: WorkflowCandidates,
    position: LazyListState,
    highlighted: String?,
    focusableRows: Boolean,
    select: (ComposerWorkflowsItem) -> Unit,
    modifier: Modifier = Modifier,
) {
    val grouped = candidates.recent.isNotEmpty()
    val atStart = !position.canScrollBackward
    LaunchedEffect(grouped) {
        // The first recent response can add rows above an already visible catalog.
        if (grouped && atStart && highlighted == null) position.requestScrollToItem(0)
    }
    if (candidates.rows.isEmpty()) {
        val label =
            when {
                state.snapshot == null && state.failed -> R.string.composer_workflow_read_failed
                state.snapshot == null -> R.string.composer_workflow_loading
                state.snapshot.workflows.isEmpty() -> R.string.composer_workflow_empty
                else -> R.string.composer_workflow_no_match
            }
        Text(
            stringResource(label),
            modifier =
                modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 12.dp).semantics {
                    liveRegion = LiveRegionMode.Polite
                },
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
        )
        return
    }
    LazyColumn(modifier.fillMaxWidth(), state = position) {
        if (grouped) {
            item("recent-heading") { WorkflowHeading(R.string.composer_workflow_recent) }
            items(candidates.recent, key = { it.workflow.id }) {
                WorkflowCandidate(it, it.workflow.id == highlighted, focusableRows, select)
            }
            if (candidates.all.isNotEmpty())
                item("all-heading") { WorkflowHeading(R.string.composer_workflow_all) }
        }
        items(candidates.all, key = { it.workflow.id }) {
            WorkflowCandidate(it, it.workflow.id == highlighted, focusableRows, select)
        }
    }
}

@Composable
private fun WorkflowHeading(label: Int) {
    Text(
        stringResource(label),
        Modifier.padding(horizontal = 8.dp, vertical = 4.dp).semantics { heading() },
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall,
    )
}

@Composable
private fun WorkflowCandidate(
    match: WorkflowMatch,
    highlighted: Boolean,
    focusable: Boolean,
    select: (ComposerWorkflowsItem) -> Unit,
) {
    val item = match.workflow
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(8.dp)
    var focused by remember { mutableStateOf(false) }
    val active =
        highlighted ||
            focusable && focused && LocalInputModeManager.current.inputMode == InputMode.Keyboard
    val subdued = if (active) colors.onSecondaryContainer else colors.onSurfaceVariant
    val title = item.displayName?.takeIf { it.isNotBlank() && it != item.name }
    val details =
        listOfNotNull(title, item.description?.takeIf(String::isNotBlank)).joinToString(" · ")
    val command =
        remember(match) {
            buildAnnotatedString {
                append('/')
                var offset = 0
                for (range in match.ranges) {
                    append(item.name.substring(offset, range.first))
                    withStyle(SpanStyle(fontWeight = FontWeight(750))) {
                        append(item.name.substring(range.first, range.last + 1))
                    }
                    offset = range.last + 1
                }
                append(item.name.substring(offset))
            }
        }
    Surface(
        shape = shape,
        color = if (active) colors.secondaryContainer else colors.surface,
        contentColor = if (active) colors.onSecondaryContainer else colors.onSurface,
    ) {
        Row(
            Modifier.fillMaxWidth()
                .heightIn(min = 56.dp)
                .then(if (active) Modifier.border(2.dp, colors.primary, shape) else Modifier)
                .focusProperties { canFocus = focusable }
                .onFocusChanged { focused = it.isFocused }
                .clickable { select(item) }
                .semantics { selected = highlighted }
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                painterResource(R.drawable.ic_account_tree),
                null,
                Modifier.size(20.dp),
                tint = subdued,
            )
            androidx.compose.foundation.layout.Column {
                Text(
                    command,
                    style =
                        MaterialTheme.typography.bodyMedium.copy(
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                            fontWeight = FontWeight(550),
                        ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (details.isNotEmpty())
                    Text(
                        details,
                        color = subdued,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
            }
        }
    }
}
