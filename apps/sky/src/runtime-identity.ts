export type RuntimeKind = 'node' | 'standalone';

declare const SKY_RUNTIME: RuntimeKind | undefined;

const buildRuntime = typeof SKY_RUNTIME === 'undefined' ? undefined : SKY_RUNTIME;

export const RUNTIME_KIND: RuntimeKind = buildRuntime ?? 'node';
