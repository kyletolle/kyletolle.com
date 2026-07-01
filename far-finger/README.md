# Far Finger — Drifting Clouds

Animated Perlin/simplex-noise clouds drifting over the *Thoughts of an Eaten Sun* map
of the Far Finger. Pure client-side: clouds are generated live in the browser every
frame from 3D simplex noise — nothing is pre-rendered. Single static file, one image,
no build step, no dependencies.

**Live:** https://kyletolle.com/far-finger/

## Controls

Coverage, cloud size, edge softness, opacity, wind speed/direction, morph (clouds
form and dissipate over time), detail octaves, cloud tint. Presets: Gentle / Brooding
/ Wisps. Press **H** or the ⚙ button to hide the panel.

## The map

The shipped map (`assets/far-finger-map-v6.jpg`, ~1.5 MB) is a downsized export of a
larger source PNG. Regenerate the JPEG with ImageMagick:

```bash
convert far-finger-map-v6.png -resize 2560x -strip -interlace Plane -quality 88 \
  far-finger-map-v6.jpg
```
