package ai.okou.android.connectors

import android.graphics.Color
import coil3.BitmapImage
import coil3.ImageLoader
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConnectorSvgDecoderTest {
    @Test
    fun solidAlphaMaskPreservesPaintAndCoverage() = runBlocking {
        val svg =
            """
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
                <mask id="coverage" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"
                    style="mask-type:alpha">
                    <path fill="#b43333" d="M0 0h16v32H0z"/>
                </mask>
                <g mask="url(#coverage)">
                    <path fill="#0ebc5f" d="M0 0h32v32H0z"/>
                </g>
            </svg>
            """
                .trimIndent()
                .encodeToByteArray()
        val context = RuntimeEnvironment.getApplication()
        val loader = ImageLoader.Builder(context).diskCache(null).build()
        try {
            val result =
                loader.execute(
                    ImageRequest.Builder(context)
                        .data(svg)
                        .size(32)
                        .decoderFactory(connectorSvgDecoder)
                        .build(),
                ) as SuccessResult
            val bitmap = (result.image as BitmapImage).bitmap
            assertEquals(Color.rgb(14, 188, 95), bitmap.getPixel(8, 16))
            assertEquals(Color.TRANSPARENT, bitmap.getPixel(24, 16))
        } finally {
            loader.shutdown()
        }
    }
}
