const map = L.map('map', { zoomControl: true }).setView([30.76846, 76.57411], 16);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const layers = {};
const records = [];
const destinationLayer = L.layerGroup().addTo(map);
const sourceLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const graph = { nodes: new Map(), adjacency: new Map() };
let featureMapping = new Map();
let campusBoundaryGeometry = null;
let campusBounds = null;
let selectedSource = null;
let selectedDestination = null;
let pendingManualStart = null;
const palette = { building: '#dfe7eb', path: '#a86cd1', landmark: '#c54448' };
const GPS_MAX_SNAP_DISTANCE_M = 150;
const GPS_MAX_ACCURACY_M = 100;
const GPS_STALE_FIX_MS = 60_000;
const GPS_MAX_JUMP_SPEED_MPS = 30;
const GPS_DISPLAY_SMOOTHING = 0.45;
const GPS_PREDICTION_MAX_MS = 3_000;
const GPS_PREDICTION_MIN_SPEED_MPS = 0.4;
const GPS_PREDICTION_MAX_SPEED_MPS = 3.5;
const WALKING_SPEED_MPS = 1.4;
const navigation = {
    active: false,
    watchId: null,
    lastNode: null,
    lastRoutePosition: null,
    lastRecalculation: 0,
    locationMarker: null,
    accuracyCircle: null,
    lastFix: null,
    unchangedFixCount: 0,
    manualMarker: null,
    manualStartMode: false,
    rawPosition: null,
    filteredPosition: null,
    previousAcceptedPosition: null,
    acceptedAt: null,
    displayKind: 'none',
    animationFrame: null,
    predictionFrame: null,
    followLocation: true,
    followBound: false
};

function popup(feature) {
    const props = feature.properties || {};
    const rows = Object.entries(props).filter(([key, value]) => value !== null && value !== '' && !['label', 'source'].includes(key));
    const title = props.name || (props.feature_type === 'building' ? 'UNNAMED BUILDING' : 'Unnamed feature');
    return `<strong>${title}</strong><br>` + rows.map(([key, value]) => `<small><b>${key}</b>: ${value}</small>`).join('<br>');
}

function named(feature) {
    return Boolean(feature.properties && typeof feature.properties.name === 'string' && feature.properties.name.trim());
}

function pointInRing(point, ring) {
    const [longitude, latitude] = point;
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
        const [currentLon, currentLat] = ring[index];
        const [previousLon, previousLat] = ring[previous];
        const crosses = (currentLat > latitude) !== (previousLat > latitude);
        if (crosses && longitude < ((previousLon - currentLon) * (latitude - currentLat)) / (previousLat - currentLat) + currentLon) inside = !inside;
    }
    return inside;
}

function pointInBoundary(point, geometry) {
    if (!geometry) return null;
    if (geometry.type === 'Polygon') return pointInRing(point, geometry.coordinates[0]);
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.some(polygon => pointInRing(point, polygon[0]));
    return null;
}

function pointToSegmentMeters(point, start, end) {
    const scale = Math.cos(point.lat * Math.PI / 180);
    const x = (point.lon - start[0]) * scale;
    const y = point.lat - start[1];
    const dx = (end[0] - start[0]) * scale;
    const dy = end[1] - start[1];
    const denominator = dx * dx + dy * dy;
    const ratio = denominator ? Math.max(0, Math.min(1, (x * dx + y * dy) / denominator)) : 0;
    return haversineMeters(point, { lon: start[0] + (end[0] - start[0]) * ratio, lat: start[1] + (end[1] - start[1]) * ratio });
}

function distanceToBoundaryMeters(point, geometry) {
    if (!geometry) return Infinity;
    const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.type === 'MultiPolygon' ? geometry.coordinates.flat() : [];
    let nearest = Infinity;
    rings.forEach(ring => ring.forEach((vertex, index) => { nearest = Math.min(nearest, pointToSegmentMeters(point, vertex, ring[(index + 1) % ring.length])); }));
    return nearest;
}

function classifyCampusLocation(latitude, longitude, accuracy) {
    const inside = pointInBoundary([longitude, latitude], campusBoundaryGeometry);
    if (inside === null || !Number.isFinite(accuracy) || accuracy > GPS_MAX_ACCURACY_M) return 'uncertain';
    if (distanceToBoundaryMeters({ lat: latitude, lon: longitude }, campusBoundaryGeometry) <= accuracy) return 'uncertain';
    return inside ? 'inside' : 'outside';
}

function representativePoint(feature) {
    if (feature.geometry.type === 'Point') return feature.geometry.coordinates;
    const bounds = L.geoJSON(feature).getBounds();
    return bounds.isValid() ? [bounds.getCenter().lng, bounds.getCenter().lat] : null;
}

function styleBuilding() { return { color: '#72838e', weight: 1, fillColor: palette.building, fillOpacity: 0.72 }; }

function styleRoad(feature) {
    const major = ['trunk', 'tertiary', 'residential'].includes(feature.properties?.highway);
    return { color: major ? '#e18b35' : '#a9b2b9', weight: major ? 3 : 1.6, opacity: major ? 0.9 : 0.72 };
}

function stylePath() { return { color: palette.path, weight: 2, dashArray: '6 5', opacity: 0.9 }; }

function pointLayer(feature, latlng) { return L.circleMarker(latlng, { radius: 6, color: '#9d3034', fillColor: palette.landmark, fillOpacity: 0.9, weight: 1 }); }

function parseCsv(text) {
    const rows = []; let row = [], value = '', quoted = false;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (char === '"' && text[i + 1] === '"' && quoted) { value += '"'; i += 1; }
        else if (char === '"') quoted = !quoted;
        else if (char === ',' && !quoted) { row.push(value); value = ''; }
        else if ((char === '\n' || char === '\r') && !quoted) {
            if (char === '\r' && text[i + 1] === '\n') i += 1;
            row.push(value); value = ''; if (row.some(cell => cell !== '')) rows.push(row); row = [];
        } else value += char;
    }
    if (value || row.length) { row.push(value); rows.push(row); }
    const headers = rows.shift();
    return rows.map(cells => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
}

async function loadLayer(key, file, options) {
    const response = await fetch(`data/${file}`);
    if (!response.ok) throw new Error(`Could not load ${file}: HTTP ${response.status}`);
    const data = await response.json();
    if (key === 'buildings') data.features.forEach(feature => {
        const entry = featureMapping.get(feature.id);
        if (entry?.verified_name) feature.properties.name = entry.verified_name;
        if (entry) feature.properties.name_status = entry.status;
    });
    if (key === 'campus boundary' && data.features[0]) {
        campusBoundaryGeometry = data.features[0].geometry;
        campusBounds = L.geoJSON(data).getBounds();
    }
    const layer = L.geoJSON(data, options);
    layers[key] = layer;
    records.push(...data.features.filter(named).map(feature => ({ feature, layer })));
    return layer;
}

