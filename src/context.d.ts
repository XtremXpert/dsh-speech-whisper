/**
 * Local augmentation of the Cordis context, using the seam contract vendored in
 * `seam-types.ts`. The published `@deepseek-ai/dsh-experimental-speech-to-text`
 * (0.1.7-alpha.1) predates the API shipped in DeepSeek Harness 0.2.2.
 */
import type { SpeechProvider, SpeechProviderInfo } from './seam-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    speechToText: {
      register(provider: SpeechProvider): () => Promise<void>
      listProviders(): readonly SpeechProviderInfo[]
    }
    effect(execute: () => () => unknown): unknown
  }
}
