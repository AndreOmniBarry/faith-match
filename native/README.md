# Native particle engine

`particles.cpp` is real C++ — a struct-of-arrays particle physics
simulation (gravity/drag on ambient embers, real centripetal motion on
emblem-orbiting motes, a deterministic embedded PRNG) — compiled to
WebAssembly via Emscripten and driving the splash screen's GPU particle
field (see `js/splash-fx.js`).

## Rebuilding

Requires Emscripten (`apt-get install emscripten` on Debian/Ubuntu, or see
https://emscripten.org/docs/getting_started/downloads.html).

```bash
cd native
emcc particles.cpp -O3 \
  -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=0 -s EXPORT_NAME=createParticlesModule \
  -s ENVIRONMENT=web -s ALLOW_MEMORY_GROWTH=0 -s TOTAL_STACK=131072 -s INITIAL_MEMORY=2097152 \
  -s EXPORTED_FUNCTIONS='["_fm_init","_fm_configure","_fm_step","_fm_count","_fm_get_x","_fm_get_y","_fm_get_size","_fm_get_alpha","_fm_get_hue","_fm_get_kind"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF32","HEAPU8"]' \
  -o particles.js
cp particles.js particles.wasm ../js/vendor/
```

The compiled output (`particles.js` + `particles.wasm`) is checked into
`js/vendor/` — that's what the app actually loads at runtime, not
anything in this folder. This folder is source only.
