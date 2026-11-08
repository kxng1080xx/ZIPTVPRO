package com.ziptv.app

/**
 * v9's dark-logo whitening (src/components/logo-contrast.js), same thresholds:
 * on a transparent background, near-black colourless ink turns white so it shows
 * on the dark UI; coloured parts are kept (HBO Family, CNN red). Logos that are
 * already >15% white are two-tone designs (Cartoon Network) and are left alone.
 * Works on ARGB ints; each platform adapts its bitmap type (see Platform.logoTransformation).
 * Returns true when it changed the pixels.
 */
fun whitenDarkInk(px: IntArray): Boolean {
    var clear = 0; var opaque = 0; var dark = 0; var white = 0
    for (p in px) {
        val a = p ushr 24
        if (a < 40) { clear++; continue }
        opaque++
        when {
            isDarkNeutral(p) -> dark++
            isLightNeutral(p) -> white++
        }
    }
    if (px.isEmpty() || opaque == 0) return false
    if (clear.toFloat() / px.size < 0.1f || dark.toFloat() / opaque < 0.2f || white.toFloat() / opaque > 0.15f) return false
    for (i in px.indices) {
        val p = px[i]
        if (p ushr 24 != 0 && isDarkNeutral(p)) px[i] = (p and 0xFF000000.toInt()) or 0x00FFFFFF
    }
    return true
}

private fun lum(p: Int) = 0.2126f * (p shr 16 and 0xFF) + 0.7152f * (p shr 8 and 0xFF) + 0.0722f * (p and 0xFF)
private fun sat(p: Int): Int {
    val r = p shr 16 and 0xFF; val g = p shr 8 and 0xFF; val b = p and 0xFF
    return maxOf(r, g, b) - minOf(r, g, b)
}
private fun isDarkNeutral(p: Int) = lum(p) < 90 && sat(p) < 45
private fun isLightNeutral(p: Int) = lum(p) > 200 && sat(p) < 45
