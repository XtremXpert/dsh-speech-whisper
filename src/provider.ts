import type {
  SpeechInput,
  SpeechProvider,
  SpeechProviderInfo,
  Transcript,
} from './contract.js'
import { WHISPER_LANGUAGES } from './languages.js'

/** Raised until the sherpa-onnx Whisper runtime is ported in. See docs/PORTING.md. */
export class WhisperNotWiredError extends Error {
  constructor() {
    super(
      'dsh-speech-whisper: provider registered, transcription not implemented yet — ' +
        'port the runtime described in docs/PORTING.md',
    )
    this.name = 'WhisperNotWiredError'
  }
}

export class WhisperProvider implements SpeechProvider {
  readonly info: SpeechProviderInfo = {
    id: 'whisper' as SpeechProviderInfo['id'],
    name: 'Whisper local',
    location: 'host-local',
    languages: WHISPER_LANGUAGES,
    // Whisper small, INT8 weights, plus the sherpa-onnx runtime and Silero VAD.
    setupEstimate: {
      recommendedDiskBytes: 700 * 1024 * 1024,
      expectedMemoryBytes: 1_200 * 1024 * 1024,
      minimumMinutes: 2,
      maximumMinutes: 20,
    },
    downloadSources: ['https://huggingface.co', 'https://hf-mirror.com'],
  }

  async transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript> {
    signal.throwIfAborted()
    void input
    throw new WhisperNotWiredError()
  }
}