async function loadGraph() {
    const [nodesResponse, edgesResponse, mappingResponse] = await Promise.all([fetch('data/graph/nodes.csv'), fetch('data/graph/edges.csv'), fetch('data/feature_node_mapping.json')]);
    if (!nodesResponse.ok || !edgesResponse.ok || !mappingResponse.ok) throw new Error('Graph or feature mapping data could not be loaded');
    parseCsv(await nodesResponse.text()).forEach(row => graph.nodes.set(row.osmid, { lat: Number(row.y), lon: Number(row.x) }));
    graph.nodes.forEach((_, id) => graph.adjacency.set(id, []));
    parseCsv(await edgesResponse.text()).forEach(row => {
        if (!graph.nodes.has(row.u) || !graph.nodes.has(row.v)) return;
        const edge = { to: row.v, length: Number(row.length), highway: row.highway };
        graph.adjacency.get(row.u).push(edge);
        if (!['yes', 'true', '1'].includes(row.oneway.toLowerCase())) graph.adjacency.get(row.v).push({ to: row.u, length: edge.length, highway: row.highway });
        const pedestrianHighways = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'service', 'residential', 'unclassified', 'track', 'tertiary']);
        if (pedestrianHighways.has(row.highway)) {
            graph.suitableNodes ??= new Set();
            graph.suitableNodes.add(row.u); graph.suitableNodes.add(row.v);
        }
    });
    featureMapping = new Map((await mappingResponse.json()).features.map(entry => [entry.feature_id, entry]));
}

function dijkstra(start, goal) {
    const queue = [[0, start]], distances = new Map([[start, 0]]), previous = new Map();
    while (queue.length) {
        queue.sort((a, b) => a[0] - b[0]); const [distance, node] = queue.shift();
        if (distance !== distances.get(node)) continue;
        if (node === goal) break;
        for (const edge of graph.adjacency.get(node) || []) {
            const candidate = distance + edge.length;
            if (candidate < (distances.get(edge.to) ?? Infinity)) { distances.set(edge.to, candidate); previous.set(edge.to, node); queue.push([candidate, edge.to]); }
        }
    }
    if (!distances.has(goal)) return null;
    const nodes = [goal]; while (nodes[0] !== start) nodes.unshift(previous.get(nodes[0]));
    return { nodes, distance: distances.get(goal) };
}

function bfs(start, goal) {
    const queue = [start], previous = new Map([[start, null]]);
    for (const node of queue) { if (node === goal) break; for (const edge of graph.adjacency.get(node) || []) if (!previous.has(edge.to)) { previous.set(edge.to, node); queue.push(edge.to); } }
    if (!previous.has(goal)) return null;
    const nodes = [goal]; while (nodes[0] !== start) nodes.unshift(previous.get(nodes[0]));
    let distance = 0; for (let i = 0; i < nodes.length - 1; i += 1) distance += (graph.adjacency.get(nodes[i]).find(edge => edge.to === nodes[i + 1]) || { length: 0 }).length;
    return { nodes, distance, edges: nodes.length - 1 };
}

function haversineMeters(first, second) {
    const radius = 6371008.8;
    const toRadians = value => value * Math.PI / 180;
    const lat1 = toRadians(first.lat), lat2 = toRadians(second.lat);
    const dLat = lat2 - lat1;
    const dLon = toRadians(second.lon - first.lon);
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * radius * Math.asin(Math.sqrt(value));
}

function snapGpsToNode(latitude, longitude) {
    const point = { lat: latitude, lon: longitude };
    let nearest = null;
    for (const nodeId of graph.suitableNodes || []) {
        const node = graph.nodes.get(nodeId);
        if (!node || !(graph.adjacency.get(nodeId)?.length)) continue;
        const distance = haversineMeters(point, node);
        if (!nearest || distance < nearest.distance) nearest = { nodeId, distance };
    }
    if (!nearest || nearest.distance > GPS_MAX_SNAP_DISTANCE_M) return null;
    return nearest;
}

function mappingFor(feature) { return feature?.id ? featureMapping.get(feature.id) : null; }

function graphNodeIdFor(mapping) {
    return mapping?.node_id ?? mapping?.nodeId ?? null;
}

function focusCampusMap() {
    const bounds = campusBounds || layers['campus boundary']?.getBounds();
    if (!bounds?.isValid()) return;
    requestAnimationFrame(() => {
        map.invalidateSize({ pan: false });
        map.fitBounds(bounds.pad(0.08), { maxZoom: 17, animate: false });
    });
}

function selectCurrentLocationSource() {
    cancelManualStart(false);
    selectedSource = { kind: 'current-location', properties: { name: 'Current Location' } };
    document.getElementById('source-search').value = 'Current Location';
    document.getElementById('source-results').hidden = true;
    const gpsMsg = document.getElementById('gps-feedback-msg');
    if (gpsMsg) {
        gpsMsg.hidden = false;
        gpsMsg.textContent = 'Live position selected as departure point.';
    }
    if (navigation.active && navigation.lastNode) displayRoute();
    else document.getElementById('route-status').textContent = navigation.locationMarker ? 'Current Location selected. Start Navigation to verify the live position and calculate a campus route.' : 'Current Location selected. Start Navigation to request GPS and calculate a campus route.';
    if (typeof updateFlowUI === 'function') updateFlowUI();
}

function formatDistance(distance) {
    return distance < 1000 ? `${distance.toFixed(1)} m` : `${(distance / 1000).toFixed(2)} km`;
}

