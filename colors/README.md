# colors

A small color playground, served static at [kyletolle.com/colors/](https://kyletolle.com/colors/).

The first durable revival in the kyletolle.com project portfolio: the old
`random-background-color` was a full Ruby on Jets (AWS Lambda) app that shipped
~43 MB to render one random hex value. This is the same idea as a single
dependency-free `index.html` — nothing to deploy but the file, no runtime to
sunset.

## Current

- **Random background color** — click / tap / spacebar to reroll; click the hex to copy. Text auto-contrasts to the background (WCAG luminance).

## Planned (the color cluster this page absorbs)

- `random_color_viewer` / `random-color-viewer` (Deno) — recent-colors strip
- `hex_to_rgb`, `rgb_to_hex_color` — a converter section
- `color_divider` / `color_divider-api` — the color halfway between two colors
- `color-perception` — the "hard to see subtle changes" demo
