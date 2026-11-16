import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

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

/// OpenStreetMap map with markers. Tap reports the tapped point.
class BodaMap extends StatelessWidget {
  const BodaMap({
    super.key,
    required this.center,
    required this.userAgentPackageName,
    this.controller,
    this.zoom = 15,
    this.markers = const <Marker>[],
    this.onTap,
  });

  final LatLng center;
  final double zoom;
  final String userAgentPackageName;
  final MapController? controller;
  final List<Marker> markers;
  final void Function(LatLng point)? onTap;

  @override
  Widget build(BuildContext context) {
    return FlutterMap(
      mapController: controller,
      options: MapOptions(
        initialCenter: center,
        initialZoom: zoom,
        onTap: onTap == null ? null : (TapPosition tap, LatLng point) => onTap!(point),
      ),
      children: [
        TileLayer(
          urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          userAgentPackageName: userAgentPackageName,
        ),
        MarkerLayer(markers: markers),
        const RichAttributionWidget(
          attributions: [TextSourceAttribution('OpenStreetMap contributors')],
        ),
      ],
    );
  }
}
