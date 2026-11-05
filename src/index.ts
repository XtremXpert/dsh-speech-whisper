import type { Context } from '@deepseek-ai/cordis'
import { WhisperProvider } from './provider.js'

export const name = 'speech-whisper'

/** The seam must exist in the composition; without it the plugin stays unloaded. */
export const inject = ['speechToText']

/**
 * Register one local Whisper recognizer.
 *
 * `register()` returns an idempotent disposer: wiring it into `ctx.effect` means
 * deactivating the plugin rejects admission, cancels accepted work and joins it,
 * exactly like the official provider.
 */
export function apply(ctx: Context): void {
  const provider = new WhisperProvider()
  const dispose = ctx.speechToText.register(provider)
  ctx.effect(() => dispose)
}
