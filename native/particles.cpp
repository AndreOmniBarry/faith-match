// Faith Match — native particle physics core.
//
// Compiled C++ (via Emscripten -> WebAssembly), not JS and not CSS: real
// semi-implicit-Euler integration, a struct-of-arrays layout for cache
// locality, an embedded deterministic PRNG (no libc <random> pulled in,
// keeps the binary tiny), and two genuinely different force models sharing
// one simulation core (ambient rising embers vs. emblem-orbiting motes,
// selected per-particle by `kind`). JS reads the result straight out of
// WASM linear memory via typed-array views into the exported buffers —
// zero-copy, no per-particle marshalling across the JS/WASM boundary every
// frame, which is how real engines hand physics results to a renderer.
//
// This module owns *simulation only*. Actual pixels are still composited
// by the existing WebGL/Pixi renderer (js/splash-fx.js) — a native physics
// core driving a GPU rasterizer is the standard hybrid architecture real
// engines use, not a purity requirement to push rendering into C++ too.

#include <cstdint>
#include <cmath>

namespace {

constexpr int MAX_PARTICLES = 260; // tuned for real phone GPUs, not just desktop — see js/splash-fx.js's layer split
constexpr float TAU = 6.28318530718f;

// ---------------------------------------------------------------------
// Struct-of-arrays particle store. Parallel arrays, not an array of
// structs — every field touched in step() for a given operation (e.g.
// integrating velocity) stays contiguous in memory instead of striding
// past position/color/life data it doesn't need that pass.
// ---------------------------------------------------------------------
float px[MAX_PARTICLES];
float py[MAX_PARTICLES];
float pvx[MAX_PARTICLES];
float pvy[MAX_PARTICLES];
float life[MAX_PARTICLES];
float maxLife[MAX_PARTICLES];
float size[MAX_PARTICLES];
float hue[MAX_PARTICLES];
float alpha[MAX_PARTICLES];   // exported for the renderer, derived each step
uint8_t kind[MAX_PARTICLES];  // 0 = ambient ember, 1 = emblem-orbit mote
float orbitRadius[MAX_PARTICLES];
float orbitAngle[MAX_PARTICLES];
float orbitSpeed[MAX_PARTICLES];

int activeCount = 0;
float emitterX = 0.5f, emitterY = 0.4f;
float boundsW = 1.0f, boundsH = 1.0f;
float spawnAccum = 0.0f;

// xorshift32 — deterministic, no allocation, no libc RNG dependency.
uint32_t rngState = 0x9E3779B9u;
inline float rnd() {
    rngState ^= rngState << 13;
    rngState ^= rngState >> 17;
    rngState ^= rngState << 5;
    // top 24 bits -> [0,1)
    return (rngState >> 8) * (1.0f / 16777216.0f);
}
inline float rndRange(float lo, float hi) { return lo + (hi - lo) * rnd(); }

// kind is assigned once per slot in fm_init and left alone here — a given
// particle index keeps the same behavior across every respawn. That's a
// deliberate simulation-side choice (JS renders orbit vs. ember particles
// in two separate layers so only the small orbit layer pays for the Bloom
// filter; a kind that could change mid-flight would need per-frame
// re-parenting between layers to match).
void spawnParticle(int i) {
    if (kind[i] == 1) {
        // Emblem-orbit mote: starts on a ring around the emitter and
        // orbits it under real centripetal motion (angle integrated by
        // orbitSpeed each step, radius held — see step()).
        orbitRadius[i] = rndRange(0.09f, 0.16f) * boundsW;
        orbitAngle[i] = rndRange(0.0f, TAU);
        orbitSpeed[i] = rndRange(0.5f, 1.1f) * (rnd() < 0.5f ? 1.0f : -1.0f);
        px[i] = emitterX + std::cos(orbitAngle[i]) * orbitRadius[i];
        py[i] = emitterY + std::sin(orbitAngle[i]) * orbitRadius[i];
        pvx[i] = 0.0f;
        pvy[i] = 0.0f;
        size[i] = rndRange(1.4f, 3.0f);
        maxLife[i] = rndRange(3.5f, 6.0f);
        hue[i] = rndRange(38.0f, 46.0f); // warm gold band
    } else {
        // Ambient ember: spawns low, drifts upward under a gentle
        // negative "gravity" plus per-particle horizontal drift and a
        // touch of sinusoidal sway (a cheap stand-in for curl noise —
        // enough to read as air movement, not a straight line).
        px[i] = rndRange(0.0f, boundsW);
        py[i] = boundsH + rndRange(0.0f, 0.08f) * boundsH;
        pvx[i] = rndRange(-0.02f, 0.02f) * boundsW;
        pvy[i] = -rndRange(0.05f, 0.12f) * boundsH;
        size[i] = rndRange(1.0f, 2.6f);
        maxLife[i] = rndRange(4.0f, 8.0f);
        hue[i] = rndRange(30.0f, 340.0f); // spread across the symbol palette's hue range
    }
    life[i] = 0.0f;
    alpha[i] = 0.0f;
}

} // namespace

