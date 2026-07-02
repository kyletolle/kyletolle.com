# random

A dice roller with linkable rolls, served static at
[kyletolle.com/random/](https://kyletolle.com/random/).

The URL is the roll: `/random/#2d6+3` parses the hash as dice notation and
rolls it on load. Hash routing means a shareable "API-ish" URL with zero
server — the durable revival of the old `dice_roller` Lambda (originally a
Slack `/roll` command backend).

Notation: `NdM` groups and flat modifiers joined by `+`/`-`, e.g. `2d6`,
`d20`, `3d8+1d4+2`, `2d10-1`. Max results are highlighted, 1s are dimmed.

## Planned (the randomness cluster this page absorbs)

- `random_name_generator` / `kt-random-name-generator` (Deno) — name section
- `random_point_generator` — random map points, maybe with a Leaflet preview
- The Slack `/roll` command itself returns someday as a Cloudflare Worker
