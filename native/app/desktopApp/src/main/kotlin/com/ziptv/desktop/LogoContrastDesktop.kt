package com.ziptv.desktop

import coil3.size.Size
import coil3.transform.Transformation
import com.ziptv.app.whitenDarkInk
import org.jetbrains.skia.Bitmap
import org.jetbrains.skia.ColorAlphaType
import org.jetbrains.skia.ColorType
import org.jetbrains.skia.ImageInfo

/** Skia bitmap adapter for [whitenDarkInk] (BGRA bytes <-> ARGB ints). */
class LogoContrast : Transformation() {
    override val cacheKey = "logo-contrast-v1"

    override suspend fun transform(input: Bitmap, size: Size): Bitmap {
        val info = ImageInfo(input.width, input.height, ColorType.BGRA_8888, ColorAlphaType.UNPREMUL)
        val bytes = input.readPixels(info, input.width * 4, 0, 0) ?: return input
        val px = IntArray(input.width * input.height) { i ->
            val o = i * 4
            ((bytes[o + 3].toInt() and 0xFF) shl 24) or ((bytes[o + 2].toInt() and 0xFF) shl 16) or
                ((bytes[o + 1].toInt() and 0xFF) shl 8) or (bytes[o].toInt() and 0xFF)
        }
        if (!whitenDarkInk(px)) return input
        for (i in px.indices) {
            val p = px[i]; val o = i * 4
            bytes[o] = p.toByte(); bytes[o + 1] = (p shr 8).toByte(); bytes[o + 2] = (p shr 16).toByte(); bytes[o + 3] = (p ushr 24).toByte()
        }
        return Bitmap().apply { allocPixels(info); installPixels(info, bytes, input.width * 4) }
    }
}
