/** Verified runtime assets and managed command execution for local transcription. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'
import type { SpeechPreparationState } from './seam-types.ts'
import { timeoutOf } from '@deepseek-ai/dsh-timeout'
import { classifyDownloadFailure, SpeechDownloadError } from './download-error.ts'
import { orderModelSources } from './model-sources.ts'
import type { ModelFamily } from './input.ts'

/** Release-pinned downloadable file. */
export interface Asset {
  readonly name: string
  readonly url: string
  readonly sha256: string
  readonly bytes: number
}

/** Single-model weights and their token table. */
interface FamilyLock {
  readonly models: Record<Config['precision'], Asset>
  readonly tokens: Asset
}

/** Whisper weights split into the encoder and decoder pairs it decodes with. */
interface WhisperLock {
  readonly models: Record<Config['precision'], { readonly encoder: Asset; readonly decoder: Asset }>
  readonly tokens: Asset
}

interface RuntimeLock {
  readonly sensevoice: FamilyLock
  readonly whisper: WhisperLock
  readonly vad: Asset
}

/** Prepared model and process paths, private to the local provider. */
export type RuntimePaths = (
  | { readonly family: 'sensevoice'; readonly model: string }
  | { readonly family: 'whisper'; readonly encoder: string; readonly decoder: string }
) & {
  readonly tokens: string
  readonly vad: string
  readonly worker: string
}

/** One family's paths plus the managed files that must still match their pins. */
interface FamilyRuntime {
  readonly paths: RuntimePaths
  /** Absolute path and pin for each file the provider downloaded itself. */
  readonly managed: readonly (readonly [string, Asset])[]
  /** Every file the family needs, managed or deployment-supplied. */
  readonly files: readonly string[]
}

const supported = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']

async function matchesAsset(path: string, asset: Asset, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`Speech asset is not a regular file: ${path}`)
    if (info.size !== asset.bytes) return false
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path, { signal })) digest.update(chunk as Buffer)
    return digest.digest('hex') === asset.sha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
}

function resolveRuntime(config: Config, family: ModelFamily): { lock: RuntimeLock; runtime: FamilyRuntime } {
  if (!supported.includes(`${process.platform}-${process.arch}`)) throw new Error(`Local speech is unavailable for ${process.platform}-${process.arch}`)
  const lock = JSON.parse(readFileSync(new URL('../runtime/assets.json', import.meta.url), 'utf8')) as RuntimeLock
  const vad = config.vadModelPath ?? join(config.dataRoot, 'models', 'silero', lock.vad.name)
  /* v8 ignore next -- built worker resolution is exercised by real Node and Electron process smokes */
  const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url))
  const vadFiles = config.vadModelPath === undefined ? [[vad, lock.vad]] as const : []
  if (family === 'sensevoice') {
    const model = lock.sensevoice.models[config.precision]
    const root = config.modelDirectory ?? join(config.dataRoot, 'models', 'sensevoice-onnx')
    const paths = join(root, model.name), tokens = join(root, lock.sensevoice.tokens.name)
    const managed = config.modelDirectory === undefined ? [[paths, model], [tokens, lock.sensevoice.tokens]] as const : []
    return { lock, runtime: { paths: { family, model: paths, tokens, vad, worker },
      managed: [...managed, ...vadFiles], files: [paths, tokens, vad] } }
  }
  const models = lock.whisper.models[config.precision]
  const root = config.whisperModelDirectory ?? join(config.dataRoot, 'models', 'whisper-small')
  const encoder = join(root, models.encoder.name), decoder = join(root, models.decoder.name)
  const tokens = join(root, lock.whisper.tokens.name)
  const managed = config.whisperModelDirectory === undefined
    ? [[encoder, models.encoder], [decoder, models.decoder], [tokens, lock.whisper.tokens]] as const : []
  return { lock, runtime: { paths: { family, encoder, decoder, tokens, vad, worker }, managed: [...managed, ...vadFiles],
    files: [encoder, decoder, tokens, vad] } }
}

