/** CPU model inference and Silero segmentation, confined to the recognition process. */
import { createRequire } from 'node:module'
import type { Transcript } from './seam-types.ts'
import type { Config } from './config.ts'
import { familyOf, SpeechInputError, validateInput } from './input.ts'
import type { RuntimePaths } from './runtime.ts'

/** Verified files and validated inference settings sent by the Host. */
export interface InferenceConfig extends Config {
  /** Verified paths of the one model family this process loaded. */
  readonly paths: RuntimePaths
}

interface Stream { acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void }
interface Recognizer {
  createStream(): Stream
  setConfig(config: object): void
  decode(stream: Stream): void
  getResult(stream: Stream): { text: string }
}
interface Detector {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  front(externalBuffer: false): { start: number; samples: Float32Array }
  pop(): void
  reset(): void
  flush(): void
}
interface Sherpa {
  OfflineRecognizer: new (config: object) => Recognizer
  Vad: new (config: object, bufferSeconds: number) => Detector
}

/** One loaded native recognizer with its per-request language carrier. */
interface PreparedModel {
  select(language: string): void
  recognize(samples: Float32Array): string
}

/**
 * Load the SenseVoice recognizer, carrying each request's language hint into its decoder configuration.
 * @param sherpa - published native binding.
 * @param config - validated CPU limits and verified paths.
 * @param paths - SenseVoice weights and token table.
 * @returns the native recognizer with per-request selection.
 */
function senseVoiceModel(sherpa: Sherpa, config: InferenceConfig, paths: Extract<RuntimePaths, { family: 'sensevoice' }>): PreparedModel {
  const nativeConfig = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { senseVoice: { model: paths.model, language: 'auto', useInverseTextNormalization: 1 },
      tokens: paths.tokens, numThreads: config.threads, provider: 'cpu', debug: 0 },
  }
  const recognizer = new sherpa.OfflineRecognizer(nativeConfig)
  return {
    select: (language) => { nativeConfig.modelConfig.senseVoice.language = language; recognizer.setConfig(nativeConfig) },
    recognize: samples => decodeWith(recognizer, samples),
  }
}

/**
 * Load the Whisper encoder and decoder pair, carrying each request's language hint into its decoder configuration.
 * @param sherpa - published native binding.
 * @param config - validated CPU limits and verified paths.
 * @param paths - Whisper encoder, decoder and token table.
 * @returns the native recognizer with per-request selection.
 */
function whisperModel(sherpa: Sherpa, config: InferenceConfig, paths: Extract<RuntimePaths, { family: 'whisper' }>): PreparedModel {
  const nativeConfig = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { whisper: { encoder: paths.encoder, decoder: paths.decoder, language: 'en', task: 'transcribe', tailPaddings: -1 },
      tokens: paths.tokens, numThreads: config.threads, provider: 'cpu', debug: 0 },
  }
  const recognizer = new sherpa.OfflineRecognizer(nativeConfig)
  return {
    select: (language) => { nativeConfig.modelConfig.whisper.language = language; recognizer.setConfig(nativeConfig) },
    recognize: samples => decodeWith(recognizer, samples),
  }
}

/**
 * Decode one bounded speech segment.
 * @param recognizer - native recognizer with the request language already applied.
 * @param samples - 16 kHz mono samples of one VAD segment.
 * @returns trimmed recognized text, empty when the segment carries no speech.
 */
function decodeWith(recognizer: Recognizer, samples: Float32Array): string {
  const stream = recognizer.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  recognizer.decode(stream)
  return recognizer.getResult(stream).text.trim()
}

/**
 * Load the model serving the configured family; every recording resets VAD and updates its language hint.
 * @param config - verified ONNX paths and explicit CPU/VAD limits.
 * @returns synchronous inference confined to its dedicated process.
 */
export function createTranscriber(config: InferenceConfig): (audio: Uint8Array, language: string) => Transcript {
  // sherpa-onnx-node publishes a CommonJS Node-API binding with JSDoc but no declarations.
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as Sherpa
  const paths = config.paths
  const model = paths.family === 'sensevoice' ? senseVoiceModel(sherpa, config, paths) : whisperModel(sherpa, config, paths)
  const detector = new sherpa.Vad({
    sileroVad: { model: paths.vad, threshold: config.vadThreshold, minSilenceDuration: config.minSilenceSeconds,
      minSpeechDuration: config.minSpeechSeconds, maxSpeechDuration: config.segmentSeconds, windowSize: 512 },
    sampleRate: 16000, numThreads: config.threads, provider: 'cpu', debug: 0,
  }, config.segmentSeconds + config.minSilenceSeconds + 1)
  return (audio, language) => {
    const audioSeconds = validateInput(audio, language, config.maxAudioBytes)
    if (familyOf(language) !== paths.family) throw new SpeechInputError(`Loaded ${paths.family} model cannot recognize ${language}`)
    const pcm = new DataView(audio.buffer, audio.byteOffset + 44, audio.byteLength - 44)
    const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, i) => pcm.getInt16(i * 2, true) / 32768)
    model.select(language)
    detector.reset()
    const started = performance.now(), texts: string[] = []
    // Silero cannot back-date the first segment of a cold detector, so it reports a start index
    // several frames after speech actually began; restore that dropped onset from the recording.
    const onsetPadding = Math.round(config.vadOnsetPaddingSeconds * 16000)
    let isFirstSegment = true
    const drain = (): void => {
      while (!detector.isEmpty()) {
        // Electron's V8 memory cage requires copied native buffers, including VAD output.
        const segment = detector.front(false)
        let speech = segment.samples
        if (isFirstSegment) {
          isFirstSegment = false
          const from = Math.max(0, segment.start - onsetPadding)
          if (from < segment.start) {
            const restored = new Float32Array(segment.start - from + speech.length)
            restored.set(samples.subarray(from, segment.start))
            restored.set(speech, segment.start - from)
            speech = restored
          }
        }
        texts.push(model.recognize(speech))
        detector.pop()
      }
    }
    for (let offset = 0; offset < samples.length; offset += 512) {
      detector.acceptWaveform(samples.subarray(offset, offset + 512))
      drain()
    }
    detector.flush(); drain()
    return { text: texts.filter(Boolean).join(' ').trim(), audioSeconds, inferenceSeconds: (performance.now() - started) / 1000 }
  }
}
