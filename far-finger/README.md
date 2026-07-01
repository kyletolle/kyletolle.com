# Far Finger — Drifting Clouds

Animated Perlin/simplex-noise clouds drifting over the *Thoughts of an Eaten Sun* map
of the Far Finger. Pure client-side: clouds are generated live in the browser every
frame from 3D simplex noise — nothing is pre-rendered. Single static file, one image,
no build step, no dependencies.

**Live:** https://kyletolle.com/far-finger/

## Deploy

From this repo, using the `deploy-static` tool (batcave-private):

```bash
deploy-static ~/projects/kyletolle.com/far-finger far-finger
```

Syncs to `s3://kyletolle.com/far-finger/`, invalidates the CloudFront path, verifies
the URL. `.deployignore` keeps this README out of the public payload.

## Source art

The shipped map (`assets/far-finger-map-v6.jpg`, ~1.5 MB) is a downsized export of the
full-res source PNG (~15 MB), which lives privately in
`batcave-private/far-finger-clouds/assets/` — kept out of this public repo for weight
and to avoid publishing the high-res original. Regenerate the JPEG with ImageMagick:

```bash
convert far-finger-map-v6.png -resize 2560x -strip -interlace Plane -quality 88 \
  far-finger-map-v6.jpg
```

## Controls

Coverage, cloud size, edge softness, opacity, wind speed/direction, morph (clouds
form and dissipate over time), detail octaves, cloud tint. Presets: Gentle / Brooding
/ Wisps. Press **H** or the ⚙ button to hide the panel.
