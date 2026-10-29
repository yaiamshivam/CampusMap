import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from routing import boundary_state, bfs, dijkstra, haversine_m, point_in_geometry, snap_features, snap_point


class RoutingTests(unittest.TestCase):
    def test_dijkstra_minimizes_distance(self):
        graph = {"a": [{"to": "b", "length": 10}, {"to": "c", "length": 2}], "b": [{"to": "d", "length": 2}], "c": [{"to": "d", "length": 20}], "d": []}
        self.assertEqual(dijkstra(graph, "a", "d"), {"nodes": ["a", "b", "d"], "distance_m": 12})

    def test_bfs_minimizes_edges_not_distance(self):
        graph = {"a": [{"to": "b", "length": 100}, {"to": "c", "length": 1}], "b": [{"to": "d", "length": 100}], "c": [{"to": "e", "length": 1}], "e": [{"to": "d", "length": 1}], "d": []}
        self.assertEqual(bfs(graph, "a", "d")["nodes"], ["a", "b", "d"])

    def test_disconnected_graph_returns_none(self):
        self.assertIsNone(dijkstra({"a": [], "b": []}, "a", "b"))

    def test_missing_node_is_rejected(self):
        with self.assertRaises(KeyError):
            dijkstra({"a": []}, "a", "missing")

    def test_coordinate_order_and_distance(self):
        self.assertLess(haversine_m([76.57411, 30.76846], [76.57411, 30.76846]), 0.001)
        self.assertGreater(haversine_m([76.57411, 30.76846], [76.57511, 30.76846]), 90)

    def test_snap_distance_limit(self):
        feature = {"id": "way/1", "geometry": {"type": "Point", "coordinates": [76.57411, 30.76846]}, "properties": {"name": "Test", "feature_type": "landmark"}}
        mappings, unmapped = snap_features([feature], {"n": {"lon": 76.57411, "lat": 30.76846}}, 10)
        self.assertEqual(mappings[0]["node_id"], "n")
        mappings, unmapped = snap_features([feature], {"n": {"lon": 77, "lat": 31}}, 10)
        self.assertEqual(len(mappings), 0)
        self.assertEqual(unmapped[0]["feature_id"], "way/1")

    def test_gps_snap_uses_only_suitable_candidates(self):
        nodes = {"pedestrian": {"lon": 76.57411, "lat": 30.76846}, "road": {"lon": 76.575, "lat": 30.76846}}
        result = snap_point([76.57411, 30.76846], nodes, {"pedestrian"}, 150)
        self.assertEqual(result["node_id"], "pedestrian")

    def test_gps_snap_rejects_excessive_distance(self):
        self.assertIsNone(snap_point([77, 31], {"node": {"lon": 76.57411, "lat": 30.76846}}, {"node"}, 150))

    def test_navigation_route_recalculation_can_be_unreachable(self):
        graph = {"start": [{"to": "middle", "length": 5}], "middle": [], "destination": []}
        self.assertIsNone(dijkstra(graph, "middle", "destination"))

    def test_boundary_inside_outside_and_uncertain_accuracy(self):
        square = {"type": "Polygon", "coordinates": [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]]}
        self.assertTrue(point_in_geometry([0.005, 0.005], square))
        self.assertEqual(boundary_state([0.005, 0.005], 10, square), "inside")
        self.assertEqual(boundary_state([0.02, 0.005], 10, square), "outside")
        self.assertEqual(boundary_state([0.00001, 0.00001], 10, square), "uncertain")
        self.assertEqual(boundary_state([0.005, 0.005], 241, square), "uncertain")


if __name__ == "__main__":
    unittest.main()
