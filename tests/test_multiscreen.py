import unittest
from pathlib import Path

class MultiScreenFlowTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parents[1]
        self.html = (self.root / "campus-map" / "index.html").read_text(encoding="utf-8")
        self.css = (self.root / "campus-map" / "css" / "map.css").read_text(encoding="utf-8")
        self.js = (self.root / "campus-map" / "js" / "map.js").read_text(encoding="utf-8")

    def test_screen_containers_exist(self):
        self.assertIn('id="screen-welcome"', self.html)
        self.assertIn('id="screen-source"', self.html)
        self.assertIn('id="screen-destination"', self.html)
        self.assertIn('id="screen-preview"', self.html)
        self.assertIn('id="screen-navigation"', self.html)

    def test_welcome_screen_is_default_active(self):
        # screen-welcome must have screen-active class and must not be hidden
        self.assertIn('id="screen-welcome" class="app-screen screen-welcome screen-active"', self.html)
        # map and other screens are hidden initially
        self.assertIn('id="screen-source" class="app-screen screen-flow" hidden', self.html)
        self.assertIn('id="screen-destination" class="app-screen screen-flow" hidden', self.html)
        self.assertIn('id="screen-preview" class="app-screen screen-flow" hidden', self.html)
        self.assertIn('id="screen-navigation" class="app-screen screen-navigation" hidden', self.html)

    def test_all_contract_dom_ids_exist(self):
        required_ids = [
            'map',
            'source-search',
            'source-results',
            'search',
            'destination-results',
            'clear-destination',
            'route-algorithm',
            'clear-route',
            'start-navigation',
            'manual-start',
            'manual-start-controls',
            'confirm-manual-start',
            'cancel-manual-start',
            'navigation-controls',
            'recenter-location',
            'follow-location',
            'retry-location',
            'stop-navigation',
            'navigation-note',
            'gps-status',
            'route-status',
        ]
        for dom_id in required_ids:
            with self.subTest(dom_id=dom_id):
                self.assertIn(f'id="{dom_id}"', self.html)

    def test_journey_buttons_exist(self):
        journey_buttons = [
            'btn-start-journey',
            'btn-browse-destinations',
            'btn-back-source-to-welcome',
            'btn-use-live-gps',
            'btn-continue-to-dest',
            'btn-back-dest-to-source',
            'btn-find-route-preview',
            'btn-back-preview-to-dest',
            'btn-change-source',
            'btn-change-destination',
            'btn-view-map-preview',
            'btn-exit-navigation',
        ]
        for btn_id in journey_buttons:
            with self.subTest(btn_id=btn_id):
                self.assertIn(f'id="{btn_id}"', self.html)

    def test_navigation_test_contract_preserved(self):
        self.assertIn('id="source-search"', self.html)
        self.assertNotIn('Current Location', self.html.split('id="search"', 1)[1].split('</header>', 1)[0])
        self.assertIn("selectCurrentLocationSource", self.js)
        self.assertIn('id="manual-start"', self.html)
        self.assertIn("kind: 'manual-start'", self.js)
        self.assertIn("Selected start point", self.js)
        self.assertIn("if (!navigation.manualStartMode) return;", self.js)
        self.assertIn('id="follow-location"', self.html)
        self.assertIn("handleMapDragStart", self.js)
        self.assertIn("cancelAnimationFrame", self.js)
        self.assertIn("stopPrediction", self.js)

    def test_screen_manager_in_javascript(self):
        self.assertIn("showScreen", self.js)
        self.assertIn("SCREENS", self.js)
        self.assertIn("updateFlowUI", self.js)
        self.assertIn("renderDestinationCards", self.js)
        self.assertIn("selectQuickDestination", self.js)
        self.assertIn("map.invalidateSize()", self.js)

    def test_destination_cards_are_generated_from_loaded_map_data(self):
        self.assertIn("availableDestinations", self.js)
        self.assertIn("mappingFor(item.feature)", self.js)
        self.assertNotIn("VERIFIED_DESTINATIONS", self.js)

    def test_preview_does_not_fabricate_live_gps_metrics(self):
        self.assertIn("Awaiting GPS", self.js)
        self.assertNotIn("metricDist) metricDist.textContent = 'Live GPS'", self.js)

    def test_manual_start_uses_a_route_compatible_node_id(self):
        self.assertIn("function graphNodeIdFor", self.js)
        self.assertIn("mapping?.node_id ?? mapping?.nodeId", self.js)
        self.assertIn("node_id: confirmedStart.nodeId", self.js)
        self.assertIn("pendingManualStart = null", self.js)

    def test_manual_picker_fits_the_verified_campus_extent(self):
        self.assertIn("function focusCampusMap", self.js)
        self.assertIn("map.invalidateSize({ pan: false })", self.js)
        self.assertIn("map.fitBounds(bounds.pad(0.08), { maxZoom: 17, animate: false })", self.js)
        self.assertIn("setManualStartMode(true, true)", self.js)

    def test_route_action_has_visible_loading_and_error_feedback(self):
        self.assertIn('id="destination-feedback"', self.html)
        self.assertIn("function calculateRouteAndAdvance", self.js)
        self.assertIn("setRouteCalculationLoading(true)", self.js)
        self.assertIn("setDestinationFeedback", self.js)
        self.assertIn("calculateRouteAndAdvance();", self.js)

if __name__ == "__main__":
    unittest.main()
