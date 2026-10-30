import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from '../../lib/logger.js';
import { SentimentError, type RawSentiment, type SentimentAnalyzer, type SentimentEngineStatus } from './types.js';

export interface CppEngineOptions {
  /** Executable path. Spawned directly (never through a shell). */
  command: string;
  args: string[];
  workers: number;
  requestTimeoutMs: number;
  startupTimeoutMs: number;
  maxQueue: number;
  logger: Logger;
  modelId?: string;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
}

const PROTOCOL_VERSION = '1';
const MAX_STDOUT_BUFFER = 64 * 1024;

/**
 * Converts review text into the single-line ASCII form the engine protocol
 * accepts. Accents are folded (as BERT-uncased does) and anything the
 * supplied tokenizer would discard is replaced with spaces.
 */
export function toEngineText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

interface Job {
  text: string;
  resolve(r: RawSentiment): void;
  reject(e: SentimentError): void;
  timer: NodeJS.Timeout;
  worker: Worker | null;
  settled: boolean;
}

type WorkerState = 'starting' | 'idle' | 'busy' | 'stopped';

class Worker {
  state: WorkerState = 'stopped';
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private current: { id: string; job: Job } | null = null;
  private nextId = 1;
  private startupTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private closing = false;

  constructor(
    private readonly index: number,
    private readonly opts: Required<Omit<CppEngineOptions, 'modelId'>>,
    private readonly onIdle: () => void,
  ) {}

  get pendingRestart(): boolean {
    return this.restartTimer !== null;
  }

  /** True while the worker keeps failing to come up (e.g. missing model). */
  get failing(): boolean {
    return this.consecutiveFailures > 0 && this.state !== 'idle' && this.state !== 'busy';
  }

  get ready(): boolean {
    return this.state === 'idle' || this.state === 'busy';
  }

  start(): void {
    if (this.closing) return;
    this.state = 'starting';
    this.buffer = '';
    const child = spawn(this.opts.command, this.opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // The engine needs no configuration from the environment; withholding it
      // keeps secrets such as SMTP credentials out of the child process.
      env: { LANG: 'C', LC_ALL: 'C' },
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) =>
      this.opts.logger.warn({ worker: this.index, stderr: chunk.slice(0, 500).trim() }, 'sentiment engine stderr'),
    );
    child.stdin.on('error', () => {
      /* surfaced via the exit handler */
    });
    child.on('error', (err) => {
      this.opts.logger.error({ worker: this.index, err: err.message }, 'sentiment engine spawn error');
      this.handleExit(null, null);
    });
    child.on('exit', (code, signal) => this.handleExit(code, signal));

