/**
 * Language hints accepted by Whisper.
 *
 * The official local provider advertises auto, Chinese, English, Cantonese,
 * Japanese and Korean. This provider advertises the Whisper set, which is why it
 * exists: French has no local recognizer otherwise.
 */
export const WHISPER_LANGUAGES = [
  'auto', 'fr', 'en', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'uk',
  'cs', 'sk', 'ro', 'hu', 'bg', 'hr', 'sl', 'sr', 'lt', 'lv', 'et', 'fi',
  'sv', 'no', 'da', 'el', 'tr', 'ar', 'he', 'fa', 'hi', 'ur', 'bn', 'ta',
  'te', 'mr', 'gu', 'kn', 'ml', 'pa', 'vi', 'th', 'id', 'ms', 'zh', 'ja',
  'ko', 'yue', 'ka', 'kk', 'uz', 'az', 'hy', 'sq', 'bs', 'mk', 'be', 'ca',
  'gl', 'eu', 'af', 'sw', 'tl', 'my', 'km', 'lo', 'ne', 'si', 'mn', 'am',
] as const
