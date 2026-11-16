import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:smartboda_core/smartboda_core.dart';

import 'search_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.session});

  final Session session;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  ApiClient get _api => widget.session.api;

  final MapController _map = MapController();
  Timer? _tripTimer;
  Timer? _nearbyTimer;
  Timer? _meTimer;

  // where I am, and the trip I am planning
  LatLng? _me;
  Place? _pickup;
  bool _pickupIsMe = true;
  Place? _dropoff;
  bool _locating = true;
  bool _locationDenied = false;

  FareEstimate? _estimate;
  bool _estimating = false;
  String _vehicle = 'boda';
  bool _requesting = false;
  String? _error;

  List<NearbyDriver> _nearby = [];

  // the trip in progress
  Trip? _trip;
  bool _ratingOpen = false;
  final Set<String> _skippedRatings = {};
  String? _fittedFor;

  @override
  void initState() {
    super.initState();
    _findMe();
    _refreshTrip();
    _loadNearby();
    _tripTimer = Timer.periodic(const Duration(seconds: 4), (_) => _refreshTrip());
    _nearbyTimer = Timer.periodic(const Duration(seconds: 7), (_) => _loadNearby());
    _meTimer = Timer.periodic(const Duration(seconds: 10), (_) => _updateMe());
  }

  @override
  void dispose() {
    _tripTimer?.cancel();
    _nearbyTimer?.cancel();
    _meTimer?.cancel();
    super.dispose();
  }

  // ---------- my location ----------

  Future<void> _findMe() async {
    final me = await currentLatLng();
    if (!mounted) return;
    setState(() {
      _locating = false;
      _locationDenied = me == null;
      _me = me;
    });
    if (me == null) return;
    _moveMap(me, 16);
    if (_pickup == null || _pickupIsMe) {
      _setPickupFromMe(me);
    }
    _loadNearby();
  }

  /// Quietly keeps the blue dot (and an automatic pickup) up to date.
  Future<void> _updateMe() async {
    if (_trip != null) return;
    final me = await currentLatLng();
    if (!mounted || me == null) return;
    setState(() => _me = me);
    final p = _pickup;
    if (_pickupIsMe && (p == null || kmBetween(LatLng(p.lat, p.lng), me) > 0.05)) {
      _setPickupFromMe(me, estimate: _dropoff != null);
    }
  }

  void _setPickupFromMe(LatLng me, {bool estimate = false}) {
    setState(() {
      _pickupIsMe = true;
      final before = _pickup;
      final sameSpot = before != null && kmBetween(LatLng(before.lat, before.lng), me) < 0.15;
      _pickup = Place(lat: me.latitude, lng: me.longitude, label: sameSpot ? before.label : 'Current location');
    });
    _nameThePlace(me);
    if (estimate) _getEstimate();
  }

  /// Looks up a readable name for a point, like "Ntinda, Kampala".
  Future<void> _nameThePlace(LatLng at) async {
    try {
      final r = await _api.get('/api/places/reverse?lat=${at.latitude}&lng=${at.longitude}');
      final p = r['place'];
      if (p is Map<String, dynamic> && mounted && _pickupIsMe) {
        final label = p['label'] as String?;
        final current = _pickup;
        if (label != null && current != null && kmBetween(LatLng(current.lat, current.lng), at) < 0.1) {
          setState(() => _pickup = Place(lat: current.lat, lng: current.lng, label: label));
        }
      }
    } on ApiException {
      // Keep "Current location".
    }
  }

  void _moveMap(LatLng to, double zoom) {
    try {
      _map.move(to, zoom);
    } catch (_) {
      // The map is not on screen yet.
    }
  }

  void _fit(List<LatLng> points) {
    if (points.isEmpty) return;
    if (points.length == 1) {
      _moveMap(points.first, 16);
      return;
    }
    try {
      _map.fitCamera(CameraFit.bounds(
        bounds: LatLngBounds.fromPoints(points),
        padding: const EdgeInsets.fromLTRB(48, 200, 48, 380),
        maxZoom: 17,
      ));
    } catch (_) {
      // The map is not on screen yet.
    }
  }

  // ---------- nearby drivers ----------

  Future<void> _loadNearby() async {
    if (_trip != null) return;
    final at = _pickup != null ? LatLng(_pickup!.lat, _pickup!.lng) : _me;
    if (at == null) return;
    try {
      final r = await _api.get('/api/passenger/nearby?lat=${at.latitude}&lng=${at.longitude}');
      if (!mounted) return;
      setState(() {
        _nearby = (r['drivers'] as List<dynamic>)
            .map((d) => NearbyDriver.fromJson(d as Map<String, dynamic>))
            .toList();
      });
    } on ApiException {
      // Keep the last list.
    }
  }

  ({int count, int? etaMin}) _summary(String vehicleType) {
    final mine = _nearby.where((d) => d.vehicleType == vehicleType).toList();
    if (mine.isEmpty) return (count: 0, etaMin: null);
    return (count: mine.length, etaMin: mine.map((d) => d.etaMin).reduce((a, b) => a < b ? a : b));
  }

  // ---------- choosing places ----------

  Future<void> _choose({required bool forPickup}) async {
    final here = _me == null ? null : Place(lat: _me!.latitude, lng: _me!.longitude, label: 'Current location');
    final p = await Navigator.of(context).push<Place>(
      MaterialPageRoute(
        builder: (_) => SearchScreen(
          api: _api,
          title: forPickup ? 'Where should we pick you up?' : 'Where are you going?',
          near: _me ?? (_pickup == null ? null : LatLng(_pickup!.lat, _pickup!.lng)),
          here: here,
        ),
      ),
    );
    if (p == null || !mounted) return;
    setState(() {
      if (forPickup) {
        // Choosing "current location" goes back to automatic mode.
        _pickupIsMe = p.label == 'Current location';
        _pickup = p;
      } else {
        _dropoff = p;
      }
      _estimate = null;
      _error = null;
    });
    if (forPickup && _pickupIsMe && _me != null) _nameThePlace(_me!);
    _loadNearby();
    if (_pickup != null && _dropoff != null) {
      _fit([LatLng(_pickup!.lat, _pickup!.lng), LatLng(_dropoff!.lat, _dropoff!.lng)]);
      await _getEstimate();
    } else if (_pickup != null) {
      _moveMap(LatLng(_pickup!.lat, _pickup!.lng), 16);
    }
  }

  Future<void> _getEstimate() async {
    final pu = _pickup, dr = _dropoff;
    if (pu == null || dr == null) return;
    setState(() {
      _estimating = true;
      _error = null;
    });
    try {
      final r = await _api.post('/api/fare/estimate', {
        'pickup': {'lat': pu.lat, 'lng': pu.lng},
        'dropoff': {'lat': dr.lat, 'lng': dr.lng},
      });
      if (mounted) setState(() => _estimate = FareEstimate.fromJson(r));
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _estimating = false);
    }
  }

  void _clearDestination() {
    setState(() {
      _dropoff = null;
      _estimate = null;
      _error = null;
    });
    if (_pickup != null) _moveMap(LatLng(_pickup!.lat, _pickup!.lng), 16);
  }

  // ---------- requesting and following a trip ----------

  Future<void> _request() async {
    final pu = _pickup, dr = _dropoff;
    if (pu == null || dr == null) return;
    setState(() {
      _requesting = true;
      _error = null;
    });
    try {
      final r = await _api.post('/api/trips', {
        'pickup': {'lat': pu.lat, 'lng': pu.lng},
        'dropoff': {'lat': dr.lat, 'lng': dr.lng},
        'pickupLabel': pu.label,
        'dropoffLabel': dr.label,
        'vehicleType': _vehicle,
        'paymentMethod': 'cash',
      });
      if (mounted) {
        setState(() {
          _trip = Trip.fromJson(r['trip'] as Map<String, dynamic>);
          _estimate = null;
          _nearby = [];
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _requesting = false);
    }
  }

  Future<void> _refreshTrip() async {
    try {
      final r = await _api.get('/api/passenger/current');
      if (!mounted) return;
      final t = r['trip'] == null ? null : Trip.fromJson(r['trip'] as Map<String, dynamic>);
      final unrated = r['unrated'] == null ? null : Trip.fromJson(r['unrated'] as Map<String, dynamic>);
      final before = _trip;
      Trip? shown = t;
      if (t == null && before != null && !before.isFinal) {
        // The trip left the active list: find out how it ended.
        try {
          final fr = await _api.get('/api/trips/${before.id}');
          final ft = Trip.fromJson(fr['trip'] as Map<String, dynamic>);
          if (ft.status == 'no_captain' || ft.status == 'cancelled') shown = ft;
        } on ApiException {
          // The next poll tries again.
        }
      } else if (t == null && before != null && before.isFinal && before.status != 'completed') {
        shown = before; // keep the ending visible until the passenger taps OK
      }
      if (!mounted) return;
      setState(() => _trip = shown);
      if (shown != null) _followTrip(shown);
      if (t == null && unrated != null && !_ratingOpen && !_skippedRatings.contains(unrated.id)) {
        _openRating(unrated);
      }
    } on ApiException {
      // Keep showing the last known state; the next poll will retry.
    }
  }

  /// Frames the map for the current stage of the trip, once per stage.
  void _followTrip(Trip t) {
    final c = t.captain;
    final cap = (c?.lat != null && c?.lng != null) ? LatLng(c!.lat!, c.lng!) : null;
    final key = '${t.id}-${t.status}-${cap != null}';
    if (key == _fittedFor) return;
    _fittedFor = key;
    final pickup = LatLng(t.pickup.lat, t.pickup.lng);
    final dropoff = LatLng(t.dropoff.lat, t.dropoff.lng);
    switch (t.status) {
      case 'accepted':
      case 'arrived':
        _fit(cap == null ? [pickup, dropoff] : [cap, pickup]);
      case 'in_progress':
        _fit(cap == null ? [pickup, dropoff] : [cap, dropoff]);
      default:
        _fit([pickup, dropoff]);
    }
  }

  Future<void> _cancel(Trip t) async {
    final reason = await askCancelReason(context, captain: false);
    if (reason == null) return;
    try {
      await _api.post('/api/trips/${t.id}/cancel', {'reason': reason});
      await _refreshTrip();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _openRating(Trip t) async {
    _ratingOpen = true;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _RatingSheet(api: _api, trip: t),
    );
    _skippedRatings.add(t.id);
    _ratingOpen = false;
    await _refreshTrip();
  }

  void _openChat(Trip t) {
    final c = t.captain;
    if (c == null) return;
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => ChatScreen(
        api: _api,
        tripId: t.id,
        title: c.name,
        quickReplies: const ['I am at the pickup', 'Please wait a moment', 'Where are you?', 'Thank you'],
      ),
    ));
  }

  void _finishedOk() {
    setState(() {
      _trip = null;
      _dropoff = null;
      _estimate = null;
      _fittedFor = null;
    });
    if (_me != null) _moveMap(_me!, 16);
    _loadNearby();
  }

  // ---------- drawing ----------

  List<Marker> _markers() {
    final out = <Marker>[];
    final t = _trip;
    if (t != null) {
      out.add(pinMarker(LatLng(t.pickup.lat, t.pickup.lng), color: Colors.green));
      out.add(pinMarker(LatLng(t.dropoff.lat, t.dropoff.lng), color: Colors.red));
      final c = t.captain;
      if (c?.lat != null && c?.lng != null) {
        out.add(vehicleMarker(LatLng(c!.lat!, c.lng!), t.vehicleType, big: true));
      }
    } else {
      for (final d in _nearby) {
        out.add(vehicleMarker(LatLng(d.lat, d.lng), d.vehicleType));
      }
      if (_pickup != null) out.add(pinMarker(LatLng(_pickup!.lat, _pickup!.lng), color: Colors.green));
      if (_dropoff != null) out.add(pinMarker(LatLng(_dropoff!.lat, _dropoff!.lng), color: Colors.red));
    }
    if (_me != null) out.add(meMarker(_me!));
    return out;
  }

  List<Polyline> _lines() {
    final t = _trip;
    final scheme = Theme.of(context).colorScheme;
    if (t != null) {
      final c = t.captain;
      final cap = (c?.lat != null && c?.lng != null) ? LatLng(c!.lat!, c.lng!) : null;
      final pickup = LatLng(t.pickup.lat, t.pickup.lng);
      final dropoff = LatLng(t.dropoff.lat, t.dropoff.lng);
      if (t.status == 'accepted' && cap != null) {
        return [Polyline(points: [cap, pickup], strokeWidth: 4, color: scheme.primary)];
      }
      if (t.status == 'in_progress' && cap != null) {
        return [Polyline(points: [cap, dropoff], strokeWidth: 4, color: scheme.primary)];
      }
      if (t.status == 'requested') {
        return [Polyline(points: [pickup, dropoff], strokeWidth: 3, color: Colors.black38)];
      }
      return const [];
    }
    final pu = _pickup, dr = _dropoff;
    if (pu != null && dr != null) {
      return [Polyline(points: [LatLng(pu.lat, pu.lng), LatLng(dr.lat, dr.lng)], strokeWidth: 3, color: Colors.black38)];
    }
    return const [];
  }

  @override
  Widget build(BuildContext context) {
    final user = widget.session.user!;
    final t = _trip;
    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(
            child: BodaMap(
              controller: _map,
              center: _me ?? kampalaCentre,
              userAgentPackageName: 'ug.smartboda.passenger',
              markers: _markers(),
              lines: _lines(),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Align(alignment: Alignment.centerLeft, child: _menu(user)),
                  if (t == null) ...[const SizedBox(height: 8), _placesCard()],
                ],
              ),
            ),
          ),
          Align(
            alignment: Alignment.bottomCenter,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Align(
                  alignment: Alignment.centerRight,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(0, 0, 12, 12),
                    child: FloatingActionButton.small(
                      heroTag: 'recenter',
                      backgroundColor: Colors.white,
                      foregroundColor: const Color(0xFF1A73E8),
                      tooltip: 'My location',
                      onPressed: _findMe,
                      child: const Icon(Icons.my_location),
                    ),
                  ),
                ),
                _panel(context),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _menu(AppUser user) {
    return Material(
      color: Colors.white,
      shape: const CircleBorder(),
      elevation: 4,
      child: PopupMenuButton<String>(
        icon: const Icon(Icons.menu),
        tooltip: 'Menu',
        onSelected: (v) {
          if (v == 'history') {
            Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => HistoryScreen(api: _api)));
          } else if (v == 'logout') {
            widget.session.logout();
          }
        },
        itemBuilder: (_) => [
          PopupMenuItem(enabled: false, child: Text('${user.name}\n${user.phone}')),
          const PopupMenuItem(value: 'history', child: Text('Trip history')),
          const PopupMenuItem(value: 'logout', child: Text('Sign out')),
        ],
      ),
    );
  }

  Widget _placesCard() {
    return Card(
      elevation: 6,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            leading: const Icon(Icons.trip_origin, color: Colors.green),
            title: Text(
              _pickup?.text ?? (_locating ? 'Finding your location...' : 'Set your pickup'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            subtitle: Text(_pickupIsMe && _pickup != null ? 'Your current location' : 'Pickup'),
            trailing: const Icon(Icons.edit_outlined, size: 20),
            onTap: () => _choose(forPickup: true),
          ),
          const Divider(height: 1, indent: 56),
          ListTile(
            leading: const Icon(Icons.stop, color: Colors.red),
            title: Text(
              _dropoff?.text ?? 'Where to?',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontWeight: _dropoff == null ? FontWeight.w600 : null, fontSize: 17),
            ),
            trailing: _dropoff == null
                ? const Icon(Icons.search)
                : IconButton(icon: const Icon(Icons.close), tooltip: 'Clear', onPressed: _clearDestination),
            onTap: () => _choose(forPickup: false),
          ),
        ],
      ),
    );
  }

  Widget _panel(BuildContext context) {
    final t = _trip;
    return Material(
      elevation: 12,
      color: Theme.of(context).colorScheme.surface,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
          child: t != null
              ? _tripPanel(context, t)
              : _dropoff == null
                  ? _nearbyPanel(context)
                  : _optionsPanel(context),
        ),
      ),
    );
  }

  Widget _errorLine(BuildContext context) {
    if (_error == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
    );
  }

  /// Before a destination is chosen: what is around right now.
  Widget _nearbyPanel(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Rides near you', style: t.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
        if (_locationDenied)
          const Padding(
            padding: EdgeInsets.only(top: 4),
            child: Text('Location is off. Turn it on, or search for your pickup above.'),
          ),
        const SizedBox(height: 8),
        Row(
          children: [
            for (final v in vehicleTypes)
              Expanded(
                child: Builder(builder: (_) {
                  final s = _summary(v.id);
                  return Column(
                    children: [
                      Icon(v.icon, color: v.color, size: 32),
                      const SizedBox(height: 4),
                      Text(v.label, style: const TextStyle(fontWeight: FontWeight.w600)),
                      Text(
                        s.count == 0 ? 'None nearby' : 'About ${s.etaMin} min',
                        style: t.bodySmall,
                      ),
                    ],
                  );
                }),
              ),
          ],
        ),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: () => _choose(forPickup: false),
          icon: const Icon(Icons.search),
          label: const Text('Where to?'),
        ),
        _errorLine(context),
      ],
    );
  }

  /// After a destination is chosen: pick a vehicle and request.
  Widget _optionsPanel(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final est = _estimate;
    if (_estimating || (est == null && _error == null)) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [LinearProgressIndicator(), SizedBox(height: 12), Text('Working out your fare...')],
        ),
      );
    }
    if (est == null) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          const SizedBox(height: 8),
          OutlinedButton(onPressed: _getEstimate, child: const Text('Try again')),
        ],
      );
    }
    final chosen = est.option(_vehicle);
    final chosenType = vehicleById(_vehicle);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          '${est.distanceKm} km · about ${est.durationMin} min${est.isEstimate ? ' · approximate distance' : ''}',
          style: t.bodyMedium,
        ),
        const SizedBox(height: 8),
        for (final o in est.options)
          Builder(builder: (_) {
            final v = vehicleById(o.vehicleType);
            final selected = o.vehicleType == _vehicle;
            return Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: InkWell(
                borderRadius: BorderRadius.circular(14),
                onTap: () => setState(() => _vehicle = o.vehicleType),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: selected ? bodaGreen : Colors.black12, width: selected ? 2.5 : 1),
                    color: selected ? bodaGreen.withValues(alpha: 0.07) : null,
                  ),
                  child: Row(
                    children: [
                      Icon(v.icon, size: 34, color: v.color),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(v.label, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                            Text(
                              o.etaMin == null ? 'None nearby right now' : 'About ${o.etaMin} min away',
                              style: t.bodySmall,
                            ),
                          ],
                        ),
                      ),
                      Text(ugx(o.fare), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                    ],
                  ),
                ),
              ),
            );
          }),
        if (chosen != null && chosen.nearbyCount == 0)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(
              'No ${chosenType.label.toLowerCase()} is near you right now. You can still request, and we will keep looking.',
              style: t.bodySmall,
            ),
          ),
        Text('You pay your captain in cash.', style: t.bodySmall),
        _errorLine(context),
        const SizedBox(height: 8),
        FilledButton(
          onPressed: _requesting ? null : _request,
          child: _requesting
              ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : Text('Request ${chosenType.label}${chosen == null ? '' : ' · ${ugx(chosen.fare)}'}'),
        ),
      ],
    );
  }

  String? _etaLine(Trip t) {
    final c = t.captain;
    if (c?.lat == null || c?.lng == null) return null;
    final cap = LatLng(c!.lat!, c.lng!);
    switch (t.status) {
      case 'accepted':
        final m = etaMinutes(kmBetween(cap, LatLng(t.pickup.lat, t.pickup.lng)));
        return 'Arriving in about $m min';
      case 'arrived':
        return 'Your captain is at the pickup';
      case 'in_progress':
        final m = etaMinutes(kmBetween(cap, LatLng(t.dropoff.lat, t.dropoff.lng)));
        return 'About $m min to your destination';
    }
    return null;
  }

  Widget _tripPanel(BuildContext context, Trip t) {
    final th = Theme.of(context).textTheme;
    final c = t.captain;
    final v = vehicleById(t.vehicleType);
    final title = switch (t.status) {
      'requested' => 'Finding your ${v.label.toLowerCase()}...',
      'accepted' => 'Your captain is on the way',
      'arrived' => 'Your captain has arrived',
      'in_progress' => 'On your trip',
      'no_captain' => 'No captain found',
      'cancelled' => 'Trip cancelled',
      _ => statusLabel(t.status),
    };
    final eta = _etaLine(t);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(title, style: th.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
        if (eta != null) Text(eta, style: th.titleSmall?.copyWith(color: bodaGreen)),
        if (t.status == 'requested') ...[
          const SizedBox(height: 10),
          const LinearProgressIndicator(),
          const SizedBox(height: 6),
          const Text('We are asking captains near you. This usually takes a minute.'),
        ],
        if (t.status == 'no_captain')
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('Nobody nearby could take it. Please try again, or try another type of ride.'),
          ),
        if (c != null) ...[
          const SizedBox(height: 12),
          InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: () => showCaptainDetails(context, c, onMessage: () => _openChat(t)),
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(border: Border.all(color: Colors.black12), borderRadius: BorderRadius.circular(14)),
              child: Row(
                children: [
                  CircleAvatar(
                    radius: 24,
                    backgroundColor: bodaGreen,
                    child: Text(
                      c.name.isEmpty ? '?' : c.name.trim()[0].toUpperCase(),
                      style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.bold),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(c.name, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                        Row(children: [
                          const Icon(Icons.star, size: 16, color: bodaAmber),
                          const SizedBox(width: 2),
                          Text(c.rating == null ? 'New' : c.rating!.toStringAsFixed(1)),
                          Text('  ·  ${v.label}'),
                        ]),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(
                      color: bodaAmber,
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: Colors.black87),
                    ),
                    child: Text(c.bikePlate, style: const TextStyle(fontWeight: FontWeight.bold)),
                  ),
                  const Icon(Icons.chevron_right),
                ],
              ),
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => callPhone(context, c.phone),
                  icon: const Icon(Icons.call),
                  label: const Text('Call'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => _openChat(t),
                  icon: Badge(
                    label: Text('${t.unread}'),
                    isLabelVisible: t.unread > 0,
                    child: const Icon(Icons.chat_bubble_outline),
                  ),
                  label: const Text('Message'),
                ),
              ),
            ],
          ),
        ],
        const SizedBox(height: 10),
        Text('${ugx(t.fare)} cash · ${t.distanceKm} km', style: th.bodyMedium),
        _errorLine(context),
        const SizedBox(height: 8),
        if (t.status == 'no_captain' || t.status == 'cancelled')
          FilledButton(onPressed: _finishedOk, child: const Text('OK'))
        else if (t.status != 'in_progress' && !t.isFinal)
          TextButton(
            onPressed: () => _cancel(t),
            child: Text('Cancel trip', style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ),
      ],
    );
  }
}