function displayNavigationRoute(startNode) {
    routeLayer.clearLayers();
    const status = document.getElementById('route-status');
    const destinationMapping = selectedDestination && mappingFor(selectedDestination);
    if (!destinationMapping) { status.textContent = 'The selected destination has no verified graph-node mapping.'; return false; }
    const result = dijkstra(startNode, destinationMapping.node_id);
    if (!result) { status.textContent = 'No safe route exists from your current graph component to this destination.'; return false; }
    const latlngs = result.nodes.map(id => [graph.nodes.get(id).lat, graph.nodes.get(id).lon]);
    L.polyline(latlngs, { color: '#0284c7', weight: 6, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
    const minutes = result.distance / WALKING_SPEED_MPS / 60;
    status.textContent = `Navigation route: ${formatDistance(result.distance)} · about ${Math.max(1, Math.round(minutes))} min at ${WALKING_SPEED_MPS} m/s`;
    return true;
}

function updateFollowButton() {
    document.getElementById('follow-location').textContent = `Follow location: ${navigation.followLocation ? 'on' : 'off'}`;
}

function followMarker(latlng) {
    if (navigation.followLocation) map.panTo(latlng, { animate: true, duration: 0.25 });
}

function setMarkerTooltip(kind, acceptedForRouting) {
    if (!navigation.locationMarker) return;
    const labels = {
        filtered: 'Filtered display from current GPS fix',
        predicted: 'Predicted display from last confirmed GPS fix',
        raw: 'Raw GPS display'
    };
    navigation.locationMarker.setTooltipContent(`${labels[kind] || 'GPS display'} · ${acceptedForRouting ? 'accepted for campus routing' : 'not accepted for campus routing'}`);
}

function animateLocationMarker(target, kind, acceptedForRouting) {
    const targetLatLng = L.latLng(target.lat, target.lon);
    if (!navigation.locationMarker) {
        navigation.locationMarker = L.circleMarker(targetLatLng, { radius: 9, color: acceptedForRouting ? '#0369a1' : '#8a5a00', weight: 3, fillColor: acceptedForRouting ? '#00f0ff' : '#f59e0b', fillOpacity: 1 }).addTo(map);
        navigation.displayKind = kind;
        setMarkerTooltip(kind, acceptedForRouting);
        followMarker(targetLatLng);
        return;
    }
    if (navigation.animationFrame) cancelAnimationFrame(navigation.animationFrame);
    const start = navigation.locationMarker.getLatLng();
    const startedAt = performance.now();
    const render = now => {
        const progress = Math.min(1, (now - startedAt) / 300);
        const eased = progress * (2 - progress);
        const latlng = L.latLng(start.lat + (target.lat - start.lat) * eased, start.lng + (target.lon - start.lon) * eased);
        navigation.locationMarker.setLatLng(latlng);
        followMarker(latlng);
        if (progress < 1) navigation.animationFrame = requestAnimationFrame(render);
        else navigation.animationFrame = null;
    };
    navigation.displayKind = kind;
    navigation.locationMarker.setStyle({ color: acceptedForRouting ? '#0369a1' : '#8a5a00', fillColor: acceptedForRouting ? '#00f0ff' : '#f59e0b' });
    setMarkerTooltip(kind, acceptedForRouting);
    navigation.animationFrame = requestAnimationFrame(render);
}

function filteredGpsPosition(raw) {
    if (!navigation.filteredPosition) return { lat: raw.lat, lon: raw.lon };
    return {
        lat: navigation.filteredPosition.lat + (raw.lat - navigation.filteredPosition.lat) * GPS_DISPLAY_SMOOTHING,
        lon: navigation.filteredPosition.lon + (raw.lon - navigation.filteredPosition.lon) * GPS_DISPLAY_SMOOTHING
    };
}

function updateLocationMarker(position, acceptedForRouting = false) {
    const raw = { lat: Number(position.coords.latitude), lon: Number(position.coords.longitude), accuracy: Number(position.coords.accuracy), timestamp: Number(position.timestamp) };
    navigation.rawPosition = raw;
    navigation.filteredPosition = filteredGpsPosition(raw);
    animateLocationMarker(navigation.filteredPosition, 'filtered', acceptedForRouting);
    if (!navigation.accuracyCircle) navigation.accuracyCircle = L.circle([raw.lat, raw.lon], { radius: raw.accuracy, color: '#0284c7', fillColor: '#38bdf8', fillOpacity: 0.15, weight: 1.5, dashArray: '4 4' }).addTo(map);
    else navigation.accuracyCircle.setLatLng([raw.lat, raw.lon]).setRadius(raw.accuracy);
    return [raw.lat, raw.lon];
}

function updateGpsStatus(message, accuracy, acceptedForRouting) {
    const accuracyText = Number.isFinite(accuracy) ? `${Math.round(accuracy)} m reported accuracy estimate` : 'accuracy unavailable';
    document.getElementById('gps-status').textContent = `GPS status: ${message} · ${accuracyText} · display ${navigation.displayKind} · routing ${acceptedForRouting ? 'accepted' : 'not accepted'}.`;
}

function stopPrediction() {
    if (navigation.predictionFrame) cancelAnimationFrame(navigation.predictionFrame);
    navigation.predictionFrame = null;
}

function startShortPrediction(current) {
    stopPrediction();
    if (navigation.animationFrame) { cancelAnimationFrame(navigation.animationFrame); navigation.animationFrame = null; }
    const previous = navigation.previousAcceptedPosition;
    const elapsedMs = previous ? current.timestamp - previous.timestamp : 0;
    if (!previous || !Number.isFinite(elapsedMs) || elapsedMs <= 0 || current.accuracy > 50) return;
    const distance = haversineMeters(current, previous);
    const speed = distance / (elapsedMs / 1000);
    if (speed < GPS_PREDICTION_MIN_SPEED_MPS || speed > GPS_PREDICTION_MAX_SPEED_MPS) return;
    const startedAt = performance.now();
    const render = now => {
        if (!navigation.active || now - startedAt > GPS_PREDICTION_MAX_MS || Date.now() - current.timestamp > GPS_STALE_FIX_MS) { navigation.predictionFrame = null; return; }
        const futureMs = now - startedAt;
        const predicted = {
            lat: current.lat + (current.lat - previous.lat) * (futureMs / elapsedMs),
            lon: current.lon + (current.lon - previous.lon) * (futureMs / elapsedMs)
        };
        navigation.displayKind = 'predicted';
        navigation.locationMarker.setLatLng([predicted.lat, predicted.lon]);
        navigation.locationMarker.setStyle({ color: '#4c3b8f', fillColor: '#9c7ce8' });
        setMarkerTooltip('predicted', true);
        followMarker([predicted.lat, predicted.lon]);
        document.getElementById('gps-status').textContent = `GPS status: short-term predicted display · ${Math.round(current.accuracy)} m reported accuracy estimate from the last confirmed fix · routing remains based on the last confirmed GPS fix.`;
        navigation.predictionFrame = requestAnimationFrame(render);
    };
    navigation.predictionFrame = requestAnimationFrame(render);
}

function handleMapDragStart() {
    if (!navigation.followLocation) return;
    navigation.followLocation = false;
    updateFollowButton();
    document.getElementById('gps-status').textContent += ' Follow paused after manual map movement.';
}

function recordGpsFix(position) {
    const receivedAt = Date.now();
    const timestamp = Number(position.timestamp);
    const coordinates = [Number(position.coords.latitude), Number(position.coords.longitude)];
    const previous = navigation.lastFix;
    const unchanged = previous && coordinates[0] === previous.coordinates[0] && coordinates[1] === previous.coordinates[1];
    navigation.unchangedFixCount = unchanged ? navigation.unchangedFixCount + 1 : 0;
    const ageMs = Number.isFinite(timestamp) ? Math.max(0, receivedAt - timestamp) : Infinity;
    const elapsedMs = previous && Number.isFinite(timestamp) && Number.isFinite(previous.timestamp) ? timestamp - previous.timestamp : null;
    const jumpDistanceM = previous ? haversineMeters({ lat: coordinates[0], lon: coordinates[1] }, { lat: previous.coordinates[0], lon: previous.coordinates[1] }) : 0;
    const jumpSpeedMps = elapsedMs && elapsedMs > 0 ? jumpDistanceM / (elapsedMs / 1000) : (previous && !unchanged ? Infinity : 0);
    navigation.lastFix = { timestamp, coordinates };
    if (navigation.unchangedFixCount >= 3) console.info('CampusPath GPS coordinates are unchanged; this can be normal for a stationary user.', { unchanged_fix_count: navigation.unchangedFixCount });
    return {
        unchanged,
        stale: ageMs > GPS_STALE_FIX_MS,
        ageMs,
        jump: jumpSpeedMps > GPS_MAX_JUMP_SPEED_MPS,
        jumpSpeedMps
    };
}

function handleGpsPosition(position) {
    if (!navigation.active) return;
    const latitude = Number(position.coords.latitude);
    const longitude = Number(position.coords.longitude);
    const accuracy = Number(position.coords.accuracy);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        console.warn('CampusPath geolocation returned invalid coordinates; marker was not updated.');
        document.getElementById('route-status').textContent = 'GPS returned an invalid location. Waiting for another fix.';
        document.getElementById('retry-location').hidden = false;
        return;
    }
    console.info('CampusPath GPS fix received', { accuracy_m: Number.isFinite(accuracy) ? Math.round(accuracy) : null });
    const fix = recordGpsFix(position);
    stopPrediction();
    const firstFix = !navigation.locationMarker;
    const latlng = updateLocationMarker(position, false);
    if (firstFix) map.setView(latlng, 15);
    const status = document.getElementById('route-status');
    if (fix.stale) {
        routeLayer.clearLayers(); navigation.lastNode = null; navigation.lastRoutePosition = null;
        status.textContent = `GPS fix is stale (${Math.round(fix.ageMs / 1000)} seconds old). Waiting for a current location before routing.`;
        updateGpsStatus('Fix received but is stale', accuracy, false);
        document.getElementById('retry-location').hidden = false;
        return;
    }
    if (fix.jump) {
        routeLayer.clearLayers(); navigation.lastNode = null; navigation.lastRoutePosition = null;
        status.textContent = 'GPS position changed implausibly fast. Waiting for a stable location before routing.';
        updateGpsStatus('Fix received but rejected as an implausible jump', accuracy, false);
        console.warn('CampusPath GPS jump rejected for routing', { speed_mps: Math.round(fix.jumpSpeedMps) });
        document.getElementById('retry-location').hidden = false;
        return;
    }
    if (!Number.isFinite(accuracy) || accuracy > GPS_MAX_ACCURACY_M) {
        const message = 'GPS accuracy is too low to determine whether you are inside campus. Waiting for a more accurate location.';
        routeLayer.clearLayers(); navigation.lastNode = null; navigation.lastRoutePosition = null;
        status.textContent = message;
        updateGpsStatus(fix.unchanged ? 'Stationary coordinates repeated, but accuracy is too low for campus classification' : 'Fix received but too inaccurate for campus classification', accuracy, false);
        document.getElementById('retry-location').hidden = false;
        return;
    }
    const campusState = classifyCampusLocation(latitude, longitude, accuracy);
    if (campusState === 'uncertain') {
        routeLayer.clearLayers(); navigation.lastNode = null; navigation.lastRoutePosition = null;
        status.textContent = 'Checking your location accuracy near the campus boundary. Waiting for a clearer fix before routing.';
        updateGpsStatus('Boundary overlap is uncertain', accuracy, false);
        document.getElementById('retry-location').hidden = false;
        return;
    }
    if (campusState === 'outside') {
        routeLayer.clearLayers(); navigation.lastNode = null; navigation.lastRoutePosition = null;
        status.textContent = 'You appear to be outside Chandigarh University campus. Campus navigation is available only within the campus.';
        updateGpsStatus('Fix is outside the verified campus boundary', accuracy, false);
        document.getElementById('retry-location').hidden = false;
        return;
    }
    const snapped = snapGpsToNode(latitude, longitude);
    if (!snapped) {
        status.textContent = `GPS location acquired (${Math.round(accuracy)} m accuracy), but it is more than ${GPS_MAX_SNAP_DISTANCE_M} m from a suitable campus graph node. Your marker remains visible; no campus route was created.`;
        updateGpsStatus('Inside boundary, but no suitable graph node was found', accuracy, false);
        document.getElementById('retry-location').hidden = false;
        return;
    }
    updateLocationMarker(position, true);
    updateGpsStatus(fix.unchanged ? 'Fix is inside campus; repeated coordinates are consistent with a stationary user' : 'Fix is inside the verified campus boundary', accuracy, true);
    const now = Date.now();
    const movedEnough = !navigation.lastRoutePosition || haversineMeters({ lat: latlng[0], lon: latlng[1] }, { lat: navigation.lastRoutePosition[0], lon: navigation.lastRoutePosition[1] }) >= 20;
    const canRecalculate = !navigation.lastNode || (snapped.nodeId !== navigation.lastNode && movedEnough && now - navigation.lastRecalculation >= 5000);
    if (canRecalculate) {
        navigation.lastNode = snapped.nodeId;
        navigation.lastRoutePosition = latlng;
        navigation.lastRecalculation = now;
        if (!displayNavigationRoute(snapped.nodeId)) document.getElementById('retry-location').hidden = false;
        else document.getElementById('retry-location').hidden = true;
    }
    const acceptedPosition = { lat: latitude, lon: longitude, timestamp: Number(position.timestamp), accuracy };
    startShortPrediction(acceptedPosition);
    navigation.previousAcceptedPosition = acceptedPosition;
}

function handleGeoError(error) {
    const messages = { 1: 'Location permission was denied. Allow location access and retry GPS.', 2: 'Your location is currently unavailable. Check device location services and retry GPS.', 3: 'GPS timed out. Retry GPS when you have a clearer signal.' };
    console.warn('CampusPath geolocation error', { code: error?.code ?? null, message: error?.message ?? 'unknown geolocation error' });
    const message = messages[error.code] || 'Could not obtain your location. Retry GPS.';
    routeLayer.clearLayers(); navigation.lastNode = null; navigation.lastRoutePosition = null;
    document.getElementById('route-status').textContent = message;
    updateGpsStatus(message, null, false);
    document.getElementById('retry-location').hidden = false;
}

function stopNavigation() {
    if (navigation.watchId !== null) navigator.geolocation.clearWatch(navigation.watchId);
    if (navigation.animationFrame) cancelAnimationFrame(navigation.animationFrame);
    stopPrediction();
    if (navigation.followBound) { map.off('dragstart', handleMapDragStart); navigation.followBound = false; }
    navigation.active = false; navigation.watchId = null; navigation.lastNode = null; navigation.lastRoutePosition = null; navigation.lastRecalculation = 0; navigation.lastFix = null; navigation.unchangedFixCount = 0; navigation.rawPosition = null; navigation.filteredPosition = null; navigation.previousAcceptedPosition = null; navigation.displayKind = 'none'; navigation.animationFrame = null;
    if (navigation.locationMarker) map.removeLayer(navigation.locationMarker);
    if (navigation.accuracyCircle) map.removeLayer(navigation.accuracyCircle);
    navigation.locationMarker = null; navigation.accuracyCircle = null; routeLayer.clearLayers();
    document.getElementById('navigation-controls').hidden = true;
    document.getElementById('start-navigation').hidden = !selectedDestination || !mappingFor(selectedDestination);
    document.getElementById('route-status').textContent = selectedDestination ? 'Navigation stopped. Choose Start Navigation to request GPS again.' : 'Choose a start and destination to calculate a route.';
    const headerStatus = document.getElementById('header-system-status');
    if (headerStatus) headerStatus.innerHTML = '<span class="status-indicator-dot"></span><span class="status-indicator-label">Navigation Ready</span>';
    if (typeof updateFlowUI === 'function') updateFlowUI();
}

function startNavigation() {
    if (!selectedDestination || !mappingFor(selectedDestination)) { document.getElementById('route-status').textContent = 'Select a destination with a verified graph mapping first.'; return; }
    if (selectedSource && selectedSource.kind !== 'current-location') { document.getElementById('route-status').textContent = 'Select Current Location as the start for live GPS navigation.'; return; }
    if (!selectedSource) selectCurrentLocationSource();
    if (!navigator.geolocation) { document.getElementById('route-status').textContent = 'This browser does not provide geolocation.'; return; }
    const allowedLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
    if (!window.isSecureContext && !allowedLocalhost) { document.getElementById('route-status').textContent = 'GPS requires HTTPS or localhost. Open CampusPath from a secure local server.'; return; }
    if (navigation.watchId !== null) navigator.geolocation.clearWatch(navigation.watchId);
    navigation.active = true; navigation.watchId = null; navigation.lastNode = null; navigation.lastRoutePosition = null; navigation.lastRecalculation = 0; navigation.lastFix = null; navigation.unchangedFixCount = 0; navigation.rawPosition = null; navigation.filteredPosition = null; navigation.previousAcceptedPosition = null; navigation.displayKind = 'none'; navigation.followLocation = true;
    if (!navigation.followBound) { map.on('dragstart', handleMapDragStart); navigation.followBound = true; }
    updateFollowButton();
    document.getElementById('start-navigation').hidden = true; document.getElementById('navigation-controls').hidden = false; document.getElementById('retry-location').hidden = true;
    document.getElementById('route-status').textContent = 'Requesting your current location…';
    const headerStatus = document.getElementById('header-system-status');
    if (headerStatus) headerStatus.innerHTML = '<span class="status-indicator-dot" style="background:#00f0ff;box-shadow:0 0 8px #00f0ff"></span><span class="status-indicator-label">Live GPS Navigation Active</span>';
    updateGpsStatus('Acquiring location', null, false);
    if (typeof showScreen === 'function') showScreen('screen-navigation');
    if (typeof updateFlowUI === 'function') updateFlowUI();
    try {
        navigation.watchId = navigator.geolocation.watchPosition(handleGpsPosition, handleGeoError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
        console.info('CampusPath GPS watcher started', { watcher_started: true });
    } catch (error) {
        console.error('CampusPath could not start geolocation', error);
        handleGeoError({ code: 2, message: error.message });
    }
}

function retryNavigation() {
    if (navigation.active) stopNavigation();
    startNavigation();
}

function recenterLocation() {
    if (navigation.locationMarker) { navigation.followLocation = true; updateFollowButton(); map.setView(navigation.locationMarker.getLatLng(), Math.max(map.getZoom(), 17)); }
    else document.getElementById('route-status').textContent = 'Waiting for a GPS fix. Keep navigation active or use Retry GPS.';
}

function setManualStartMode(active, focusCampus = false) {
    navigation.manualStartMode = active;
    const manualPickerBanner = document.getElementById('manual-map-picker-banner');
    const confirmButton = document.getElementById('confirm-manual-start');
    if (manualPickerBanner) manualPickerBanner.hidden = !active;
    document.getElementById('manual-start-controls').hidden = !active;
    document.getElementById('manual-start').hidden = active;
    if (confirmButton) confirmButton.disabled = !active || !pendingManualStart;
    if (active && typeof showScreen === 'function') {
        showScreen('screen-navigation');
        if (focusCampus) focusCampusMap();
    }
    map.getContainer().style.cursor = active ? 'crosshair' : '';
    const headerStatus = document.getElementById('header-system-status');
    if (headerStatus) {
        headerStatus.innerHTML = active
            ? '<span class="status-indicator-dot" style="background:#f59e0b;box-shadow:0 0 8px #f59e0b"></span><span class="status-indicator-label">Setting Start Point</span>'
            : '<span class="status-indicator-dot"></span><span class="status-indicator-label">Navigation Ready</span>';
    }
}

function cancelManualStart(returnToSource = true) {
    pendingManualStart = null;
    setManualStartMode(false);
    if (navigation.manualMarker) { map.removeLayer(navigation.manualMarker); navigation.manualMarker = null; }
    if (returnToSource && typeof showScreen === 'function') showScreen('screen-source');
}

function chooseManualStart(event) {
    if (!navigation.manualStartMode) return;
    if (campusBoundaryGeometry && pointInBoundary([event.latlng.lng, event.latlng.lat], campusBoundaryGeometry) !== true) {
        document.getElementById('route-status').textContent = 'Selected start point must be inside the verified campus boundary.';
        return;
    }
    const snapped = snapGpsToNode(event.latlng.lat, event.latlng.lng);
    if (!snapped) {
        document.getElementById('route-status').textContent = `No suitable campus graph node is within ${GPS_MAX_SNAP_DISTANCE_M} m of that selected start point.`;
        return;
    }
    pendingManualStart = { nodeId: snapped.nodeId, distance: snapped.distance, latlng: event.latlng };
    if (navigation.manualMarker) map.removeLayer(navigation.manualMarker);
    navigation.manualMarker = L.circleMarker(event.latlng, { radius: 9, color: '#6b3f00', weight: 3, fillColor: '#f0b15a', fillOpacity: 1 }).bindTooltip('Selected start point (pending)', { permanent: true, direction: 'top' }).addTo(map);
    document.getElementById('confirm-manual-start').disabled = false;
    document.getElementById('route-status').textContent = `Start point selected (${Math.round(snapped.distance)} m from graph node). Confirm it to calculate a route.`;
}

function confirmManualStart() {
    if (!pendingManualStart) {
        document.getElementById('route-status').textContent = 'Choose a point on the campus map before confirming your start.';
        return;
    }
    if (navigation.active) stopNavigation();
    const confirmedStart = pendingManualStart;
    pendingManualStart = null;
    selectedSource = { kind: 'manual-start', nodeId: confirmedStart.nodeId, node_id: confirmedStart.nodeId, latlng: confirmedStart.latlng, properties: { name: 'Selected start point' } };
    document.getElementById('source-search').value = 'Selected start point';
    document.getElementById('source-results').hidden = true;
    if (navigation.manualMarker) navigation.manualMarker.setTooltipContent('Selected start point');
    setManualStartMode(false);
    document.getElementById('route-status').textContent = 'Selected start point confirmed. Calculating route…';
    displayRoute();
    if (typeof updateFlowUI === 'function') updateFlowUI();
    if (typeof showScreen === 'function') showScreen('screen-destination');
}

function setFeatureMarker(feature, type) {
    const point = representativePoint(feature); if (!point) return;
    const targetLayer = type === 'source' ? sourceLayer : destinationLayer; targetLayer.clearLayers();
    const marker = L.circleMarker([point[1], point[0]], { radius: 10, color: type === 'source' ? '#0369a1' : '#b45309', weight: 3, fillColor: type === 'source' ? '#38bdf8' : '#f59e0b', fillOpacity: 1 });
    marker.bindTooltip(feature.properties.name, { permanent: true, direction: 'top', offset: [0, -10], className: 'destination-label' });
    marker.bindPopup(popup(feature)); targetLayer.addLayer(marker);
}

function displayRoute() {
    routeLayer.clearLayers(); const status = document.getElementById('route-status');
    if (navigation.active && navigation.lastNode) return displayNavigationRoute(navigation.lastNode);
    if (!selectedSource || !selectedDestination) { status.textContent = 'Choose a start and destination to calculate a route.'; if (typeof updateFlowUI === 'function') updateFlowUI(); return false; }
    if (selectedSource.kind === 'current-location') { status.textContent = 'Current Location selected. Start Navigation to verify your position before routing.'; if (typeof updateFlowUI === 'function') updateFlowUI(); return false; }
    const sourceMapping = selectedSource.kind === 'manual-start' ? selectedSource : mappingFor(selectedSource), destinationMapping = mappingFor(selectedDestination);
    const sourceNodeId = graphNodeIdFor(sourceMapping);
    const destinationNodeId = graphNodeIdFor(destinationMapping);
    if (!sourceNodeId || !destinationNodeId) { status.textContent = 'A selected feature has no verified graph-node mapping.'; if (typeof updateFlowUI === 'function') updateFlowUI(); return false; }
    const algorithm = document.getElementById('route-algorithm').value;
    const result = algorithm === 'bfs' ? bfs(sourceNodeId, destinationNodeId) : dijkstra(sourceNodeId, destinationNodeId);
    if (!result) { status.textContent = 'No route exists between these graph components.'; if (typeof updateFlowUI === 'function') updateFlowUI(); return false; }
    const latlngs = result.nodes.map(id => [graph.nodes.get(id).lat, graph.nodes.get(id).lon]);
    L.polyline(latlngs, { color: '#0284c7', weight: 6, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer); map.fitBounds(L.latLngBounds(latlngs).pad(0.12));
    status.textContent = `${algorithm === 'bfs' ? 'BFS' : 'Dijkstra'} route: ${result.distance < 1000 ? `${result.distance.toFixed(1)} m` : `${(result.distance / 1000).toFixed(2)} km`}${result.edges ? ` · ${result.edges} edges` : ''}`;
    if (typeof updateFlowUI === 'function') updateFlowUI();
    return true;
}

function selectFeature(item, type) {
    if (type === 'source') {
        if (navigation.active) stopNavigation();
        cancelManualStart(false);
        selectedSource = item.feature; setFeatureMarker(item.feature, 'source');
    }
    else {
        selectedDestination = item.feature; setFeatureMarker(item.feature, 'destination');
        const hasMapping = Boolean(mappingFor(item.feature));
        document.getElementById('clear-destination').hidden = false;
        document.getElementById('start-navigation').hidden = !hasMapping;
    }
    const point = representativePoint(item.feature), featureLayer = item.layer.getLayers().find(layer => layer.feature === item.feature);
    if (featureLayer?.getBounds?.().isValid()) map.fitBounds(featureLayer.getBounds().pad(0.3)); else if (point) map.setView([point[1], point[0]], 18);
    document.getElementById(type === 'source' ? 'source-search' : 'search').value = item.feature.properties.name;
    document.getElementById(type === 'source' ? 'source-results' : 'destination-results').hidden = true;
    displayRoute();
    if (typeof updateFlowUI === 'function') updateFlowUI();
}

function swapLocations() {
    if (!selectedSource && !selectedDestination) return;
    if (selectedSource && selectedSource.kind === 'current-location') return;
    const prevSource = selectedSource;
    const prevDest = selectedDestination;
    selectedSource = prevDest;
    selectedDestination = prevSource;
    sourceLayer.clearLayers();
    destinationLayer.clearLayers();
    if (selectedSource) {
        setFeatureMarker(selectedSource, 'source');
        document.getElementById('source-search').value = selectedSource.properties?.name || '';
    } else {
        document.getElementById('source-search').value = '';
    }
    if (selectedDestination) {
        setFeatureMarker(selectedDestination, 'destination');
        document.getElementById('search').value = selectedDestination.properties?.name || '';
        const hasMapping = Boolean(mappingFor(selectedDestination));
        document.getElementById('clear-destination').hidden = false;
        document.getElementById('start-navigation').hidden = !hasMapping;
    } else {
        document.getElementById('search').value = '';
        document.getElementById('clear-destination').hidden = true;
        document.getElementById('start-navigation').hidden = true;
    }
    displayRoute();
    if (typeof updateFlowUI === 'function') updateFlowUI();
}

function clearDestination() {
    if (navigation.active) stopNavigation();
    selectedDestination = null; destinationLayer.clearLayers(); routeLayer.clearLayers();
    document.getElementById('search').value = ''; document.getElementById('clear-destination').hidden = true; document.getElementById('start-navigation').hidden = true; displayRoute();
    if (typeof updateFlowUI === 'function') updateFlowUI();
}

function bindSearch(inputId, type) {
    const input = document.getElementById(inputId);
    const resultBox = document.getElementById(type === 'source' ? 'source-results' : 'destination-results');
    let activeResult = -1;

    function closeResults() { resultBox.hidden = true; activeResult = -1; }

    function renderResults(query) {
        resultBox.innerHTML = ''; activeResult = -1;
        const specialCurrent = type === 'source' && (!query || 'current location'.includes(query));
        if (specialCurrent) {
            const row = document.createElement('div');
            row.className = 'result current-location-result'; row.setAttribute('role', 'option'); row.textContent = 'Current Location';
            row.addEventListener('mousedown', event => event.preventDefault());
            row.addEventListener('click', selectCurrentLocationSource);
            resultBox.appendChild(row);
        }
        if (!query) { resultBox.hidden = !specialCurrent; return; }
        const matches = records.filter(item => item.feature.properties.name.toLowerCase().includes(query)).slice(0, 12);
        matches.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'result'; row.setAttribute('role', 'option'); row.textContent = item.feature.properties.name;
            row.addEventListener('mousedown', event => event.preventDefault());
            row.addEventListener('click', () => { selectFeature(item, type); closeResults(); });
            resultBox.appendChild(row);
            if (index === 0) row.setAttribute('aria-selected', 'false');
        });
        resultBox.hidden = !specialCurrent && matches.length === 0;
    }

    input.addEventListener('focus', () => { if (!input.value) renderResults(''); });
    input.addEventListener('input', event => renderResults(event.target.value.trim().toLowerCase()));

    input.addEventListener('keydown', event => {
        const options = [...resultBox.querySelectorAll('.result')];
        if (event.key === 'Escape') { closeResults(); return; }
        if (!options.length || resultBox.hidden) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            activeResult = (activeResult + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
            options.forEach((option, index) => option.setAttribute('aria-selected', String(index === activeResult)));
            options[activeResult].scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter' && activeResult >= 0) {
            event.preventDefault(); options[activeResult].click();
        }
    });
}

// ==========================================================================
// MULTI-SCREEN CAMPUS NAVIGATION WORKSPACE ARCHITECTURE
// ==========================================================================

const SCREENS = {
    WELCOME: 'screen-welcome',
    SOURCE: 'screen-source',
    DESTINATION: 'screen-destination',
    PREVIEW: 'screen-preview',
    NAVIGATION: 'screen-navigation'
};

let currentScreen = SCREENS.WELCOME;

let currentCategoryFilter = 'all';

function destinationCategory(feature) {
    const props = feature.properties || {};
    const name = String(props.name || '').toLowerCase();
    if (name.includes('hostel')) return 'hostels';
    if (props.amenity || props.leisure || name.includes('parking')) return 'dining';
    return 'academic';
}

function destinationTag(feature) {
    const props = feature.properties || {};
    if (props.amenity) return String(props.amenity).replace(/_/g, ' ');
    if (props.leisure) return String(props.leisure).replace(/_/g, ' ');
    if (props.building) return 'Building';
    return 'Campus location';
}

function availableDestinations() {
    const byName = new Map();
    records.forEach(item => {
        const name = item.feature.properties?.name?.trim();
        if (!name || !mappingFor(item.feature)) return;
        const key = name.toLowerCase();
        if (!byName.has(key)) byName.set(key, { name, category: destinationCategory(item.feature), tag: destinationTag(item.feature) });
    });
    return [...byName.values()].sort((first, second) => first.name.localeCompare(second.name));
}

function showScreen(screenId) {
    currentScreen = screenId;
    document.querySelectorAll('.app-screen').forEach(screen => {
        if (screen.id === screenId) {
            screen.hidden = false;
            screen.classList.add('screen-active');
        } else {
            screen.hidden = true;
            screen.classList.remove('screen-active');
        }
    });

    const stepIndicator = document.getElementById('header-step-indicator');
    const stepLabel = document.getElementById('header-step-label');
    if (stepIndicator && stepLabel) {
        if (screenId === SCREENS.SOURCE) {
            stepIndicator.hidden = false;
            stepLabel.textContent = 'Step 1 of 3';
        } else if (screenId === SCREENS.DESTINATION) {
            stepIndicator.hidden = false;
            stepLabel.textContent = 'Step 2 of 3';
        } else if (screenId === SCREENS.PREVIEW) {
            stepIndicator.hidden = false;
            stepLabel.textContent = 'Step 3 of 3';
        } else {
            stepIndicator.hidden = true;
        }
    }

    if (screenId === SCREENS.NAVIGATION) {
        setTimeout(() => {
            map.invalidateSize();
            if (routeLayer.getLayers().length > 0) {
                const group = L.featureGroup(routeLayer.getLayers());
                if (group.getBounds().isValid()) {
                    map.fitBounds(group.getBounds().pad(0.18));
                }
            }
        }, 100);
    }

    updateFlowUI();
}

function setDestinationFeedback(message, tone = 'neutral') {
    const feedback = document.getElementById('destination-feedback');
    if (!feedback) return;
    feedback.hidden = !message;
    feedback.textContent = message || '';
    feedback.dataset.tone = tone;
}

function setRouteCalculationLoading(loading) {
    const button = document.getElementById('btn-find-route-preview');
    if (!button) return;
    button.disabled = loading || !selectedSource || !selectedDestination;
    button.classList.toggle('is-loading', loading);
    const label = button.querySelector('span');
    if (label) label.textContent = loading ? 'Calculating route…' : 'Calculate Route';
}

function calculateRouteAndAdvance() {
    if (!selectedSource || !selectedDestination) {
        setDestinationFeedback('Choose both a starting point and a destination before calculating a route.', 'error');
        updateFlowUI();
        return;
    }
    setDestinationFeedback('Calculating the route on the campus graph…', 'loading');
    setRouteCalculationLoading(true);
    requestAnimationFrame(() => {
        const routeReady = displayRoute();
        setRouteCalculationLoading(false);
        if (routeReady || selectedSource.kind === 'current-location') {
            setDestinationFeedback('');
            showScreen(SCREENS.PREVIEW);
            return;
        }
        setDestinationFeedback(document.getElementById('route-status').textContent, 'error');
    });
}

function renderDestinationCards(filterCategory = 'all') {
    const container = document.getElementById('destinations-grid-container');
    if (!container) return;
    container.innerHTML = '';
    const destinations = availableDestinations();
    const filtered = filterCategory === 'all'
        ? destinations
        : destinations.filter(d => d.category === filterCategory);

    filtered.forEach(dest => {
        const card = document.createElement('div');
        card.className = 'dest-quick-card';
        card.dataset.name = dest.name;
        if (selectedDestination && selectedDestination.properties?.name === dest.name) {
            card.classList.add('selected');
        }
        const category = dest.category === 'academic' ? 'Academic' : dest.category === 'hostels' ? 'Hostel' : 'Amenity';
        card.innerHTML = `<span class="dest-card-category">${category}</span><strong class="dest-card-name"></strong><span class="dest-card-tag"></span>`;
        card.querySelector('.dest-card-name').textContent = dest.name;
        card.querySelector('.dest-card-tag').textContent = dest.tag;
        card.addEventListener('click', () => {
            selectQuickDestination(dest.name);
        });
        container.appendChild(card);
    });
}

function selectQuickDestination(name) {
    const match = records.find(r => r.feature.properties?.name?.toLowerCase() === name.toLowerCase());
    if (match) {
        selectFeature(match, 'destination');
        renderDestinationCards(currentCategoryFilter);
    }
}

function updateFlowUI() {
    const departureStatusVal = document.getElementById('departure-status-value');
    const departureStatusDot = document.getElementById('departure-status-dot');
    const btnContinueDest = document.getElementById('btn-continue-to-dest');
    const cardOptGps = document.getElementById('card-opt-gps');
    const cardOptSearch = document.getElementById('card-opt-search');
    const cardOptMap = document.getElementById('card-opt-map');

    const sourceName = selectedSource
        ? (selectedSource.kind === 'current-location' ? 'Live Device Position' : (selectedSource.properties?.name || 'Selected start point'))
        : null;

    if (departureStatusVal && departureStatusDot) {
        if (sourceName) {
            departureStatusVal.textContent = sourceName;
            departureStatusDot.classList.add('active');
            if (btnContinueDest) btnContinueDest.disabled = false;
        } else {
            departureStatusVal.textContent = 'None selected';
            departureStatusDot.classList.remove('active');
            if (btnContinueDest) btnContinueDest.disabled = true;
        }
    }

    if (cardOptGps) cardOptGps.classList.toggle('card-selected', selectedSource?.kind === 'current-location');
    if (cardOptSearch) cardOptSearch.classList.toggle('card-selected', Boolean(selectedSource && selectedSource.kind !== 'current-location' && selectedSource.kind !== 'manual-start'));
    if (cardOptMap) cardOptMap.classList.toggle('card-selected', selectedSource?.kind === 'manual-start');

    const recapDepName = document.getElementById('recap-departure-name');
    if (recapDepName) recapDepName.textContent = sourceName || 'Select start';

    const destStatusVal = document.getElementById('destination-status-value');
    const destStatusDot = document.getElementById('destination-status-dot');
    const btnFindRoute = document.getElementById('btn-find-route-preview');
    const destName = selectedDestination ? (selectedDestination.properties?.name || 'Destination') : null;

    if (destStatusVal && destStatusDot) {
        if (destName) {
            destStatusVal.textContent = destName;
            destStatusDot.classList.add('active');
            if (btnFindRoute) btnFindRoute.disabled = !selectedSource;
        } else {
            destStatusVal.textContent = 'None selected';
            destStatusDot.classList.remove('active');
            if (btnFindRoute) btnFindRoute.disabled = true;
        }
    }

    const prevDepName = document.getElementById('preview-departure-name');
    const prevDestName = document.getElementById('preview-destination-name');
    const hudSrcLabel = document.getElementById('hud-source-label');
    const hudDestLabel = document.getElementById('hud-dest-label');
    const navPillText = document.getElementById('nav-header-route-text');

    if (prevDepName) prevDepName.textContent = sourceName || '--';
    if (prevDestName) prevDestName.textContent = destName || '--';
    if (hudSrcLabel) hudSrcLabel.textContent = sourceName || 'Departure';
    if (hudDestLabel) hudDestLabel.textContent = destName || 'Destination';
    if (navPillText && sourceName && destName) navPillText.textContent = `${sourceName} → ${destName}`;

    if (selectedSource && selectedDestination) {
        const sourceMapping = selectedSource.kind === 'manual-start' ? selectedSource : mappingFor(selectedSource);
        const destinationMapping = mappingFor(selectedDestination);
        const metricDist = document.getElementById('preview-metric-distance');
        const metricTime = document.getElementById('preview-metric-time');
        const hudDistBadge = document.getElementById('hud-distance-badge');

        if (selectedSource.kind === 'current-location') {
            if (navigation.active && navigation.lastNode && destinationMapping) {
                const res = dijkstra(navigation.lastNode, destinationMapping.node_id);
                if (res) {
                    const distStr = formatDistance(res.distance);
                    const timeStr = Math.max(1, Math.round(res.distance / WALKING_SPEED_MPS / 60)) + ' min';
                    if (metricDist) metricDist.textContent = distStr;
                    if (metricTime) metricTime.textContent = timeStr;
                    if (hudDistBadge) hudDistBadge.textContent = distStr;
                }
            } else {
                if (metricDist) metricDist.textContent = 'Awaiting GPS';
                if (metricTime) metricTime.textContent = 'After validation';
                if (hudDistBadge) hudDistBadge.textContent = 'Awaiting GPS';
            }
        } else if (graphNodeIdFor(sourceMapping) && graphNodeIdFor(destinationMapping)) {
            const algorithm = document.getElementById('route-algorithm').value;
            const res = algorithm === 'bfs'
                ? bfs(graphNodeIdFor(sourceMapping), graphNodeIdFor(destinationMapping))
                : dijkstra(graphNodeIdFor(sourceMapping), graphNodeIdFor(destinationMapping));
            if (res) {
                const distStr = formatDistance(res.distance);
                const timeStr = Math.max(1, Math.round(res.distance / WALKING_SPEED_MPS / 60)) + ' min';
                if (metricDist) metricDist.textContent = distStr;
                if (metricTime) metricTime.textContent = timeStr;
                if (hudDistBadge) hudDistBadge.textContent = distStr;
            } else {
                if (metricDist) metricDist.textContent = 'Unreachable';
                if (metricTime) metricTime.textContent = '--';
                if (hudDistBadge) hudDistBadge.textContent = 'No route';
            }
        }
    }
}

// Flow Button Event Listeners
document.getElementById('btn-start-journey')?.addEventListener('click', () => showScreen(SCREENS.SOURCE));
document.getElementById('btn-browse-destinations')?.addEventListener('click', () => showScreen(SCREENS.DESTINATION));
document.getElementById('header-brand-trigger')?.addEventListener('click', () => showScreen(SCREENS.WELCOME));

// Screen 2
document.getElementById('btn-back-source-to-welcome')?.addEventListener('click', () => showScreen(SCREENS.WELCOME));
document.getElementById('btn-use-live-gps')?.addEventListener('click', () => {
    selectCurrentLocationSource();
    setTimeout(() => showScreen(SCREENS.DESTINATION), 350);
});
document.getElementById('btn-continue-to-dest')?.addEventListener('click', () => showScreen(SCREENS.DESTINATION));

// Screen 3
document.getElementById('btn-back-dest-to-source')?.addEventListener('click', () => showScreen(SCREENS.SOURCE));
document.getElementById('dest-departure-recap')?.addEventListener('click', () => showScreen(SCREENS.SOURCE));
document.getElementById('btn-find-route-preview')?.addEventListener('click', () => {
    calculateRouteAndAdvance();
});

// Category Filter Tabs in Screen 3
document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentCategoryFilter = tab.dataset.category || 'all';
        renderDestinationCards(currentCategoryFilter);
    });
});

