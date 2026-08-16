# Audio assets

Drop real audio files into these two folders using the exact filenames
below. `js/audio.js` looks for each of these by path; any file that isn't
present is skipped silently (no error, no console spam) — so you can add
files one at a time and everything else stays exactly as quiet as it is
today.

Supported formats: `.mp3` or `.ogg` (the loader tries `.mp3` first, then
falls back to `.ogg` with the same base name — use whichever you have).

## `assets/audio/music/` — looping background tracks

| File | Used for |
|---|---|
| `theme-main.mp3` | Splash / loading / mode-select / chapter / dashboard screens |
| `theme-gameplay.mp3` | Default in-level loop, used by any mode without its own override below |
| `theme-grace-path.mp3` | *(optional)* overrides the gameplay loop for Grace Path only |
| `theme-harvest.mp3` | *(optional)* overrides the gameplay loop for Harvest only |
| `theme-refiners-fire.mp3` | *(optional)* overrides the gameplay loop for Refiner's Fire only |
| `theme-daily-blessing.mp3` | *(optional)* overrides the gameplay loop for Daily Blessing only |

With just your two current tracks: name one `theme-main.mp3` and the
other `theme-gameplay.mp3` — that alone covers every screen and every
mode with no per-mode overrides needed. Add the per-mode files later only
if/when you want a given mode to sound different from the rest.

## `assets/audio/sfx/` — one-shot effects

| File | Fires on |
|---|---|
| `pop.mp3` | A basic match clears |
| `special.mp3` | A striped/wrapped/color-bomb tile is created or fires |
| `swap-fail.mp3` | An illegal swap snaps back |
| `crack.mp3` | A veil layer breaks (Refiner's Fire) |
| `win.mp3` | Level complete |
| `lose.mp3` | Out of moves / level failed |
| `surge.mp3` | Combo Surge meter fires |
| `finale.mp3` | Entering a chapter finale level |
| `gate.mp3` | Hitting a star-gate |
| `streak.mp3` | Daily Blessing streak milestone |
| `tap.mp3` | General UI button tap |
| `screen-in.mp3` | Navigating into a new screen |
| `screen-back.mp3` | Navigating back |
| `splash.mp3` | *(unassigned — free slot)* reserved for a water/aquatic accent if you want one wired to a specific moment; ask and it'll get mapped to something |

None of this needs a code change to activate — just add files with these
names and reload.