class _RatingSheet extends StatefulWidget {
  const _RatingSheet({required this.api, required this.trip});

  final ApiClient api;
  final Trip trip;

  @override
  State<_RatingSheet> createState() => _RatingSheetState();
}

class _RatingSheetState extends State<_RatingSheet> {
  int _stars = 5;
  bool _busy = false;
  String? _error;

  Future<void> _send() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.post('/api/trips/${widget.trip.id}/rate', {'rating': _stars});
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final name = widget.trip.captain?.name;
    return Padding(
      padding: EdgeInsets.fromLTRB(24, 24, 24, 24 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('You have arrived', textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 6),
          Text('Please pay ${ugx(widget.trip.fare)} in cash.',
              textAlign: TextAlign.center, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
          const SizedBox(height: 14),
          Text(name == null ? 'How was your ride?' : 'How was your ride with $name?', textAlign: TextAlign.center),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              for (var i = 1; i <= 5; i++)
                IconButton(
                  iconSize: 40,
                  onPressed: () => setState(() => _stars = i),
                  icon: Icon(i <= _stars ? Icons.star : Icons.star_border, color: bodaAmber),
                ),
            ],
          ),
          if (_error != null) Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          const SizedBox(height: 8),
          FilledButton(onPressed: _busy ? null : _send, child: const Text('Send rating')),
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Skip')),
        ],
      ),
    );
  }
}