// Screen 4
document.getElementById('btn-back-preview-to-dest')?.addEventListener('click', () => showScreen(SCREENS.DESTINATION));
document.getElementById('btn-change-source')?.addEventListener('click', () => showScreen(SCREENS.SOURCE));
document.getElementById('btn-change-destination')?.addEventListener('click', () => showScreen(SCREENS.DESTINATION));
document.getElementById('btn-view-map-preview')?.addEventListener('click', () => {
    if (selectedSource?.kind === 'current-location') {
        document.getElementById('route-status').textContent = 'Start Live Navigation to verify your GPS position and show a campus route.';
        return;
    }
    if (displayRoute()) showScreen(SCREENS.NAVIGATION);
});

// Screen 5
document.getElementById('btn-exit-navigation')?.addEventListener('click', () => showScreen(SCREENS.PREVIEW));
document.getElementById('btn-toggle-layers-sheet')?.addEventListener('click', () => {
    const pop = document.getElementById('map-layers-popover');
    if (pop) pop.hidden = !pop.hidden;
});
document.getElementById('btn-close-layers-popover')?.addEventListener('click', () => {
    const pop = document.getElementById('map-layers-popover');
    if (pop) pop.hidden = true;
});

// Core Controls Event Listeners
document.getElementById('clear-destination').addEventListener('click', clearDestination);
document.getElementById('clear-route').addEventListener('click', () => {
    routeLayer.clearLayers();
    document.getElementById('route-status').textContent = 'Route cleared. Choose both locations to calculate again.';
    updateFlowUI();
});
document.getElementById('route-algorithm').addEventListener('change', () => {
    displayRoute();
    updateFlowUI();
});
document.getElementById('start-navigation').addEventListener('click', () => {
    if (selectedSource && selectedSource.kind === 'current-location') {
        startNavigation();
    } else {
        if (displayRoute()) showScreen(SCREENS.NAVIGATION);
    }
});
document.getElementById('stop-navigation').addEventListener('click', stopNavigation);
document.getElementById('retry-location').addEventListener('click', retryNavigation);
document.getElementById('recenter-location').addEventListener('click', recenterLocation);
document.getElementById('follow-location').addEventListener('click', () => {
    navigation.followLocation = !navigation.followLocation;
    updateFollowButton();
    if (navigation.followLocation && navigation.locationMarker) map.panTo(navigation.locationMarker.getLatLng(), { animate: true, duration: 0.25 });
});
document.getElementById('manual-start').addEventListener('click', () => {
    setManualStartMode(true, true);
    document.getElementById('route-status').textContent = 'Click inside the campus boundary to choose a start point.';
});
document.getElementById('confirm-manual-start').addEventListener('click', confirmManualStart);
document.getElementById('cancel-manual-start').addEventListener('click', cancelManualStart);
map.on('click', chooseManualStart);

