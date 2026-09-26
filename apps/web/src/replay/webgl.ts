/**
 * Probe once before loading the 3D bundle. A device without WebGL receives the 2D top view
 * and time-synchronised logs directly; a later WebGL failure still falls back to 2D.
 */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return context !== null;
  } catch {
    return false;
  }
}
