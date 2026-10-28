# CampusPath standalone map

Interactive Chandigarh University campus map for Gharuan, Mohali.

## Run locally

From this folder, serve the project over HTTP so the browser can load GeoJSON:

```powershell
python -m http.server 8000
```

Open `http://127.0.0.1:8000/index.html`.

The map uses Leaflet and OpenStreetMap-compatible tiles. Its local layers are:

- `data/buildings.geojson` — individual building footprints.
- `data/roads.geojson` — vehicle, service, and surrounding roads.
- `data/paths.geojson` — walking paths and pedestrian ways.
- `data/landmarks.geojson` — named facilities and points of interest.
- `data/campus_boundary.geojson` — campus outline only.
- `data/building_name_verification.json` — verified-name overrides and unresolved footprint records.

Regenerate the layers from the root project with `python scripts/convert_map.py`. Source OSM files are kept in `source-data/`; routing graph exports are kept in `data/graph/`.
