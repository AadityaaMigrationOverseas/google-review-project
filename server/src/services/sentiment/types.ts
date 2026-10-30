/** Output of the supplied DistilBERT-SST2 engine, before neutral mapping. */
export interface RawSentiment {
  label: 'POSITIVE' | 'NEGATIVE';
  /** Softmax probability of `label`, 0.5..1. */
  confidence: number;
  pPositive: number;
  tokens: number;
  engineMicros: number;
}

export type SentimentErrorCode =
  'TIMEOUT' | 'OVERLOADED' | 'UNAVAILABLE' | 'CLOSED' | 'EMPTY' | 'TOO_LONG' | 'INFERENCE' | 'PROTOCOL';

export class SentimentError extends Error {
  constructor(
    public readonly code: SentimentErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'SentimentError';
  }
}

export interface SentimentEngineStatus {
  ready: boolean;
  workers: number;
  readyWorkers: number;
  queued: number;
}

export interface SentimentAnalyzer {
  readonly modelId: string;
  analyze(text: string): Promise<RawSentiment>;
  status(): SentimentEngineStatus;
  close(): Promise<void>;
}
