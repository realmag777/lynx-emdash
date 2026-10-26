# LYNX presets

Two demo catalogues for EmDash, built from one data definition (`src/cars.ts`, `src/real-estate.ts`):

| Preset | Collection | Revisions | Entries | Taxonomies |
|---|---|---|---|---|
| Cars | `cars` | yes (edits are drafts until published) | 30 (27 published, 3 drafts) | `make` (make → model), `body_type`, `fuel`, `location` |
| Real estate | `properties` | no (edits go live at once) | 30 (27 published, 3 drafts) | `property_type`, `location` (region → city → district), `amenities` |

`location` is shared by both collections. Numeric and identifying fields are `translatable: false`; filter-critical fields are `indexed: true`. `vin` and `ref_code` are marked `unique` (EmDash stores the flag but does not enforce it; LYNX checks it). Images (`media/`) are AI-generated demo photos, see `media/README.md`.

## Install into a running site (REST API)

```bash
node presets/tools/install.ts --url http://localhost:4400 --token ec_pat_… --preset all
```

`--preset cars|real-estate|all`, `--schema-only` skips media and entries. The token needs the `admin` scope. The installer is idempotent: existing collections, fields, taxonomies, terms and entries (by slug) are kept, and media is deduplicated by content hash. The LYNX grid's "Install preset" wizard uses the same `installPreset()`.

## EmDash seed files

```bash
node presets/tools/build-seeds.ts [--media-base https://your-cdn/lynx/media]
```

Writes `cars/seed.json`, `real-estate/seed.json`, `all/seed.json`, each validated with `validateSeed()` from `emdash/seed`. EmDash downloads `$media` URLs through its SSRF guard, so the images must be on a public http(s) host; set `--media-base` (or `LYNX_MEDIA_BASE`) to where `media/` is published. Applying the separate `cars` and `real-estate` seeds to one site does not merge the shared `location` taxonomy: with `onConflict: "skip"` it stays attached to the first collection only, and with `"update"` the second seed replaces its collection list (EmDash `core/src/seed/apply.ts:595-608`). Use `all/seed.json` or the REST installer when you want both.

## Tests

`pnpm --filter @realmag777/lynx-presets test`: every value is checked against its field rules with the LYNX engine, unique fields are unique, every assigned term exists, and every seed passes `validateSeed()`.
