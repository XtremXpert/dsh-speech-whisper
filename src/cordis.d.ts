/**
 * Provisional typing for the seam, until the harness publishes the real one.
 * Mirrors the augmentation in `packages/experimental/speech-to-text/src/index.ts`.
 */
import type { SpeechProvider, SpeechProviderInfo } from './contract.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    speechToText: {
      register(provider: SpeechProvider): () => Promise<void>
      listProviders(): readonly SpeechProviderInfo[]
    }
  }
}
