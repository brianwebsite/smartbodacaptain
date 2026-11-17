import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';

/// The phone's current position, or null if location is off or not allowed.
///
/// A position the phone already knows (a few minutes old at most) is returned at once, so buttons
/// do not wait for a satellite fix. Pass [fresh] to insist on a new reading.
Future<LatLng?> currentLatLng({bool fresh = false}) async {
  try {
    final enabled = await Geolocator.isLocationServiceEnabled();
    if (!enabled) return null;
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
      return null;
    }
    Position? known;
    try {
      known = await Geolocator.getLastKnownPosition();
    } catch (_) {
      known = null;
    }
    if (!fresh && known != null && DateTime.now().difference(known.timestamp).inMinutes < 5) {
      return LatLng(known.latitude, known.longitude);
    }
    try {
      // Balanced accuracy gets a fix quickly, even indoors, and is plenty for finding a captain.
      final p = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.medium, timeLimit: Duration(seconds: 10)),
      );
      return LatLng(p.latitude, p.longitude);
    } catch (_) {
      // No fresh fix in time: an older position is better than none.
      return known == null ? null : LatLng(known.latitude, known.longitude);
    }
  } catch (_) {
    return null;
  }
}

/// Why [currentLatLng] gave nothing, in words the person can act on. Null when location works.
Future<String?> locationProblem() async {
  try {
    if (!await Geolocator.isLocationServiceEnabled()) {
      return 'Location is switched off on this phone. Turn it on in the phone settings, then try again.';
    }
    final permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.deniedForever) {
      return 'Location is blocked for this app. Open the phone settings, choose this app, then Permissions, then Location, and allow it.';
    }
    if (permission == LocationPermission.denied) {
      return 'Please allow location for this app when the phone asks.';
    }
    return 'The phone could not find your position yet. Move to an open area and try again.';
  } catch (_) {
    return 'Could not read your location. Try again.';
  }
}
