/** One serial local worker per model family, with request-owned cancellation and idle reclamation. */
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { SpeechPreparationOptions, SpeechInput, SpeechPreparationState, SpeechPreparationStep, SpeechPreparationStepKind, Transcript } from './seam-types.ts'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { z } from 'zod'
import type { Config } from './config.ts'
import { familyOf, SpeechInputError, type ModelFamily } from './input.ts'
import { SpeechDownloadError } from './download-error.ts'
import { inspectRuntime, prepareRuntime, type RuntimePaths } from './runtime.ts'

const transcriptSchema = z.object({
  text: z.string(), audioSeconds: z.number().nonnegative(), inferenceSeconds: z.number().nonnegative(),
}).strict()

/** Every model family the provider can prepare and run. */
const families: readonly ModelFamily[] = ['sensevoice', 'whisper']

type FamilyState = SpeechPreparationState & { readonly steps: readonly SpeechPreparationStep[] }

interface Worker {
  readonly family: ModelFamily
  readonly handle: SubprocessHandle
  readonly url: string
  readonly token: string
  closed: boolean
}

interface Preparation {
  readonly family: ModelFamily
  readonly abort: AbortController
  readonly downloadSource: string | undefined
  settled: Promise<void>
  completed: boolean
}

/** Wait for a cancellable operation without losing ownership of its eventual settlement. */
function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('Speech operation cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/**
 * Read one bounded worker readiness frame and reject exit before readiness.
 * @param handle - newly spawned worker with piped stdout.
 * @param limit - maximum readiness bytes.
 * @param signal - startup deadline or caller cancellation.
 * @returns dynamically allocated loopback port.
 */
export async function readReady(handle: SubprocessHandle, limit: number, signal: AbortSignal): Promise<number> {
  if (!handle.stdout) throw new Error('Speech worker stdout is unavailable')
  signal.throwIfAborted()
  const stdout = handle.stdout
  let text = ''
  const pending = Promise.withResolvers<number>()
  const data = (chunk: Buffer): void => {
    text += chunk.toString('utf8')
    if (Buffer.byteLength(text) > limit) { pending.reject(new Error('Speech worker readiness exceeded its byte limit')); return }
    const end = text.indexOf('\n')
    if (end < 0) return
    try {
      const value = z.object({ port: z.number().int().min(1).max(65535) }).strict().parse(JSON.parse(text.slice(0, end)))
      pending.resolve(value.port)
    } catch (error) { pending.reject(new Error('Invalid speech worker readiness', { cause: error })) }
  }
  stdout.on('data', data)
  stdout.on('error', pending.reject)
  void handle.done.then(() => {
    pending.reject(new Error(`Speech worker exited before readiness: ${handle.collected.stderr?.readFrom(0).text}`))
  }, pending.reject)
  try { return await waitFor(pending.promise, signal) }
  finally { stdout.off('data', data); stdout.off('error', pending.reject); stdout.resume() }
}

/**
 * Decode a bounded worker HTTP response; malformed worker output fails the request.
 * @param response - private authenticated worker response.
 * @param limit - maximum bytes retained before JSON parsing.
 * @returns validated final transcript; marked input rejections throw SpeechInputError.
 */
export async function readTranscript(response: Response, limit: number): Promise<Transcript> {
  if (!response.body) throw new Error('Speech worker returned no response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > limit) throw new Error('Speech transcript exceeded its byte limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!response.ok) {
    const failure = z.object({ error: z.string(), code: z.literal('invalid-input').optional() }).parse(value)
    if ((response.status === 400 || response.status === 413) && failure.code === 'invalid-input') {
      throw new SpeechInputError(failure.error)
    }
    throw new Error(failure.error)
  }
  return transcriptSchema.parse(value)
}

/** Own the worker of the selected family across recordings, and join every accepted job on disposal. */
export class LocalWorker {
  private worker: Worker | undefined
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private readonly lifetime = new AbortController()
  private idle: ReturnType<typeof setTimeout> | undefined
  private readonly runtimes = new Map<ModelFamily, RuntimePaths>()
  private readonly states: Record<ModelFamily, FamilyState>
  private readonly listeners = new Set<() => void>()
  private readonly preparing = new Map<ModelFamily, Preparation>()
  private lastProgressAt = 0
  /** Configured origins available for explicit downloads; offline deployments expose no choices. */
  readonly downloadSources: readonly string[]

  constructor(private readonly ctx: Context, private readonly config: Config) {
    this.downloadSources = config.modelDirectory !== undefined && config.whisperModelDirectory !== undefined
      && config.vadModelPath !== undefined ? []
      : [...new Set((config.modelOrigin === undefined ? config.modelOrigins : [config.modelOrigin]).map(origin => new URL(origin).origin))]
    this.states = { sensevoice: unprepared(this.kinds('sensevoice')), whisper: unprepared(this.kinds('whisper')) }
  }

  private kinds(family: ModelFamily): readonly SpeechPreparationStepKind[] {
    const downloaded = family === 'sensevoice' ? this.config.modelDirectory === undefined : this.config.whisperModelDirectory === undefined
    const kinds: SpeechPreparationStepKind[] = ['check']
    if (downloaded) kinds.push('model')
    if (this.config.vadModelPath === undefined) kinds.push('vad')
    kinds.push('verify', 'load')
    return kinds
  }

  /**
   * Read preparation readiness for the model that serves one language.
   * @param language - selected language hint.
   * @returns the current Host-owned state of that model.
   */
  snapshot(): SpeechPreparationState { return this.states.whisper }

  /**
   * Observe readiness.
   * @param listener - invalidation callback.
   * @returns subscription disposer.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(family: ModelFamily, state: SpeechPreparationState): void {
    const task = this.preparing.get(family)
    if (task && ['ready', 'standby', 'unprepared', 'failed', 'cancelled'].includes(state.phase)) {
      task.completed = true
    }
    const previous = this.states[family]
    const steps = state.steps ?? previous.steps.map((item): SpeechPreparationStep => {
      if (state.phase === 'ready') return { ...item, status: 'complete' }
      if (state.step === 'check' && item.kind !== 'check') return { kind: item.kind, status: 'pending' }
      if (state.step === item.kind) return item.status === 'running' ? item
        : { kind: item.kind, status: 'running', startedAt: Date.now() }
      if (item.status !== 'running') return item
      if (state.phase === 'standby') return { ...item, status: 'cancelled' }
      if (state.phase === 'failed' || state.phase === 'cancelled') return { ...item, status: state.phase }
      return state.step === undefined ? item : { ...item, status: 'complete' }
    })
    this.states[family] = { ...state, steps }
    const now = performance.now()
    if (state.phase === 'downloading' && previous.phase === 'downloading' && state.resource === previous.resource
      && state.completedBytes !== state.totalBytes && now - this.lastProgressAt < this.config.progressIntervalMs) return
    this.lastProgressAt = now
    for (const listener of this.listeners) listener()
  }

  /** Inspect both families' disk caches on activation; verified resources enter standby without starting a worker. */
  inspect(): void {
    for (const family of families) {
      this.runTask(family, async (signal) => {
        using inspection = deadline(signal, this.config.prepareTimeoutMs, 'SPEECH_PREPARE_TIMEOUT')
        this.publish(family, { phase: 'checking', step: 'check', startedAt: Date.now() })
        const runtime = await inspectRuntime(this.config, family, inspection.signal)
        inspection.signal.throwIfAborted()
        if (runtime !== undefined) this.runtimes.set(family, runtime)
        this.publish(family, { phase: runtime ? 'standby' : 'unprepared', steps: this.states[family].steps.map(({ kind }) => ({ kind,
          status: kind === 'check' || runtime !== undefined && kind !== 'load' ? 'complete' : 'pending',
        })) })
      })
    }
  }

  /**
   * Start or join the Host-owned preparation task for this provider's model.
   * @param options - omitted source uses deployment policy; a manual source must be advertised and disables fallback.
   */
  prepare(options: SpeechPreparationOptions = {}): void {
    const family: ModelFamily = 'whisper'
    const source = options.downloadSource
    if (source !== undefined && !this.downloadSources.includes(source)) throw new Error('Speech download source is unavailable')
    const config = source === undefined ? this.config : Object.assign({}, this.config, { modelOrigin: source })
    this.runTask(family, async (signal) => { await this.start(family, signal, config) }, source)
  }

  private runTask(family: ModelFamily, run: (signal: AbortSignal) => Promise<void>, downloadSource?: string): void {
    const active = this.preparing.get(family)
    if (active && active.downloadSource !== downloadSource) throw new Error('Cancel preparation before changing its download source')
    if (active || this.worker?.family === family) return
    this.lifetime.signal.throwIfAborted()
    const abort = new AbortController()
    const task: Preparation = { family, abort, downloadSource, settled: Promise.resolve(), completed: false }
    this.preparing.set(family, task)
    task.settled = this.enqueue(run, abort.signal)
      .catch((error: unknown) => {
        if (this.lifetime.signal.aborted) return
        this.publish(family, abort.signal.aborted ? { phase: 'cancelled' }
          : { phase: 'failed', message: error instanceof Error ? error.message : String(error),
            ...error instanceof SpeechDownloadError ? { download: error.download } : {} })
      }).finally(() => { this.preparing.delete(family) })
  }

  /** Cancel unfinished preparation for every family; completed readiness is retained. @returns after queued or active work settles. */
  async cancel(): Promise<void> {
    const tasks = [...this.preparing.values()]
    for (const task of tasks) {
      if (task.completed || task.abort.signal.aborted) continue
      // Abort before notifying: a listener may cancel again while it observes this state.
      task.abort.abort(new Error('Speech preparation cancelled'))
      this.publish(task.family, { phase: 'cancelling', startedAt: Date.now() })
    }
    await Promise.all(tasks.map(async (task) => { await task.settled }))
  }

  /**
   * Queue one bounded recording; cancellation never leaves inference running after settlement.
   * Verified resources accept recordings while the worker wakes; other preparation states reject without downloading.
   * @param input - complete WAV and language hint.
   * @param signal - caller cancellation.
   * @returns recognized text; cancelled waiting jobs never acquire the worker.
   */
  async transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript> {
    return await this.enqueue(async combined => await this.execute(input, combined), signal)
  }

  private async enqueue<T>(run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    if (this.pending >= this.config.maxPending) throw new Error('Speech transcription queue is full')
    clearTimeout(this.idle)
    this.pending++
    const job = this.tail.then(async () => {
      combined.throwIfAborted()
      return await run(combined)
    })
    this.tail = job.then(() => undefined, () => undefined).finally(() => {
      this.pending--
      if (this.pending === 0 && !this.lifetime.signal.aborted && this.config.idleTimeoutMs > 0) {
        this.idle = setTimeout(() => {
          this.tail = this.tail.then(async () => { await this.stop() })
          void this.tail.catch((error: unknown) => { this.ctx.logger.warn('Speech worker idle cleanup failed', error) })
        }, this.config.idleTimeoutMs)
      }
    })
    return await job
  }

  private async start(family: ModelFamily, signal: AbortSignal, preparationConfig: Config = this.config): Promise<Worker> {
    if (this.worker?.closed) await this.stop()
    if (this.worker !== undefined && this.worker.family !== family) await this.stop()
    if (this.worker) return this.worker
    using setup = deadline(signal, this.config.prepareTimeoutMs, 'SPEECH_PREPARE_TIMEOUT')
    const cached = this.runtimes.has(family)
    if (!cached) this.publish(family, { phase: 'checking', step: 'check', startedAt: Date.now() })
    const runtime = this.runtimes.get(family)
      ?? await prepareRuntime(this.ctx, preparationConfig, family, setup.signal, (state) => { this.publish(family, state) })
    this.runtimes.set(family, runtime)
    setup.signal.throwIfAborted()
    this.publish(family, { phase: cached ? 'waking' : 'loading', step: 'load', startedAt: Date.now() })
    await mkdir(this.config.dataRoot, { recursive: true })
    const token = randomBytes(32).toString('hex')
    const handle = this.ctx.subprocess.spawn({
      argv: [process.execPath, ...runtime.worker.endsWith('.ts') ? ['--import', import.meta.resolve('tsx/esm')] : [], runtime.worker, JSON.stringify(Object.assign({}, this.config, { paths: runtime }))],
      cwd: this.config.dataRoot, graceMs: this.config.graceMs,
      env: { DSH_SPEECH_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: this.config.maxLogBytes } },
    })
    try {
      const port = await readReady(handle, this.config.maxLogBytes, setup.signal)
      const worker = { family, handle, url: `http://127.0.0.1:${port}`, token, closed: false }
      this.worker = worker
      this.publish(family, { phase: 'ready' })
      const exited = (): void => {
        if (!worker.closed) { worker.closed = true; this.publish(family, { phase: 'standby' }) }
      }
      void handle.done.then(exited, exited)
      return worker
    } catch (error) {
      handle.terminate()
      await handle.waitForExit()
      throw error
    }
  }

  private async execute(input: SpeechInput, signal: AbortSignal): Promise<Transcript> {
    const family: ModelFamily = 'whisper'
    const phase = this.states[family].phase
    if (phase !== 'ready' && phase !== 'standby') throw new Error('Prepare the local speech provider before recording')
    try {
      const worker = await this.start(family, signal)
      using call = deadline(signal, this.config.inferenceTimeoutMs, 'SPEECH_INFERENCE_TIMEOUT')
      const response = await fetch(`${worker.url}/transcribe?language=${encodeURIComponent(input.language)}`, {
        method: 'POST', headers: { authorization: `Bearer ${worker.token}`, 'content-type': 'audio/wav' },
        body: Buffer.from(input.audio), signal: call.signal,
      })
      const result = await readTranscript(response, this.config.maxResponseBytes).catch((error: unknown) => {
        call.signal.throwIfAborted()
        throw error
      })
      call.signal.throwIfAborted()
      return result
    } catch (error) {
      if (error instanceof SpeechInputError) throw error
      await this.stop()
      this.publish(family, { phase: 'standby' })
      throw error
    }
  }

  private async stop(): Promise<void> {
    const worker = this.worker
    if (!worker) return
    worker.closed = true
    worker.handle.terminate()
    await worker.handle.waitForExit()
    this.worker = undefined
    this.publish(worker.family, { phase: 'standby' })
  }

  /**
   * Stop the local recognizer.
   * @returns after admission closes, queued jobs settle, every preparation joins, and the managed worker exits.
   */
  async dispose(): Promise<void> {
    this.listeners.clear()
    this.lifetime.abort(new Error('Local speech provider disposed'))
    clearTimeout(this.idle)
    try { await this.tail } finally { await this.stop() }
    await Promise.all([...this.preparing.values()].map(async (task) => { await task.settled }))
  }
}

/**
 * Build one family's initial pending step list.
 * @param kinds - ordered operations that family performs.
 * @returns an unprepared state with every step pending.
 */
function unprepared(kinds: readonly SpeechPreparationStepKind[]): FamilyState {
  return { phase: 'unprepared', steps: kinds.map(kind => ({ kind, status: 'pending' })) }
}
