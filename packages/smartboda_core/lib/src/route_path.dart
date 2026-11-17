import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import 'api.dart';
import 'theme.dart';

/// Looks up the road between two points, remembers it, and hands back a line to draw.
/// Until the road arrives (or when none is available) a straight line is drawn, so the map is never empty.
class RouteFinder {
  RouteFinder(this.api);

  final ApiClient api;
  final Map<String, List<LatLng>?> _done = {};
  final Set<String> _busy = {};

  // About 110 m: a moving captain does not ask for a new road at every step.
  static String _key(LatLng a, LatLng b) =>
      '${a.latitude.toStringAsFixed(3)},${a.longitude.toStringAsFixed(3)}>${b.latitude.toStringAsFixed(3)},${b.longitude.toStringAsFixed(3)}';

  /// Remembers a road the server already sent (for example with the fare estimate).
  void remember(LatLng a, LatLng b, List<LatLng>? path) => _done[_key(a, b)] = path;

  /// The points to draw from [a] to [b]. [onReady] is called when a better line has arrived.
  List<LatLng> line(LatLng a, LatLng b, VoidCallback onReady) {
    final key = _key(a, b);
    if (_done.containsKey(key)) {
      final path = _done[key];
      if (path == null || path.length < 2) return [a, b];
      return [a, ...path, b]; // joined to the live points so the line starts exactly where the marker is
    }
    if (_busy.add(key)) {
      api.post('/api/route', {
        'from': {'lat': a.latitude, 'lng': a.longitude},
        'to': {'lat': b.latitude, 'lng': b.longitude},
      }).then((r) {
        final raw = r['path'];
        _done[key] = raw is List
            ? raw.map((p) => LatLng(((p as List)[0] as num).toDouble(), (p[1] as num).toDouble())).toList()
            : null;
      }).catchError((Object _) {
        _done[key] = null; // no road available: keep the straight line
      }).whenComplete(() {
        _busy.remove(key);
        onReady();
      });
    }
    return [a, b];
  }

  /// A road with a white edge so it stands out on the map.
  static Polyline draw(List<LatLng> points, {Color color = brandPrimary, double width = 5}) =>
      Polyline(points: points, strokeWidth: width, color: color, borderStrokeWidth: 2, borderColor: Colors.white);
}