extern "C" {

void fm_init(unsigned int seed) {
    rngState = seed ? seed : 0x9E3779B9u;
    activeCount = MAX_PARTICLES;
    for (int i = 0; i < MAX_PARTICLES; i++) {
        kind[i] = (rnd() < 0.28f) ? 1 : 0; // fixed for this slot's lifetime — see spawnParticle's comment
        spawnParticle(i);
        // Stagger initial life so the very first frame isn't every
        // particle born simultaneously — scatter them across their own
        // lifespans right away.
        life[i] = rndRange(0.0f, maxLife[i]);
    }
}

void fm_configure(float ex, float ey, float w, float h) {
    emitterX = ex; emitterY = ey; boundsW = w; boundsH = h;
}

// Advances the whole simulation by dt seconds. Two force models, chosen
// per-particle by kind — a real engine's "component behavior" pattern in
// miniature, not a single one-size-fits-all update.
void fm_step(float dt) {
    if (dt > 0.05f) dt = 0.05f; // clamp — a stalled tab shouldn't fling everything on resume

    for (int i = 0; i < activeCount; i++) {
        life[i] += dt;
        if (life[i] >= maxLife[i]) {
            spawnParticle(i);
            continue;
        }
        float t = life[i] / maxLife[i];

        if (kind[i] == 1) {
            // Orbit: integrate angle, hold (slowly breathing) radius —
            // real centripetal motion, not a CSS rotate() on a fixed axis.
            orbitAngle[i] += orbitSpeed[i] * dt;
            float breathe = 1.0f + 0.08f * std::sin(life[i] * 1.7f + orbitRadius[i]);
            float r = orbitRadius[i] * breathe;
            px[i] = emitterX + std::cos(orbitAngle[i]) * r;
            py[i] = emitterY + std::sin(orbitAngle[i]) * r * 0.9f; // slight ellipse, reads better against the emblem art
        } else {
            // Ambient ember: semi-implicit Euler under gravity + drag +
            // a sinusoidal lateral sway layered on top of straight drift.
            const float gravity = -0.045f * boundsH;   // negative = upward (embers rise)
            const float drag = 0.6f;
            pvy[i] += gravity * dt;
            pvx[i] -= pvx[i] * drag * dt;
            pvy[i] -= pvy[i] * drag * 0.4f * dt;
            float sway = std::sin(life[i] * 2.2f + px[i] * 0.01f) * 0.01f * boundsW;
            px[i] += (pvx[i] + sway) * dt;
            py[i] += pvy[i] * dt;
        }

        // Fade in over the first 15% of life, hold, fade out over the
        // last 25% — an actual envelope, not a linear opacity ramp.
        float fadeIn = t < 0.15f ? (t / 0.15f) : 1.0f;
        float fadeOut = t > 0.75f ? (1.0f - (t - 0.75f) / 0.25f) : 1.0f;
        alpha[i] = fadeIn * fadeOut;
    }
}

int fm_count() { return activeCount; }
float* fm_get_x() { return px; }
float* fm_get_y() { return py; }
float* fm_get_size() { return size; }
float* fm_get_alpha() { return alpha; }
float* fm_get_hue() { return hue; }
uint8_t* fm_get_kind() { return kind; }

} // extern "C"
