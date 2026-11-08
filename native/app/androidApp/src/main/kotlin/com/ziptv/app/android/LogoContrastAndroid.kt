package com.ziptv.app.android

import android.graphics.Bitmap
import coil3.size.Size
import coil3.transform.Transformation
import com.ziptv.app.whitenDarkInk

/** Android bitmap adapter for [whitenDarkInk]. */
class LogoContrast : Transformation() {
    override val cacheKey = "logo-contrast-v1"

    override suspend fun transform(input: Bitmap, size: Size): Bitmap {
        val b = if (input.config == Bitmap.Config.ARGB_8888 && input.isMutable) input else input.copy(Bitmap.Config.ARGB_8888, true)
        val px = IntArray(b.width * b.height)
        b.getPixels(px, 0, b.width, 0, 0, b.width, b.height)
        if (whitenDarkInk(px)) b.setPixels(px, 0, b.width, 0, 0, b.width, b.height)
        return b
    }
}
