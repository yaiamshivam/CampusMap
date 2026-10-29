# CampusPath graph audit

## Evidence

- `campus-map/data/graph/nodes.csv` has columns `osmid`, `y`, `x`, and `geometry`.
- `y` is latitude and `x` is longitude. The WKT geometry confirms `POINT (x y)`, so GeoJSON/Leaflet coordinates must be emitted as `[longitude, latitude]` and `[latitude, longitude]` respectively.
- `campus-map/data/graph/edges.csv` has `u`, `v`, `key`, `osmid`, `highway`, `name`, `oneway`, `length`, and `geometry`.
- Edge lengths are calculated by the converter with the haversine formula and are metres. The current range is 0.38 m to 255.77 m.
- `campus_graph.graphml` contains 788 nodes and 845 directed edges, matching the CSV export.
- The graph has no missing endpoints, self-loops, or duplicate undirected endpoint pairs. It has three weakly connected components with sizes 714, 63, and 11.
- The graph includes 71 `footway`, 397 `service`, and 63 `track` edges, so it contains internal pedestrian/service links. It also includes 55 `trunk` edges and surrounding roads; routing should therefore be described as graph-based campus routing, not a fully pedestrian-validated network.

## Routing interpretation

The source graph is exported as directed. The routing layer preserves `oneway=yes` direction and adds the reverse traversal only for blank/`no`/false-like `oneway` values, matching ordinary OSM bidirectional-way semantics without changing the source exports.

Named buildings and landmarks are mapped in `campus-map/data/feature_node_mapping.json` using haversine distance and a 150 m maximum snap distance. All 36 named features are within that limit. Unnamed building footprints remain unmapped and unnamed.

The graph does not prove that every internal walkway is present or that every route is accessible to pedestrians. Those limitations require better campus-specific OSM data or a verified campus walkway dataset before claiming complete navigation coverage.
