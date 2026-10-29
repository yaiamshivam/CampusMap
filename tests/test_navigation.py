import unittest
from pathlib import Path


class MockGeolocation:
    """Small browser-geolocation stand-in for navigation state tests."""

    def __init__(self):
        self.watchers = {}
        self.next_id = 1
        self.cleared = []

    def watch_position(self, callback):
        watch_id = self.next_id
        self.next_id += 1
        self.watchers[watch_id] = callback
        return watch_id

    def clear_watch(self, watch_id):
        self.watchers.pop(watch_id, None)
        self.cleared.append(watch_id)

    def emit(self, latitude, longitude, accuracy=10):
        position = {"coords": {"latitude": latitude, "longitude": longitude, "accuracy": accuracy}}
        for callback in list(self.watchers.values()):
            callback(position)


class NavigationMockTests(unittest.TestCase):
    def test_mocked_gps_updates_and_cleanup(self):
        received = []
        geolocation = MockGeolocation()
        watch_id = geolocation.watch_position(lambda position: received.append(position["coords"]))
        geolocation.emit(30.76846, 76.57411)
        geolocation.clear_watch(watch_id)
        geolocation.emit(30.76847, 76.57412)
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["latitude"], 30.76846)
        self.assertEqual(geolocation.cleared, [watch_id])

    def test_current_location_is_exposed_only_in_source_search(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / "campus-map" / "index.html").read_text(encoding="utf-8")
        script = (root / "campus-map" / "js" / "map.js").read_text(encoding="utf-8")
        self.assertIn('id="source-search"', html)
        self.assertNotIn('Current Location', html.split('id="search"', 1)[1].split('</header>', 1)[0])
        self.assertIn("selectCurrentLocationSource", script)


if __name__ == "__main__":
    unittest.main()
