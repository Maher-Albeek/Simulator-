// One analytic atmosphere model, shared by the sky dome, the water reflection
// and the aerial-perspective fog in the post stack, so all three always agree.
// Everything is linear HDR; tone mapping happens once, in the final pass.

export const SUN_DIR = [0.42, 0.52, 0.33];     // normalised in atmosphere.js consumers

export const ATMOSPHERE_GLSL = /* glsl */`
#ifndef ATMOSPHERE_INCLUDED
#define ATMOSPHERE_INCLUDED

const vec3 SKY_ZENITH  = vec3(0.085, 0.245, 0.600);
const vec3 SKY_HORIZON = vec3(0.660, 0.775, 0.920);
const vec3 SKY_GROUND  = vec3(0.330, 0.350, 0.325);
const vec3 SUN_TINT    = vec3(1.000, 0.885, 0.730);

// Henyey-Greenstein-ish forward scattering lobe.
float mieLobe(float c, float g) {
  float gg = g * g;
  return (1.0 - gg) / (12.566 * pow(max(1.0 + gg - 2.0 * g * c, 1e-4), 1.5));
}

// Sky radiance for a view direction (no sun disc).
vec3 skyRadiance(vec3 dir, vec3 sunDir) {
  vec3 d = normalize(dir);
  float up = clamp(d.y, -1.0, 1.0);
  float grad = pow(1.0 - clamp(up, 0.0, 1.0), 2.1);
  vec3 col = mix(SKY_ZENITH, SKY_HORIZON, grad);

  float c = dot(d, sunDir);
  // Broad aureole around the sun plus a wide warm wash over the whole sky.
  col += SUN_TINT * mieLobe(c, 0.76) * 0.55;
  col += SUN_TINT * pow(max(c, 0.0), 3.0) * 0.055;
  // Warm, bright band where the horizon meets the sun's azimuth.
  col += SUN_TINT * grad * pow(max(c, 0.0), 1.6) * 0.22;
  // Slight desaturation of the whole horizon ring (aerosol haze).
  col = mix(col, vec3(dot(col, vec3(0.33))) * 1.04, grad * 0.22);
  // Hazy ground plane below the horizon so the dome never shows hard edges.
  col = mix(col, SKY_GROUND * (0.7 + 0.5 * max(c, 0.0)), smoothstep(0.0, -0.10, up));
  return max(col, vec3(0.0));
}

// Sun disc and its tight glow; kept separate so fog can leave it out.
vec3 sunRadiance(vec3 dir, vec3 sunDir) {
  float c = max(dot(normalize(dir), sunDir), 0.0);
  float disc = smoothstep(0.99965, 0.99992, c);
  return SUN_TINT * (disc * 34.0 + pow(c, 2200.0) * 5.0 + pow(c, 220.0) * 0.35);
}

vec3 skyWithSun(vec3 dir, vec3 sunDir) {
  return skyRadiance(dir, sunDir) + sunRadiance(dir, sunDir);
}

// Aerial perspective: how much of the view is lost to haze over dist, for a
// ray that starts at height y0 and ends at y1.
float aerialAmount(float dist, float y0, float y1, float density, float scaleHeight) {
  float dy = y1 - y0;
  float t;
  if (abs(dy) < 0.5) {
    t = exp(-max(y0, 0.0) / scaleHeight) * dist;
  } else {
    // Analytic integral of exp(-y/H) along the ray.
    t = scaleHeight * dist / dy * (exp(-max(y0, 0.0) / scaleHeight) - exp(-max(y1, 0.0) / scaleHeight));
  }
  return 1.0 - exp(-density * max(t, 0.0));
}
#endif
`;
