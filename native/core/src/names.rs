//! Channel-name cleanup and logo/EPG matching keys.
//! Ported from src/components/xtream-api.js (cleanChannelName) and
//! server/channel-logos.js (logoKey) so v10 behaves like v9.

use regex::Regex;
use std::sync::LazyLock;

const COUNTRIES_2: &str = "US|UK|GB|CA|AU|NZ|IE|AR|BR|MX|DE|FR|ES|IT|PT|NL|BE|CH|PL|TR|GR|RO|SE|NO|DK|FI|IN|PK|ZA|EG|SA|AE|QA|KW|IL|RU|UA|CZ|SK|HU|HR|RS|BG|PH|MY|SG|TH|VN|KR|JP|CN|HK|TW|CL|CO|PE|VE|EC|UY|PY|BO|CR|PA|DO|JM|TT";
const COUNTRY_WORDS: &str = "USA|US|UK|GB|GBR|ENG|CA|CAN|AU|AUS|NZ|NZL|IE|IRL|UAE|AE|ZA|RSA|IN|IND|PK|PAK|PH|PHL";

// Some providers leak M3U syntax into names: "#EXTINF:0,Audio Noir Radio".
static EXTINF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*#EXTINF:[^,]*,\s*").unwrap());
static BRACKET_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\[({]\s*[^\])}]{1,12}\s*[\])}]\s*").unwrap());
static PIPE_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\|[^|]{1,12}\|\s*").unwrap());
static CAPS_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z]{2,4}(?:\s[A-Z]{2,12}){0,2}\s*[:|]\s*").unwrap());
// No lookahead in the regex crate: "only if something follows" is checked in strip_if_followed().
static COUNTRY_DASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^(?:{COUNTRY_WORDS})\s*[-–—]\s*")).unwrap());
static BARE_COUNTRY: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^(?:{COUNTRIES_2})\s+")).unwrap());
static EMOJI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[\x{1F1E6}-\x{1F1FF}\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{FE0F}\x{200D}]+\s*)+").unwrap()
});
static STRAY_SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:\|\s+|[\s\-–—:•·.]+)+").unwrap());
static MULTI_SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s{2,}").unwrap());

fn strip(re: &Regex, s: &str) -> String {
    re.replace(s, "").into_owned()
}

fn strip_if_followed(re: &Regex, s: &str) -> String {
    match re.find(s) {
        Some(m) if m.end() < s.len() => s[m.end()..].to_string(),
        _ => s.to_string(),
    }
}

/// "US: CNN HD" -> "CNN HD", "|AR| beIN" -> "beIN", "PM : CA TCM" -> "TCM".
pub fn clean_channel_name(raw: &str) -> String {
    let mut s = raw.to_string();
    for _ in 0..4 {
        let before = s.clone();
        s = s.trim_start().to_string();
        s = strip(&EXTINF, &s);
        s = strip(&BRACKET_TAG, &s);
        s = strip(&PIPE_TAG, &s);
        s = strip(&CAPS_TAG, &s);
        s = strip_if_followed(&COUNTRY_DASH, &s);
        s = strip_if_followed(&BARE_COUNTRY, &s);
        s = strip(&EMOJI, &s);
        s = strip(&STRAY_SEP, &s);
        if s == before {
            break;
        }
    }
    let s = MULTI_SPACE.replace_all(&s, " ").trim().to_string();
    if s.is_empty() { raw.trim().to_string() } else { s }
}

static KEY_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\W*([a-z]{2,3})\W*(?:[:|\]]|\s[-–—])\s*").unwrap());
static KEY_PAREN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\([^)]*\)|\[[^\]]*\]").unwrap());
static KEY_QUALITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:f?hd|uhd|sd|4k|8k|hevc|h\.?26[45]|\d{3,4}p|raw|backup|vip)\b").unwrap());
static KEY_NONALNUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9+]").unwrap());

/// Matching key for logo/EPG indexes: "US: CNN HD" -> ("cnn", "us"). Must stay
/// identical to logoKey() in server/channel-logos.js, which built the indexes.
pub fn logo_key(raw: &str) -> (String, String) {
    let mut s = raw.to_lowercase();
    let mut cc = String::new();
    for _ in 0..3 {
        let Some(caps) = KEY_PREFIX.captures(&s) else { break };
        let code = caps[1].to_string();
        cc = match code.as_str() {
            "uk" | "eng" => "gb".into(),
            "usa" => "us".into(),
            "can" => "ca".into(),
            "aus" => "au".into(),
            "uae" => "ae".into(),
            _ => code,
        };
        let end = caps.get(0).unwrap().end();
        s = s[end..].to_string();
    }
    let s = KEY_PAREN.replace_all(&s, " ");
    let s = KEY_QUALITY.replace_all(&s, " ");
    let name = KEY_NONALNUM.replace_all(&s, "").into_owned();
    (name, if cc.len() == 2 { cc } else { String::new() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_provider_prefixes() {
        assert_eq!(clean_channel_name("US: CNN HD"), "CNN HD");
        assert_eq!(clean_channel_name("[UK] Sky One"), "Sky One");
        assert_eq!(clean_channel_name("|AR| beIN Sports"), "beIN Sports");
        assert_eq!(clean_channel_name("PM : CA TCM"), "TCM");
        assert_eq!(clean_channel_name("USA - CATCHY COMEDY"), "CATCHY COMEDY");
        assert_eq!(clean_channel_name("MTV - Classic"), "MTV - Classic");
        assert_eq!(clean_channel_name("US"), "US"); // never cleaned into nothing
        assert_eq!(clean_channel_name("#EXTINF:0,Ambient Sleeping Pill [Opt-1]"), "Ambient Sleeping Pill [Opt-1]");
    }

    #[test]
    fn logo_keys_match_js() {
        assert_eq!(logo_key("US: CNN HD"), ("cnn".into(), "us".into()));
        assert_eq!(logo_key("[UK] Sky Sports Main Event FHD"), ("skysportsmainevent".into(), "gb".into()));
        assert_eq!(logo_key("USA - Catchy Comedy"), ("catchycomedy".into(), "us".into()));
        assert_eq!(logo_key("ESPN 2"), ("espn2".into(), "".into()));
    }
}
