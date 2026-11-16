import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import 'vehicle.dart';

/// Centre of Kampala. Only used to point the map camera before the phone
/// has found its own location; it is never sent to the server as data.
const LatLng kampalaCentre = LatLng(0.3476, 32.5825);

/// A map pin.
Marker pinMarker(LatLng point, {IconData icon = Icons.location_on, Color color = Colors.red, double size = 42}) {
  return Marker(
    point: point,
    width: size,
    height: size,
    alignment: Alignment.topCenter,
    child: Icon(icon, color: color, size: size),
  );
}

/// A round dot marker, for people and bikes.
Marker dotMarker(LatLng point, {IconData icon = Icons.two_wheeler, Color color = Colors.green}) {
  return Marker(
    point: point,
    width: 40,
    height: 40,
    child: Container(
      decoration: BoxDecoration(
        color: Colors.white,
        shape: BoxShape.circle,
        border: Border.all(color: color, width: 2),
      ),
      child: Icon(icon, color: color, size: 22),
    ),
  );
}

/// A vehicle on the map, drawn with its own icon and colour.
Marker vehicleMarker(LatLng point, String vehicleType, {bool big = false}) {
  final v = vehicleById(vehicleType);
  final size = big ? 48.0 : 38.0;
  return Marker(
    point: point,
    width: size,
    height: size,
    child: Container(
      decoration: BoxDecoration(
        color: Colors.white,
        shape: BoxShape.circle,
        border: Border.all(color: v.color, width: big ? 3 : 2),
        boxShadow: const [BoxShadow(blurRadius: 4, color: Colors.black26)],
      ),
      child: Icon(v.icon, color: v.color, size: big ? 28 : 22),
    ),
  );
}

/// The blue dot for "you are here".
Marker meMarker(LatLng point) {
  return Marker(
    point: point,
    width: 26,
    height: 26,
    child: Container(
      decoration: BoxDecoration(
        color: const Color(0xFF1A73E8),
        shape: BoxShape.circle,
        border: Border.all(color: Colors.white, width: 3),
        boxShadow: const [BoxShadow(blurRadius: 6, color: Colors.black38)],
      ),
    ),
  );
}

/// OpenStreetMap map with markers. Tap reports the tapped point.
class BodaMap extends StatelessWidget {
  const BodaMap({
    super.key,
    required this.center,
    required this.userAgentPackageName,
    this.controller,
    this.zoom = 15,
    this.markers = const <Marker>[],
    this.lines = const <Polyline>[],
    this.onTap,
    this.onMoved,
  });

  final LatLng center;
  final double zoom;
  final String userAgentPackageName;
  final MapController? controller;
  final List<Marker> markers;
  final List<Polyline> lines;
  final void Function(LatLng point)? onTap;

  /// Called as the map is dragged, with the point under the middle of the map.
  final void Function(LatLng centre)? onMoved;

  @override
  Widget build(BuildContext context) {
    return FlutterMap(
      mapController: controller,
      options: MapOptions(
        initialCenter: center,
        initialZoom: zoom,
        onTap: onTap == null ? null : (TapPosition tap, LatLng point) => onTap!(point),
        onPositionChanged: onMoved == null ? null : (MapCamera camera, bool hasGesture) => onMoved!(camera.center),
      ),
      children: [
        TileLayer(
          urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          userAgentPackageName: userAgentPackageName,
        ),
        PolylineLayer(polylines: lines),
        MarkerLayer(markers: markers),
        const RichAttributionWidget(
          attributions: [TextSourceAttribution('OpenStreetMap contributors')],
        ),
      ],
    );
  }
}
