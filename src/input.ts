/** Language routing between the local model families and input failures that leave native inference untouched. */
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'

/** Local model families; each serves the languages its ONNX model recognizes. */
export type ModelFamily = 'sensevoice' | 'whisper'

/** Languages served by the SenseVoice model, including its automatic language identification. */
export const sensevoiceLanguages: readonly string[] = ['auto', 'zh', 'yue', 'en', 'ja', 'ko']

/** Languages served by the multilingual Whisper model. */
export const whisperLanguages: readonly string[] = ['fr', 'de', 'es', 'pt', 'ru']

/** Accepted language hints in recognition-language selector order. */
export const languages: readonly string[] = [...sensevoiceLanguages, ...whisperLanguages]

/**
 * Select the model that recognizes one accepted language hint.
 * @param language - hint accepted by `languages`.
 * @returns the model family whose weights serve that language.
 */
export function familyOf(language: string): ModelFamily {
  return sensevoiceLanguages.includes(language) ? 'sensevoice' : 'whisper'
}

/** A request rejected before native inference; the loaded worker remains reusable. */
export class SpeechInputError extends Error {}

/**
 * Validate a recording before touching the native recognizer.
 * @param audio - untrusted WAV request bytes.
 * @param language - requested language hint.
 * @param maxAudioBytes - configured worker byte limit.
 * @returns validated audio duration in seconds; invalid inputs throw SpeechInputError.
 */
export function validateInput(audio: Uint8Array, language: string, maxAudioBytes: number): number {
  if (!languages.includes(language)) throw new SpeechInputError('Unsupported local speech language')
  if (audio.byteLength > maxAudioBytes) throw new SpeechInputError('Speech audio exceeds the worker byte limit')
  try { return validateWave(audio, maxAudioBytes / 32000) }
  catch (error) { throw new SpeechInputError('Invalid speech WAV', { cause: error }) }
}
