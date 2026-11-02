import { performance } from "node:perf_hooks";

/**
 * 所有并发流共用一个 setInterval，避免每个请求各自持有定时器。
 * 每个流对象只需要实现 tick(now)。
 */
export class StreamScheduler {
  constructor(tickMs = 20) {
    this.tickMs = tickMs;
    this.streams = new Set();
    this.timer = null;
  }

  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  add(stream) {
    this.streams.add(stream);
    this.ensureTimer();
  }

  remove(stream) {
    this.streams.delete(stream);
    if (this.streams.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get size() {
    return this.streams.size;
  }

  tick() {
    const now = performance.now();
    for (const stream of this.streams) {
      try {
        stream.tick(now);
      } catch (error) {
        this.streams.delete(stream);
        try {
          stream.fail?.(error);
        } catch {
          /* ignore */
        }
      }
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.streams.clear();
  }
}

export const streamScheduler = new StreamScheduler(20);
