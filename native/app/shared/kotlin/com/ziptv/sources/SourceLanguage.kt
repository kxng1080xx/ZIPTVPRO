package com.ziptv.sources

/** What the audio track of a stream is: the title's original audio, a dub, a sub (original audio + subtitles) or mixed. */
enum class StreamAudioKind { ORIGINAL, DUB, SUB, DUAL, UNKNOWN }

/** Normalised language / audio kind of one stream. [codes] are lower-case ISO 639-1 (pt-br is reported as "pt"). */
data class SourceLanguageInfo(
    val codes: Set<String>,
    val kind: StreamAudioKind,
) {
    val primary: String? get() = codes.firstOrNull()

    /** Short badge text for source rows, e.g. "English", "Portuguese · Dub", "Hindi + English". */
    fun badge(): String {
        val langs = codes.joinToString(" + ") { SourceLanguage.labelOf(it) }
        return when {
            langs.isEmpty() -> when (kind) {
                StreamAudioKind.ORIGINAL -> "Original"
                StreamAudioKind.DUB -> "Dub"
                StreamAudioKind.SUB -> "Sub"
                StreamAudioKind.DUAL -> "Dual audio"
                StreamAudioKind.UNKNOWN -> ""
            }
            kind == StreamAudioKind.DUB -> "$langs · Dub"
            kind == StreamAudioKind.SUB -> "$langs · Sub"
            else -> langs
        }
    }
}

object SourceLanguage {
    /** Languages offered by the "Preferred audio language" setting and the source filter chips. */
    val OPTIONS: List<Pair<String, String>> = listOf(
        "en" to "English",
        "hi" to "Hindi",
        "es" to "Spanish",
        "pt" to "Portuguese",
        "fr" to "French",
        "de" to "German",
        "it" to "Italian",
        "ja" to "Japanese",
        "ko" to "Korean",
        "zh" to "Chinese",
        "ru" to "Russian",
        "ar" to "Arabic",
        "tr" to "Turkish",
        "ta" to "Tamil",
        "te" to "Telugu",
        "ml" to "Malayalam",
        "kn" to "Kannada",
        "bn" to "Bengali",
        "mr" to "Marathi",
        "pa" to "Punjabi",
        "th" to "Thai",
        "id" to "Indonesian",
        "vi" to "Vietnamese",
        "pl" to "Polish",
        "nl" to "Dutch",
    )

    fun labelOf(code: String): String = OPTIONS.firstOrNull { it.first == code }?.second ?: code.uppercase()

    /** Ordered so more specific tokens win; each is matched on a lower-cased string. */
    private val LEXICON: List<Pair<String, Regex>> = listOf(
        "pt" to Regex("""\bpt[-_ ]?br\b|\bptbr\b|portugu[eê]s|portuguese|\bbrazil"""),
        "es" to Regex("""\besla\b|\blatino\b|\blatam\b|spanish|espa[nñ]ol|castellano"""),
        "en" to Regex("""english|\beng\b"""),
        "hi" to Regex("""hindi|\bhin\b"""),
        "ta" to Regex("""tamil"""),
        "te" to Regex("""telugu"""),
        "ml" to Regex("""malayalam"""),
        "kn" to Regex("""kannada"""),
        "bn" to Regex("""bengali|bangla"""),
        "mr" to Regex("""marathi"""),
        "pa" to Regex("""punjabi"""),
        "ja" to Regex("""japanese|\bjpn\b"""),
        "ko" to Regex("""korean|\bkor\b"""),
        "fr" to Regex("""french|fran[cç]ais|\bvostfr\b|\btruefrench\b"""),
        "de" to Regex("""german|deutsch"""),
        "it" to Regex("""italian|italiano"""),
        "ru" to Regex("""russian"""),
        "ar" to Regex("""arabic"""),
        "tr" to Regex("""turkish"""),
        "zh" to Regex("""chinese|mandarin|cantonese"""),
        "th" to Regex("""\bthai\b"""),
        "id" to Regex("""indonesian"""),
        "vi" to Regex("""vietnamese"""),
        "pl" to Regex("""polish"""),
        "nl" to Regex("""dutch"""),
    )

    private val DUAL = Regex("""dual[ _-]?audio|\bdual\b|multi[ _-]?audio|\bmulti\b""")
    private val DUB = Regex("""\bdub(bed|s)?\b""")
    private val SUB = Regex("""\b(sub|subs|subbed|subtitled|softsub|hardsub)\b""")
    private val ORIGINAL = Regex("""original[ _-]?audio|\boriginal\b""")

    fun parse(text: String): SourceLanguageInfo {
        val t = text.lowercase()
        val codes = LinkedHashSet<String>()
        for ((code, rx) in LEXICON) if (rx.containsMatchIn(t)) codes += code
        val kind = when {
            DUAL.containsMatchIn(t) || codes.size >= 2 && !DUB.containsMatchIn(t) && !SUB.containsMatchIn(t) -> StreamAudioKind.DUAL
            DUB.containsMatchIn(t) -> StreamAudioKind.DUB
            SUB.containsMatchIn(t) -> StreamAudioKind.SUB
            ORIGINAL.containsMatchIn(t) -> StreamAudioKind.ORIGINAL
            else -> StreamAudioKind.UNKNOWN
        }
        return SourceLanguageInfo(codes, kind)
    }

    /**
     * 2 = the stream carries the preferred audio language, 1 = language unknown (neutral),
     * 0 = another language. A SUB stream keeps its original audio, so its audio language counts as is.
     */
    fun tier(info: SourceLanguageInfo, preferred: String): Int = when {
        preferred in info.codes -> 2
        info.codes.isEmpty() -> 1
        else -> 0
    }
}