    this.startupTimer = setTimeout(() => {
      this.opts.logger.error({ worker: this.index }, 'sentiment engine startup timed out');
      this.kill();
    }, this.opts.startupTimeoutMs);
  }

  run(job: Job): void {
    if (this.state !== 'idle' || !this.child) throw new Error('worker not idle');
    const id = String(this.nextId++);
    this.state = 'busy';
    this.current = { id, job };
    job.worker = this;
    this.child.stdin.write(`${id}\t${job.text}\n`);
  }

  /** Called when a job's deadline passes while it is running on this worker. */
  abort(job: Job): void {
    if (this.current?.job === job) {
      this.current = null;
      this.kill();
    }
  }

  kill(): void {
    this.child?.kill('SIGKILL');
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.stdin.end();
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_STDOUT_BUFFER) {
      this.opts.logger.error({ worker: this.index }, 'sentiment engine produced oversized output');
      this.kill();
      return;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      this.onJsonLine(trimmed);
      return;
    }
    const parts = line.split('\t');
    if (this.state === 'starting') {
      if (parts[0] === 'READY' && parts[1] === PROTOCOL_VERSION) {
        if (this.startupTimer) clearTimeout(this.startupTimer);
        this.startupTimer = null;
        this.consecutiveFailures = 0;
        this.state = 'idle';
        this.opts.logger.info({ worker: this.index }, 'sentiment engine ready');
        this.onIdle();
      } else {
        this.opts.logger.error({ worker: this.index, line: line.slice(0, 200) }, 'unexpected engine handshake');
        this.kill();
      }
      return;
    }

    const current = this.current;
    if (!current || parts[0] !== current.id) {
      // An unparseable or unexpected line means the stream can no longer be
      // trusted to pair responses with requests, so the process is recycled.
      this.opts.logger.error({ worker: this.index }, 'sentiment engine response out of sequence');
      this.current = null;
      current?.job.reject(new SentimentError('PROTOCOL', 'engine response out of sequence'));
      this.kill();
      return;
    }
    this.current = null;
    this.state = 'idle';

    const result = parseResponse(parts);
    if (result instanceof SentimentError) current.job.reject(result);
    else current.job.resolve(result);
    this.onIdle();
  }

  private onJsonLine(jsonText: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      this.opts.logger.error({ worker: this.index }, 'sentiment engine emitted invalid JSON');
      const current = this.current;
      this.current = null;
      current?.job.reject(new SentimentError('PROTOCOL', 'invalid JSON from engine'));
      this.kill();
      return;
    }

    if (this.state === 'starting') {
      if (parsed.ready === true || parsed.status === 'READY') {
        if (this.startupTimer) clearTimeout(this.startupTimer);
        this.startupTimer = null;
        this.consecutiveFailures = 0;
        this.state = 'idle';
        this.opts.logger.info({ worker: this.index }, 'sentiment engine ready (json)');
        this.onIdle();
      } else {
        this.opts.logger.error({ worker: this.index }, 'unexpected JSON engine handshake');
        this.kill();
      }
      return;
    }

    const current = this.current;
    const respId = parsed.id !== undefined ? String(parsed.id) : current?.id;
    if (!current || respId !== current.id) {
      this.opts.logger.error({ worker: this.index }, 'sentiment engine JSON response out of sequence');
      this.current = null;
      current?.job.reject(new SentimentError('PROTOCOL', 'engine response out of sequence'));
      this.kill();
      return;
    }
    this.current = null;
    this.state = 'idle';

    if (typeof parsed.error === 'string') {
      const code = parsed.error;
      const err =
        code === 'EMPTY' || code === 'TOO_LONG' || code === 'INFERENCE'
          ? new SentimentError(code)
          : new SentimentError('PROTOCOL', `engine error ${code}`);
      current.job.reject(err);
      this.onIdle();
      return;
    }

    const label = parsed.label;
    const confidence = Number(parsed.confidence);
    const pPositive =
      parsed.pPositive !== undefined ? Number(parsed.pPositive) : label === 'POSITIVE' ? confidence : 1 - confidence;
    const tokens = Number(parsed.tokens ?? 1);
    const engineMicros = Number(parsed.engineMicros ?? 100);
    if (
      (label !== 'POSITIVE' && label !== 'NEGATIVE') ||
      !(confidence >= 0 && confidence <= 1) ||
      !(pPositive >= 0 && pPositive <= 1) ||
      !Number.isInteger(tokens) ||
      !Number.isFinite(engineMicros)
    ) {
      current.job.reject(new SentimentError('PROTOCOL', 'invalid JSON engine values'));
    } else {
      current.job.resolve({ label, confidence, pPositive, tokens, engineMicros });
    }
    this.onIdle();
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.state === 'stopped' && !this.child) return;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    const wasStarting = this.state === 'starting';
    this.child = null;
    this.state = 'stopped';

    if (this.current) {
      this.current.job.reject(new SentimentError('UNAVAILABLE', 'sentiment engine exited during analysis'));
      this.current = null;
    }
    if (this.closing) return;

    if (wasStarting) this.consecutiveFailures++;
    const delay = Math.min(
      this.opts.restartBaseDelayMs * 2 ** Math.max(0, this.consecutiveFailures - 1),
      this.opts.restartMaxDelayMs,
    );
    this.opts.logger.warn(
      { worker: this.index, code, signal, restartInMs: delay },
      'sentiment engine exited; restarting',
    );
    this.onIdle();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }
}

