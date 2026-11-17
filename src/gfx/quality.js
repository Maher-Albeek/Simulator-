// Graphics quality presets. These only ever touch rendering: resolution,
// shadow maps, vegetation density and post-processing. Nothing here is read by
// the flight model, so switching preset cannot change how the drone flies.

export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

export const QUALITY = {
  low: {
    label: 'Low',
    pixelRatio: 0.72,
    shadows: true,
    shadowMapSize: 1024,
    shadowDistance: 55,
    softShadows: false,
    msaa: 0,
    fxaa: true,
    bloom: false,
    ssao: false,
    ssaoSamples: 0,
    dof: false,
    grass: 0,
    grassSpacing: 0.95,
    grassBlades: 4,
    grassSegments: 2,
    clump: 0,
    clouds: 18,
    cloudLayers: 1,
    treeDetail: 0,
    distantForest: 0,
    waterDetail: 0,
    anisotropy: 2,
    textureScale: 0.5,
  },
  medium: {
    label: 'Medium',
    pixelRatio: 1,
    shadows: true,
    shadowMapSize: 1536,
    shadowDistance: 70,
    softShadows: true,
    msaa: 0,
    fxaa: true,
    bloom: true,
    ssao: false,
    ssaoSamples: 0,
    dof: false,
    grass: 96,            // grid side; tufts = side²
    grassSpacing: 0.48,
    grassBlades: 4,
    grassSegments: 2,
    clump: 26,
    clouds: 34,
    cloudLayers: 2,
    treeDetail: 1,
    distantForest: 900,
    waterDetail: 1,
    anisotropy: 4,
    textureScale: 0.75,
  },
  high: {
    label: 'High',
    pixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    shadowDistance: 95,
    softShadows: true,
    msaa: 4,
    fxaa: false,
    bloom: true,
    ssao: true,
    ssaoSamples: 12,
    dof: false,
    grass: 148,
    grassSpacing: 0.36,
    grassBlades: 5,
    grassSegments: 2,
    clump: 40,
    clouds: 48,
    cloudLayers: 3,
    treeDetail: 2,
    distantForest: 1800,
    waterDetail: 2,
    anisotropy: 8,
    textureScale: 1,
  },
  ultra: {
    label: 'Ultra',
    pixelRatio: 2,
    shadows: true,
    shadowMapSize: 4096,
    shadowDistance: 120,
    softShadows: true,
    msaa: 4,
    fxaa: false,
    bloom: true,
    ssao: true,
    ssaoSamples: 20,
    dof: true,
    grass: 176,
    grassSpacing: 0.33,
    grassBlades: 6,
    grassSegments: 3,
    clump: 54,
    clouds: 60,
    cloudLayers: 3,
    treeDetail: 2,
    distantForest: 2600,
    waterDetail: 2,
    anisotropy: 16,
    textureScale: 1,
  },
};

const KEY = 'air2s-sim-quality';

export function defaultQuality() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && QUALITY[saved]) return saved;
  } catch { /* private mode */ }
  // Guess from the device: mobile and low-core machines start lower.
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (mobile) return 'low';
  if (cores <= 4) return 'medium';
  return 'high';
}

export function saveQuality(name) {
  try { localStorage.setItem(KEY, name); } catch { /* private mode */ }
}
