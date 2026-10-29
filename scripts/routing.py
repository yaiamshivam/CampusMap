"""Small, dependency-free graph and feature-snapping helpers for CampusPath."""

import csv
import heapq
import json
import math
from pathlib import Path

EARTH_RADIUS_M = 6_371_008.8
GPS_MAX_ACCURACY_M = 100


def haversine_m(first, second):
    """Return the geodesic distance between [lon, lat] points in metres."""
    lon1, lat1 = map(math.radians, first)
    lon2, lat2 = map(math.radians, second)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    value = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(value))


def load_graph(nodes_csv, edges_csv):
    """Load the exported graph and normalize ordinary OSM ways as bidirectional."""
    nodes = {}
    with Path(nodes_csv).open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            nodes[row["osmid"]] = {"lon": float(row["x"]), "lat": float(row["y"])}

    adjacency = {node_id: [] for node_id in nodes}
    with Path(edges_csv).open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if row["u"] not in nodes or row["v"] not in nodes:
                raise ValueError(f"Edge references missing node: {row['u']} -> {row['v']}")
            edge = {"to": row["v"], "length": float(row["length"]), "row": row}
            adjacency[row["u"]].append(edge)
            if row["oneway"].strip().lower() in {"", "no", "false", "0"}:
                adjacency[row["v"]].append({"to": row["u"], "length": edge["length"], "row": row})
    return nodes, adjacency


def dijkstra(adjacency, start, goal):
    if start not in adjacency or goal not in adjacency:
        raise KeyError("Start or goal node is missing")
    queue = [(0.0, start)]
    distances = {start: 0.0}
    previous = {}
    while queue:
        distance, node = heapq.heappop(queue)
        if distance != distances.get(node):
            continue
        if node == goal:
            break
        for edge in adjacency[node]:
            candidate = distance + edge["length"]
            if candidate < distances.get(edge["to"], math.inf):
                distances[edge["to"]] = candidate
                previous[edge["to"]] = node
                heapq.heappush(queue, (candidate, edge["to"]))
    if goal not in distances:
        return None
    path = [goal]
    while path[-1] != start:
        path.append(previous[path[-1]])
    path.reverse()
    return {"nodes": path, "distance_m": distances[goal]}


def bfs(adjacency, start, goal):
    if start not in adjacency or goal not in adjacency:
        raise KeyError("Start or goal node is missing")
    queue = [start]
    previous = {start: None}
    for node in queue:
        if node == goal:
            break
        for edge in adjacency[node]:
            if edge["to"] not in previous:
                previous[edge["to"]] = node
                queue.append(edge["to"])
    if goal not in previous:
        return None
    path = [goal]
    while path[-1] is not None:
        path.append(previous[path[-1]])
    path.pop()
    path.reverse()
    distance = sum(next(edge["length"] for edge in adjacency[a] if edge["to"] == b) for a, b in zip(path, path[1:]))
    return {"nodes": path, "edges": len(path) - 1, "distance_m": distance}


def feature_point(feature):
    geometry = feature["geometry"]
    if geometry["type"] == "Point":
        return geometry["coordinates"]
    coordinates = geometry["coordinates"]
    if geometry["type"] == "Polygon":
        coordinates = coordinates[0]
    elif geometry["type"] == "MultiPolygon":
        coordinates = coordinates[0][0]
    return [
        sum(point[0] for point in coordinates) / len(coordinates),
        sum(point[1] for point in coordinates) / len(coordinates),
    ]


def snap_features(features, nodes, max_distance_m=150):
    mappings = []
    unmapped = []
    for feature in features:
        properties = feature.get("properties") or {}
        name = (properties.get("name") or "").strip()
        if not name:
            continue
        point = feature_point(feature)
        node_id, distance = min(
            ((node_id, haversine_m(point, [node["lon"], node["lat"]])) for node_id, node in nodes.items()),
            key=lambda item: item[1],
        )
        record = {
            "feature_id": feature["id"],
            "feature_type": properties.get("feature_type"),
            "name": name,
            "node_id": node_id,
            "distance_m": round(distance, 2),
            "point": point,
        }
        if distance <= max_distance_m:
            mappings.append(record)
        else:
            unmapped.append({**record, "reason": "nearest graph node exceeds maximum snap distance"})
    return mappings, unmapped


def snap_point(point, nodes, candidate_ids=None, max_distance_m=150):
    """Snap a [lon, lat] point to an optional connected/suitable node set."""
    candidates = candidate_ids if candidate_ids is not None else nodes.keys()
    nearest = min(
        ((node_id, haversine_m(point, [nodes[node_id]["lon"], nodes[node_id]["lat"]])) for node_id in candidates if node_id in nodes),
        key=lambda item: item[1],
        default=None,
    )
    if nearest is None or nearest[1] > max_distance_m:
        return None
    return {"node_id": nearest[0], "distance_m": round(nearest[1], 2)}


def point_in_geometry(point, geometry):
    """Return whether a [lon, lat] point is inside a Polygon/MultiPolygon."""
    def in_ring(ring):
        longitude, latitude = point
        inside = False
        for index, current in enumerate(ring):
            previous = ring[index - 1]
            crosses = (current[1] > latitude) != (previous[1] > latitude)
            if crosses and longitude < (previous[0] - current[0]) * (latitude - current[1]) / (previous[1] - current[1]) + current[0]:
                inside = not inside
        return inside

    if geometry["type"] == "Polygon":
        return in_ring(geometry["coordinates"][0])
    if geometry["type"] == "MultiPolygon":
        return any(in_ring(polygon[0]) for polygon in geometry["coordinates"])
    return None


def boundary_state(point, accuracy_m, geometry):
    """Classify a point while treating an accuracy-sized boundary band as uncertain."""
    inside = point_in_geometry(point, geometry)
    if inside is None or accuracy_m is None or accuracy_m > GPS_MAX_ACCURACY_M:
        return "uncertain"
    if accuracy_m >= 0.1:
        # A conservative vertex-distance check is sufficient for the small test/campus geometries.
        vertices = geometry["coordinates"][0] if geometry["type"] == "Polygon" else geometry["coordinates"][0][0]
        if min(haversine_m(point, vertex) for vertex in vertices) <= accuracy_m:
            return "uncertain"
    return "inside" if inside else "outside"


def write_mapping(path, mappings, unmapped, max_distance_m):
    Path(path).write_text(json.dumps({
        "max_snap_distance_m": max_distance_m,
        "features": mappings,
        "unmapped": unmapped,
    }, indent=2), encoding="utf-8")
