import 'dart:math';

import 'package:latlong2/latlong.dart';

const Distance _distance = Distance();

/// Straight-line kilometres between two points.
double kmBetween(LatLng a, LatLng b) => _distance.as(LengthUnit.Kilometer, a, b);

/// "About N minutes": straight line x 1.35 for roads, at 22 km/h in Kampala traffic.
/// This is an estimate and the apps always say "about".
int etaMinutes(double straightKm) => max(1, ((straightKm * 1.35) / 22 * 60).round());