async function verifyRuntime(runtime: FamilyRuntime, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  try { await Promise.all(runtime.files.map(async (path) => { await access(path) })) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
  for (const [path, asset] of runtime.managed) if (!await matchesAsset(path, asset, signal)) return false
  signal.throwIfAborted()
  return true
}

/**
 * Inspect existing models without downloading, writing files or starting the worker.
 * @param config - model paths and selected precision.
 * @param family - model that serves the selected language.
 * @param signal - provider cancellation or inspection deadline.
 * @returns cached paths when every required file exists and managed assets match their pinned size and hash;
 * otherwise undefined.
 */
export async function inspectRuntime(config: Config, family: ModelFamily, signal: AbortSignal): Promise<RuntimePaths | undefined> {
  const { runtime } = resolveRuntime(config, family)
  return await verifyRuntime(runtime, signal) ? runtime.paths : undefined
}

/**
 * Download into a unique partial file, verify, then publish it atomically.
 * @param asset - pinned release identity.
 * @param root - provider-owned cache directory.
 * @param signal - preparation cancellation.
 * @param report - Host-owned progress publisher.
 * @returns verified local file path; failures carry localized-UI diagnostics through SpeechDownloadError.
 */
export async function downloadAsset(asset: Asset, root: string, signal: AbortSignal,
  report: (state: SpeechPreparationState) => void = () => {}): Promise<string> {
  signal.throwIfAborted()
  const destination = join(root, asset.name)
  const partial = `${destination}.${randomUUID()}.part`
  let source = new URL(asset.url).origin
  try {
    await mkdir(root, { recursive: true })
    if (await matchesAsset(destination, asset, signal)) return destination
    try {
      const response = await fetch(asset.url, { signal })
      source = new URL(response.url || asset.url).origin
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new SpeechDownloadError({ resource: asset.name, source, reason: 'http', status: response.status })
      }
      const digest = createHash('sha256')
      let completedBytes = 0
      const publish = (): void => { report({ phase: 'downloading', resource: asset.name, completedBytes, totalBytes: asset.bytes }) }
      publish()
      const hashing = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        completedBytes += chunk.length
        if (completedBytes > asset.bytes) {
          callback(new SpeechDownloadError({ resource: asset.name, source, reason: 'integrity' })); return
        }
        digest.update(chunk); publish(); callback(null, chunk)
      } })
      await pipeline(response.body, hashing, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal })
      if (completedBytes !== asset.bytes || digest.digest('hex') !== asset.sha256) {
        throw new SpeechDownloadError({ resource: asset.name, source, reason: 'integrity' })
      }
      signal.throwIfAborted()
      await rename(partial, destination)
      return destination
    } finally {
      await rm(partial, { force: true })
    }
  } catch (error) {
    const timedOut = timeoutOf(signal)
    if (signal.aborted && !timedOut || error instanceof SpeechDownloadError) throw error
    throw new SpeechDownloadError({ resource: asset.name, source,
      ...timedOut ? { reason: 'timeout' } : classifyDownloadFailure(error),
    }, { cause: error })
  }
}

/**
 * Resolve the bundled native runtime and prepare verified ONNX models for one model family.
 * @param _ctx - Host context owning the preparation task.
 * @param config - model paths, precision, and download source policy.
 * @param family - model that serves the selected language.
 * @param signal - preparation cancellation or deadline.
 * @param report - Host-owned progress publisher.
 * @returns verified paths of the requested family.
 */
export async function prepareRuntime(_ctx: Context, config: Config, family: ModelFamily, signal: AbortSignal,
  report: (state: SpeechPreparationState) => void = () => {}): Promise<RuntimePaths> {
  const { lock, runtime } = resolveRuntime(config, family)
  const download = async (asset: Asset, root: string, step: 'model' | 'vad'): Promise<void> => {
    if (await matchesAsset(join(root, asset.name), asset, signal)) return
    const origins = config.modelOrigin === undefined ? config.modelOrigins : [config.modelOrigin]
    const urls = await orderModelSources(asset.url, origins, config.modelProbeTimeoutMs, signal)
    for (const [index, url] of urls.entries()) {
      try {
        await downloadAsset({ ...asset, url }, root, signal, (state) => { report({ ...state, step }) })
        return
      } catch (error) {
        if (signal.aborted || !(error instanceof SpeechDownloadError) || error.download.reason === 'storage'
          || error.download.reason === 'unknown' || index === urls.length - 1) throw error
      }
    }
  }
  report({ phase: 'checking', step: 'model', startedAt: Date.now() })
  if (family === 'sensevoice') {
    if (config.modelDirectory === undefined) {
      const model = lock.sensevoice.models[config.precision], root = join(config.dataRoot, 'models', 'sensevoice-onnx')
      await download(model, root, 'model')
      await download(lock.sensevoice.tokens, root, 'model')
    }
  } else if (config.whisperModelDirectory === undefined) {
    const models = lock.whisper.models[config.precision], root = join(config.dataRoot, 'models', 'whisper-small')
    await download(models.encoder, root, 'model')
    await download(models.decoder, root, 'model')
    await download(lock.whisper.tokens, root, 'model')
  }
  if (config.vadModelPath === undefined) {
    report({ phase: 'checking', step: 'vad', startedAt: Date.now() })
    await download(lock.vad, join(config.dataRoot, 'models', 'silero'), 'vad')
  }
  report({ phase: 'checking', step: 'verify', startedAt: Date.now() })
  if (!await verifyRuntime(runtime, signal)) throw new Error('Speech model verification failed: missing or corrupted model files')
  return runtime.paths
}
