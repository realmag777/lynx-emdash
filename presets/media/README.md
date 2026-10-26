# Preset demo media

Demo photos for the two LYNX seed presets (cars, Spanish-coast real estate).

**All images here are AI-generated** with the OpenAI Codex CLI's built-in `image_gen` tool
(ChatGPT subscription), for demo purposes only. They show no real vehicles, properties,
brands or people.

- `cars/car-XX.jpg`, `properties/prop-XX.jpg`: web copies used by the seed
  (JPEG, max 1280 px on the long side, quality 82; the originals are 1254x1254, so the JPEGs are too).
- `_originals/*.png`: the full-size PNGs as generated (git-ignored).
- Regenerate or resume: `powershell -NoProfile -File presets\tools\generate-images.ps1`
  (skips images that already exist; `-Only car-03` for one image, `-ConvertOnly` for JPEGs only).
  The image list and prompts live inside that script; a run log is in `presets/tools/generation-log.md`.

## Shared style (appended to every prompt)

> Photorealistic photograph, natural daylight, looks like a professional classifieds / listing photo,
> composition with a 3:2 landscape feel placed inside the square frame. No text, no captions,
> no watermarks, no people or faces, no brand logos, no emblems or badges, no trademarks,
> no readable licence plates (plates blank or not visible).

Car exteriors also get: *"The car is a generic, unbranded design that does not resemble any
specific real manufacturer or model; no grille emblem, no badges, no lettering anywhere."*
Property prompts also get: *"Spanish Mediterranean coast setting."*

## Cars

| File | Prompt |
|---|---|
| `cars/car-01.jpg` | A silver compact 5-door hatchback, front three-quarter view, parked on a clean car dealership forecourt. |
| `cars/car-02.jpg` | A black premium executive sedan, side three-quarter view, parked on a city street. |
| `cars/car-03.jpg` | A white mid-size SUV, front three-quarter view, inside a modern car showroom with glass walls. |
| `cars/car-04.jpg` | A dark blue estate car (station wagon), rear three-quarter view, parked on a suburban house driveway. |
| `cars/car-05.jpg` | A red small city car, front view, parked on a narrow Mediterranean town street. |
| `cars/car-06.jpg` | A graphite grey electric fastback sedan, front three-quarter view, parked at an EV charging station with the cable plugged in. |
| `cars/car-07.jpg` | A dark green compact crossover, side view, parked beside a countryside road with fields behind. |
| `cars/car-08.jpg` | A white 7-seat MPV (minivan), front three-quarter view, parked in an open-air car park. |
| `cars/car-09.jpg` | Car interior: a modern dashboard and steering wheel with digital instrument cluster and a centre touchscreen, photographed from the rear seat area; no logos or emblems on the steering wheel, screens show only abstract graphics without readable text. |
| `cars/car-10.jpg` | Car interior: the rear seat bench with light beige leather upholstery, photographed through the open rear door; clean and well kept, no logos. |
| `cars/car-11.jpg` | A pearl white large SUV, rear three-quarter view, parked on a coastal road at golden hour with the sea behind. |
| `cars/car-12.jpg` | An orange sporty compact hatchback, front three-quarter view, parked in an urban car park. |

## Properties (Spanish Mediterranean coast)

| File | Prompt |
|---|---|
| `properties/prop-01.jpg` | Exterior of a modern white villa with an infinity pool and a sea view. |
| `properties/prop-02.jpg` | Bright apartment living room with large windows and a balcony, the sea visible in the distance. |
| `properties/prop-03.jpg` | Modern fitted kitchen with an island, light wood and white finishes, in a coastal apartment. |
| `properties/prop-04.jpg` | Master bedroom with calm neutral decor, made bed, soft daylight. |
| `properties/prop-05.jpg` | Bathroom with a walk-in glass shower and marble tiles. |
| `properties/prop-06.jpg` | Exterior of a contemporary apartment building with balconies and palm trees in front. |
| `properties/prop-07.jpg` | Terrace with outdoor furniture overlooking the sea. |
| `properties/prop-08.jpg` | Row of whitewashed Andalusian-style townhouses, street view exterior. |
| `properties/prop-09.jpg` | Small studio apartment interior, compact and tidy, sofa bed, kitchenette and window. |
| `properties/prop-10.jpg` | Penthouse roof terrace with a city view at dusk, warm lights starting to glow. |
| `properties/prop-11.jpg` | Rustic stone country house (finca) surrounded by olive trees. |
| `properties/prop-12.jpg` | Private house garden with a lawn, a swimming pool and sun loungers. |
