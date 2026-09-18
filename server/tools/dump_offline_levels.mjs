// Dump the offline fallback's Harvest and Refiner's Fire levels as JSON, for
// server/tools/verify_offline_goals.py to play with the simulator.
//
//   node server/tools/dump_offline_levels.mjs > /tmp/offline.json
//   python3 server/tools/verify_offline_goals.py /tmp/offline.json
// content.js pulls in api.js, which reads `window` when it loads to find an
// API base. Nothing here ever calls the API, so a bare stub is enough to let
// the module load outside a browser.
globalThis.window = globalThis.window || {};

const { localFallbackLevel } = await import('../../js/content.js');

// The onboarding, the stretch where both modes used to become unwinnable, the
// old plateau, then the endless range: the opening and the peak of the first
// eras, and a couple of absurdly deep chapters — the same spread
// server/tools/goal_report.py sweeps.
const CHAPTERS = [1, 2, 3, 4, 5, 8, 10, 14, 20, 30, 40,
                  41, 45, 50, 55, 60, 61, 70, 80, 101, 110, 120, 161, 180,
                  334, 500, 1000];
const CHAPTER_SIZE = 15;

const out = {};
// All three modes, not just the two with a non-score objective: past the
// endless range every mode's chapter mixes objectives, so Grace Path is no
// longer "the one where nothing is ever collected".
for (const mode of ['grace-path', 'harvest', 'refiners-fire']) {
  for (const chapter of CHAPTERS) {
    for (let slot = 0; slot < CHAPTER_SIZE; slot++) {
      const index = (chapter - 1) * CHAPTER_SIZE + slot;
      out[`${mode}:${index}`] = localFallbackLevel(mode, index);
    }
  }
}
process.stdout.write(JSON.stringify(out));
