package ai.okou.android.connectors

import coil3.annotation.ExperimentalCoilApi
import coil3.svg.Svg
import coil3.svg.SvgDecoder
import java.io.ByteArrayOutputStream
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.transform.TransformerFactory
import javax.xml.transform.dom.DOMSource
import javax.xml.transform.stream.StreamResult
import okio.Buffer
import okio.BufferedSource
import okio.ByteString.Companion.encodeUtf8
import org.w3c.dom.Element
import org.xml.sax.SAXException

private const val SVG_NAMESPACE = "http://www.w3.org/2000/svg"
private val maskType = "mask-type".encodeUtf8()
private val documentType = "<!DOCTYPE".encodeUtf8()
private val solidColor = Regex("#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})")

@OptIn(ExperimentalCoilApi::class)
internal val connectorSvgDecoder =
    SvgDecoder.Factory(
        parser =
            Svg.Parser { source -> Svg.Parser.DEFAULT.parse(source.withCompatibleAlphaMasks()) },
    )

private fun BufferedSource.withCompatibleAlphaMasks(): BufferedSource {
    if (indexOf(maskType) < 0 || indexOf(documentType) >= 0) return this

    val document =
        peek().inputStream().use { input ->
            DocumentBuilderFactory.newInstance()
                .apply { isNamespaceAware = true }
                .newDocumentBuilder()
                .apply { setEntityResolver { _, _ -> throw SAXException("SVG external entity") } }
                .parse(input)
        }
    val masks = document.getElementsByTagNameNS(SVG_NAMESPACE, "mask")
    var changed = false
    for (index in 0 until masks.length) {
        val mask = masks.item(index) as Element
        val mode =
            mask
                .getAttribute("style")
                .split(';')
                .lastOrNull { it.substringBefore(':').trim() == "mask-type" }
                ?.substringAfter(':')
                ?.substringBefore('!')
                ?.trim() ?: mask.getAttribute("mask-type").trim()
        if (mode != "alpha") continue

        // AndroidSVG uses luminance for mask coverage. White preserves a solid alpha path's
        // coverage.
        val path =
            generateSequence(mask.firstChild) { it.nextSibling }
                .filterIsInstance<Element>()
                .singleOrNull() ?: continue
        if (
            path.namespaceURI == SVG_NAMESPACE &&
                path.localName == "path" &&
                !path.hasAttribute("style") &&
                !path.hasAttribute("class") &&
                solidColor.matches(path.getAttribute("fill"))
        ) {
            path.setAttribute("fill", "#ffffff")
            changed = true
        }
    }
    if (!changed) return this

    val output = ByteArrayOutputStream()
    TransformerFactory.newInstance()
        .newTransformer()
        .transform(DOMSource(document), StreamResult(output))
    return Buffer().write(output.toByteArray())
}