const swapButton = document.getElementById('swap-locations');
if (swapButton) swapButton.addEventListener('click', swapLocations);

// Initialize Destination Cards and Welcome Screen on Layer Load
loadGraph().then(() => Promise.all([
    loadLayer('buildings', 'buildings.geojson', { style: styleBuilding, onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) }),
    loadLayer('roads', 'roads.geojson', { style: styleRoad, onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) }),
    loadLayer('paths', 'paths.geojson', { style: stylePath, onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) }),
    loadLayer('landmarks', 'landmarks.geojson', { pointToLayer: pointLayer, onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) }),
    loadLayer('campus boundary', 'campus_boundary.geojson', { style: () => ({ color: '#d14e50', weight: 3, dashArray: '9 6', fill: false }), onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) })
])).then(() => {
    L.control.layers(null, { Buildings: layers.buildings, Roads: layers.roads, 'Walking paths': layers.paths, Landmarks: layers.landmarks, 'Campus boundary': layers['campus boundary'] }, { collapsed: false }).addTo(map);
    const boundary = layers['campus boundary'].getBounds(); if (boundary.isValid()) map.fitBounds(boundary.pad(0.08));
    bindSearch('source-search', 'source'); bindSearch('search', 'destination');
    renderDestinationCards('all');
    showScreen(SCREENS.WELCOME);
}).catch(error => { console.error('Campus map loading failed:', error); document.getElementById('route-status').textContent = error.message; });

window.addEventListener('beforeunload', () => {
    if (navigation.watchId !== null) navigator.geolocation.clearWatch(navigation.watchId);
    if (navigation.animationFrame) cancelAnimationFrame(navigation.animationFrame);
    stopPrediction();
    if (navigation.followBound) map.off('dragstart', handleMapDragStart);
});

document.addEventListener('click', event => {
    if (!event.target.closest('.autocomplete')) {
        document.querySelectorAll('.search-results').forEach(resultBox => { resultBox.hidden = true; });
    }
});
