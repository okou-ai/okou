package ai.okou.android.chat

import ai.okou.android.R
import android.graphics.drawable.Animatable
import android.view.View
import android.widget.ImageView
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.LayoutBoundsHolder
import androidx.compose.ui.layout.onVisibilityChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle

@Composable
internal fun ConversationReplyAvatar(animateIn: LayoutBoundsHolder?) {
    var inViewport by remember(animateIn) { mutableStateOf(false) }
    var playing by remember(animateIn) { mutableStateOf(false) }
    if (animateIn != null) {
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        LaunchedEffect(animateIn, lifecycle) {
            val motion = coroutineContext[MotionDurationScale]
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                // First access starts Android's motion-scale observation.
                motion?.scaleFactor
                try {
                    snapshotFlow { inViewport && motion?.scaleFactor != 0f }
                        .collect {
                            playing = it
                        }
                } finally {
                    playing = false
                }
            }
        }
    }

    Box(
        Modifier.size(32.dp)
            .clip(RoundedCornerShape(10.dp))
            .testTag("conversation_reply_avatar")
            .then(
                if (animateIn == null) Modifier
                else
                    Modifier.onVisibilityChanged(
                        minFractionVisible = 0f,
                        viewportBounds = animateIn,
                    ) {
                        inViewport = it
                    },
            ),
    ) {
        Image(
            painterResource(R.drawable.avatar_texture_drop_lightblue_blue),
            null,
            Modifier.matchParentSize(),
            contentScale = ContentScale.FillBounds,
        )
        if (playing) {
            AndroidView(
                factory = { context ->
                    ImageView(context).apply {
                        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                        scaleType = ImageView.ScaleType.FIT_XY
                        setImageResource(R.drawable.avd_okou_idle_avatar)
                        (drawable as Animatable).start()
                    }
                },
                modifier = Modifier.matchParentSize(),
                onRelease = { view -> (view.drawable as Animatable).stop() },
            )
        } else {
            Image(
                painterResource(R.drawable.ic_okou_idle_avatar),
                null,
                Modifier.matchParentSize(),
            )
        }
    }
}
