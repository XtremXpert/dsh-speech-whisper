/**
 * Subset of the `speechToText` seam contract.
 *
 * Copied from `packages/experimental/speech-to-text/src/types.ts` in
 * deepseek-ai/deepseek-harness at commit fcc0ad46 (2026-11-04), because
 * `@deepseek-ai/dsh-experimental-speech-to-text` is experimental and unpublished.
 * Re-check this file whenever the harness upgrades; delete it the day the seam
 * publishes its types.
 */

export type SpeechProviderId = string & { readonly __brand: 'SpeechProviderId' }

/** Provider-specific planning estimates, not measured progress or guaranteed limits. */
export interface SpeechSetupEstimate {
  readonly recommendedDiskBytes: number
  readonly expectedMemoryBytes: number
  readonly minimumMinutes: number
  readonly maximumMinutes: number
}

/** Public provider facts; credentials and filesystem paths are excluded. */
export interface SpeechProviderInfo {
  readonly id: SpeechProviderId
  readonly name: string
  readonly location: 'host-local' | 'cloud'
  readonly languages: readonly string[]
  readonly setupEstimate?: SpeechSetupEstimate
  readonly downloadSources?: readonly string[]
}

export interface SpeechInput {
  readonly audio: Uint8Array
  readonly language: string
}

/** Final transcription; an empty string means no speech was recognized. */
export interface Transcript {
  readonly text: string
  readonly audioSeconds: number
  readonly inferenceSeconds: number
}

/** One replaceable recognizer. It owns preparation, execution and cancellation. */
export interface SpeechProvider {
  readonly info: SpeechProviderInfo
  transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript>
}
