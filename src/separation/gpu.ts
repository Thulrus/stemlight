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
