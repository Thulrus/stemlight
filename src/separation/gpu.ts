/**
 * True when WebGPU is backed by real hardware. Browsers can expose navigator.gpu with no
 * adapter (Firefox on Linux, for now), or a software fallback (SwiftShader) that is far
 * slower than WASM, and both should be treated as "no GPU".
 */
export async function hasRealGpu(): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
  if (!adapter) return false;
  const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
  const software = /swiftshader|llvmpipe|lavapipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`);
  console.info(`[gpu] WebGPU adapter: ${info.vendor} ${info.architecture}${software || info.isFallbackAdapter ? ' (software, skipped)' : ''}`);
  return !software && !info.isFallbackAdapter;
}

/**
 * Whether an error came from the GPU running out of memory (or the device being lost), as
 * opposed to a bug. WebGPU reports an out-of-memory buffer allocation and then fails every
 * operation that touches that buffer with "Invalid Buffer … due to a previous error".
 */
export function isGpuMemoryError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /OUT_OF_DEVICE_MEMORY|out of memory|Invalid (Command)?Buffer|WebGPU validation failed|device (was )?lost/i.test(msg);
}
