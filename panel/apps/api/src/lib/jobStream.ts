export type JobLogEvent = { line?: string; done?: boolean };

interface JobState {
  logs: string[];
  done: boolean;
  subscribers: Set<(ev: JobLogEvent) => void>;
}

const jobs = new Map<string, JobState>();

export function initJobLog(jobId: string) {
  jobs.set(jobId, { logs: [], done: false, subscribers: new Set() });
}

export function emitJobLog(jobId: string, message: string) {
  const line = `[${new Date().toISOString()}] ${message}`;
  const state = jobs.get(jobId);
  if (!state) return;
  state.logs.push(line);
  state.subscribers.forEach((cb) => cb({ line }));
}

export function finishJobLog(jobId: string) {
  const state = jobs.get(jobId);
  if (!state) return;
  state.done = true;
  state.subscribers.forEach((cb) => cb({ done: true }));
  state.subscribers.clear();
  setTimeout(() => {
    jobs.delete(jobId);
  }, 5 * 60 * 1000);
}

export function subscribeJobLog(jobId: string, cb: (ev: JobLogEvent) => void): () => void {
  const state = jobs.get(jobId);
  if (!state) {
    cb({ line: `[${new Date().toISOString()}] Job not found or already expired.`, done: true });
    return () => {};
  }

  for (const line of state.logs) {
    cb({ line });
  }
  if (state.done) {
    cb({ done: true });
    return () => {};
  }

  state.subscribers.add(cb);
  return () => {
    state.subscribers.delete(cb);
  };
}
