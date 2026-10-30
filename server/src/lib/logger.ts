/** Minimal logger contract satisfied by Fastify's pino instance and test doubles. */
export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  debug(obj: object | string, msg?: string): void;
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
