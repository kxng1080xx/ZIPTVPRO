package com.ziptv.sources

import kotlin.io.encoding.ExperimentalEncodingApi

// ponytail: drop-in for android.util.Base64 so the scrapers also compile for desktop (and below API 26).
// Decoding is lenient like Android's DEFAULT: skips whitespace/newlines, padding optional.
@OptIn(ExperimentalEncodingApi::class)
internal object Base64 {
    const val DEFAULT = 0
    const val NO_WRAP = 2

    private val lenient = kotlin.io.encoding.Base64.Mime
        .withPadding(kotlin.io.encoding.Base64.PaddingOption.PRESENT_OPTIONAL)

    @Suppress("UNUSED_PARAMETER")
    fun decode(s: String, flags: Int): ByteArray = lenient.decode(s)

    @Suppress("UNUSED_PARAMETER")
    fun encodeToString(bytes: ByteArray, flags: Int): String = kotlin.io.encoding.Base64.Default.encode(bytes)
}