function parseResponse(parts: string[]): RawSentiment | SentimentError {
  if (parts[1] === 'ERR') {
    const code = parts[2];
    if (code === 'EMPTY' || code === 'TOO_LONG' || code === 'INFERENCE') return new SentimentError(code);
    return new SentimentError('PROTOCOL', `engine error ${code ?? 'unknown'}`);
  }
  if (parts[1] !== 'OK' || parts.length !== 7) return new SentimentError('PROTOCOL', 'malformed engine response');
  const [, , label, confidenceRaw, pPositiveRaw, tokensRaw, microsRaw] = parts;
  const confidence = Number(confidenceRaw);
  const pPositive = Number(pPositiveRaw);
  const tokens = Number(tokensRaw);
  const engineMicros = Number(microsRaw);
  if (
    (label !== 'POSITIVE' && label !== 'NEGATIVE') ||
    !(confidence >= 0 && confidence <= 1) ||
    !(pPositive >= 0 && pPositive <= 1) ||
    !Number.isInteger(tokens) ||
    !Number.isFinite(engineMicros)
  ) {
    return new SentimentError('PROTOCOL', 'invalid engine values');
  }
  return { label, confidence, pPositive, tokens, engineMicros };
}

/**
 * Pool of long-lived C++ engine processes. Each process loads the ONNX model
 * once and then serves requests sequentially over stdin/stdout, so per-review
 * cost is inference only (no process start-up or model load).
 */
export class CppSentimentEngine implements SentimentAnalyzer {
  readonly modelId: string;
  private readonly workers: Worker[];
  private readonly queue: Job[] = [];
  private closed = false;

  constructor(private readonly opts: CppEngineOptions) {
    this.modelId = opts.modelId ?? 'distilbert-sst2-onnx/cpp-v1';
    const full = {
      restartBaseDelayMs: 1000,
      restartMaxDelayMs: 30_000,
      ...opts,
    } as Required<Omit<CppEngineOptions, 'modelId'>>;
    this.workers = Array.from({ length: opts.workers }, (_, i) => new Worker(i, full, () => this.dispatch()));
  }

  start(): void {
    for (const w of this.workers) w.start();
  }

  /** Resolves once at least one worker is ready, or false after `timeoutMs`. */
  async waitUntilReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.workers.some((w) => w.ready)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  status(): SentimentEngineStatus {
    const readyWorkers = this.workers.filter((w) => w.ready).length;
    return { ready: readyWorkers > 0, workers: this.workers.length, readyWorkers, queued: this.queue.length };
  }

  analyze(text: string): Promise<RawSentiment> {
    if (this.closed) return Promise.reject(new SentimentError('CLOSED'));
    const line = toEngineText(text);
    if (!/[A-Za-z0-9]/.test(line)) return Promise.reject(new SentimentError('EMPTY'));
    if (this.queue.length >= this.opts.maxQueue)
      return Promise.reject(new SentimentError('OVERLOADED', 'sentiment queue is full'));
    // Fail fast rather than making patients wait for a deadline when every
    // worker is down or crash-looping; the retry sweeper re-analyses later.
    if (
      !this.workers.some((w) => w.ready) &&
      this.workers.every((w) => w.failing || (w.state === 'stopped' && !w.pendingRestart))
    )
      return Promise.reject(new SentimentError('UNAVAILABLE', 'no sentiment workers running'));

    return new Promise<RawSentiment>((resolve, reject) => {
      const job: Job = {
        text: line,
        worker: null,
        settled: false,
        resolve: (r) => settle(() => resolve(r)),
        reject: (e) => settle(() => reject(e)),
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(job);
          if (idx !== -1) this.queue.splice(idx, 1);
          job.worker?.abort(job);
          job.reject(new SentimentError('TIMEOUT', `sentiment analysis exceeded ${this.opts.requestTimeoutMs}ms`));
        }, this.opts.requestTimeoutMs),
      };
      const settle = (fn: () => void) => {
        if (job.settled) return;
        job.settled = true;
        clearTimeout(job.timer);
        fn();
      };
      this.queue.push(job);
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new SentimentError('CLOSED'));
    await Promise.all(this.workers.map((w) => w.close()));
  }

  private dispatch(): void {
    for (const worker of this.workers) {
      if (this.queue.length === 0) return;
      if (worker.state !== 'idle') continue;
      const job = this.queue.shift()!;
      worker.run(job);
    }
  }
}
