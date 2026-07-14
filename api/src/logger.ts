function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(`[${ts()}] INFO  ${msg}`, meta ? JSON.stringify(meta) : ''),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(`[${ts()}] WARN  ${msg}`, meta ? JSON.stringify(meta) : ''),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(`[${ts()}] ERROR ${msg}`, meta ? JSON.stringify(meta) : ''),
};
