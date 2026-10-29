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
- `data/feature_node_mapping.json` — non-destructive named-feature to graph-node mappings.
- `data/graph/` — graph CSV/GraphML exports used by the routing demo.

Regenerate the layers and graph exports from the root project with `python scripts/convert_map.py`, then regenerate feature mappings with `python scripts/build_feature_node_mapping.py`. The routing UI supports Dijkstra (shortest distance) and BFS (fewest graph edges). Source OSM files are kept in `source-data/`.

## GPS navigation

Select a mapped destination and choose **Start Navigation**. The browser requests a high-accuracy location, shows the live position and reported accuracy, snaps it to a connected pedestrian/service graph node within 150 m, and draws a Dijkstra route to the destination. GPS navigation uses an explicit walking-speed estimate of 1.4 m/s for the displayed time. Coordinates are kept in memory and are not sent to external services or saved.

The source search also provides **Current Location**. Campus routing is allowed only when the GPS fix is confidently inside the supplied campus boundary. Outside-campus fixes remain visible as GPS markers but do not produce campus routes; fixes whose accuracy overlaps the boundary are reported as uncertain until a clearer fix arrives.

Fixes with reported accuracy above 100 m are never accepted for campus classification or routing. The raw GPS marker and accuracy circle may still be shown, with the status explicitly marked as not accepted for routing.

Use **Recenter on my location**, **Retry GPS**, or **Stop Navigation** as needed. GPS requires HTTPS or localhost and browser permission. This is live position plus graph-route display, not turn-by-turn or voice navigation. The underlying graph has disconnected components and is not fully validated for pedestrian coverage, so no route is shown when the snap or graph safety checks fail.
