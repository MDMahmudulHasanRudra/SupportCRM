import { Injectable, type LoggerService } from '@nestjs/common';
import { redact } from './redact';

/**
 * Structured JSON logging with automatic secret redaction.
 *
 * `PROJECT_SPEC.md` §129/§180 requires structured logs carrying correlation ids (requestId, userId,
 * jobId, conversationId, messageId, sessionId, automationId, aiRequestId) and forbids ever logging
 * secrets. Both are handled here so no call site has to think about either.
 *
 * Implements `LoggerService` rather than extending `ConsoleLogger`: Nest's base class types its
 * second parameter as a `string` context, and this logger's second parameter is a structured object.
 * Extending would mean widening every signature to `any` — which is exactly the typing hole that
 * lets an unredacted object slip through.
 *
 * In development each line is human-readable; elsewhere it is one JSON object per line, which is
 * what a log shipper expects.
 */
export interface LogContext {
  requestId?: string;
  userId?: string;
  jobId?: string;
  conversationId?: string;
  messageId?: string;
  sessionId?: string;
  automationId?: string;
  aiRequestId?: string;
  [key: string]: unknown;
}

@Injectable()
export class AppLogger implements LoggerService {
  private readonly structured = process.env.NODE_ENV !== 'development';

  constructor(private readonly scope = 'app') {}

  log(message: string, context?: LogContext): void {
    this.emit('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.emit('warn', message, context);
  }

  error(message: string, context?: LogContext & { error?: unknown }): void {
    this.emit('error', message, context);
  }

  debug(message: string, context?: LogContext): void {
    if (process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV === 'development') {
      this.emit('debug', message, context);
    }
  }

  verbose(message: string, context?: LogContext): void {
    this.debug(message, context);
  }

  /** Nest calls this for framework-level fatals. */
  fatal(message: string, context?: LogContext): void {
    this.emit('error', message, context);
  }

  private emit(level: string, message: string, context?: LogContext): void {
    // Redaction applies to the CONTEXT, not to `message`. A caller that interpolates a secret into
    // the message string is a bug redaction cannot fix — pass values in `context`.
    const safeContext = context ? (redact(context) as Record<string, unknown>) : undefined;

    if (!this.structured) {
      const suffix = safeContext ? ` ${JSON.stringify(safeContext)}` : '';
      const line = `[${level}] [${this.scope}] ${message}${suffix}`;
      if (level === 'error') process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
      return;
    }

    const serialized = JSON.stringify({
      level,
      time: new Date().toISOString(),
      scope: this.scope,
      message,
      ...safeContext,
    });
    if (level === 'error') process.stderr.write(`${serialized}\n`);
    else process.stdout.write(`${serialized}\n`);
  }
}
