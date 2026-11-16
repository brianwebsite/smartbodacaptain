import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:smartboda_core/smartboda_core.dart';

enum _Pick { pickup, dropoff }

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.session});

  final Session session;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  ApiClient get _api => widget.session.api;

  final MapController _map = MapController();
  Timer? _poll;

  LatLng? _pickup;
  LatLng? _dropoff;
  _Pick _picking = _Pick.dropoff;
  bool _locating = true;
  bool _locationDenied = false;

  FareEstimate? _estimate;
  bool _estimating = false;
  bool _requesting = false;
  String? _error;

  Trip? _trip;
  bool _ratingOpen = false;
  final Set<String> _skipped = {};

  @override
  void initState() {
    super.initState();
    _findMe();
    _refreshTrip();
    _poll = Timer.periodic(const Duration(seconds: 4), (_) => _refreshTrip());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _findMe() async {
    final me = await currentLatLng();
    if (!mounted) return;
    setState(() {
      _locating = false;
      _locationDenied = me == null;
      if (me != null) {
        _pickup = me;
        _map.move(me, 15);
      }
    });
  }

  Future<void> _refreshTrip() async {
    try {
      final r = await _api.get('/api/passenger/current');
      if (!mounted) return;
      final t = r['trip'] == null ? null : Trip.fromJson(r['trip'] as Map<String, dynamic>);
      final u = r['unrated'] == null ? null : Trip.fromJson(r['unrated'] as Map<String, dynamic>);
      final before = _trip;
      Trip? shown = t;
      if (t == null && before != null && !before.isFinal) {
        // The trip left the active list: find out how it ended.
        try {
          final fr = await _api.get('/api/trips/${before.id}');
          final ft = Trip.fromJson(fr['trip'] as Map<String, dynamic>);
          if (ft.status == 'no_captain' || ft.status == 'cancelled') shown = ft;
        } on ApiException {
          // Ignore; the next poll tries again.
        }
      } else if (t == null && before != null && before.isFinal && before.status != 'completed') {
        shown = before; // keep the ending visible until the passenger taps OK
      }
      if (!mounted) return;
      setState(() {
        _trip = shown;
      });
      if (t == null && u != null && !_ratingOpen && !_skipped.contains(u.id)) _openRating(u);
    } on ApiException {
      // Keep showing the last known state; the next poll will retry.
    }
  }

  void _tapMap(LatLng p) {
    if (_trip != null) return;
    setState(() {
      if (_picking == _Pick.pickup) {
        _pickup = p;
      } else {
        _dropoff = p;
      }
      _estimate = null;
      _error = null;
    });
    if (_pickup != null && _dropoff != null) _getEstimate();
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
        'pickup': {'lat': pu.latitude, 'lng': pu.longitude},
        'dropoff': {'lat': dr.latitude, 'lng': dr.longitude},
      });
      if (mounted) setState(() => _estimate = FareEstimate.fromJson(r));
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _estimating = false);
    }
  }

  Future<void> _request() async {
    final pu = _pickup, dr = _dropoff;
    if (pu == null || dr == null) return;
    setState(() {
      _requesting = true;
      _error = null;
    });
    try {
      final r = await _api.post('/api/trips', {
        'pickup': {'lat': pu.latitude, 'lng': pu.longitude},
        'dropoff': {'lat': dr.latitude, 'lng': dr.longitude},
        'paymentMethod': 'cash',
      });
      if (mounted) {
        setState(() {
          _trip = Trip.fromJson(r['trip'] as Map<String, dynamic>);
          _estimate = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _requesting = false);
    }
  }

  Future<void> _cancel(Trip t) async {
    try {
      await _api.post('/api/trips/${t.id}/cancel');
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
    _skipped.add(t.id);
    _ratingOpen = false;
    await _refreshTrip();
  }

  void _clearFinished() {
    setState(() {
      _trip = null;
      _dropoff = null;
      _estimate = null;
    });
  }

  List<Marker> _markers() {
    final out = <Marker>[];
    final t = _trip;
    if (t != null) {
      out.add(pinMarker(LatLng(t.pickup.lat, t.pickup.lng), color: Colors.green));
      out.add(pinMarker(LatLng(t.dropoff.lat, t.dropoff.lng), color: Colors.red));
      final c = t.captain;
      if (c?.lat != null && c?.lng != null) {
        out.add(dotMarker(LatLng(c!.lat!, c.lng!)));
      }
    } else {
      if (_pickup != null) out.add(pinMarker(_pickup!, color: Colors.green));
      if (_dropoff != null) out.add(pinMarker(_dropoff!, color: Colors.red));
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final user = widget.session.user!;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Smart Boda'),
        actions: [
          IconButton(
            tooltip: 'My location',
            icon: const Icon(Icons.my_location),
            onPressed: _findMe,
          ),
          PopupMenuButton<String>(
            onSelected: (v) {
              if (v == 'history') {
                Navigator.of(context).push(MaterialPageRoute<void>(
                    builder: (_) => HistoryScreen(api: _api)));
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
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: BodaMap(
              controller: _map,
              center: _pickup ?? kampalaCentre,
              userAgentPackageName: 'ug.smartboda.passenger',
              markers: _markers(),
              onTap: _tapMap,
            ),
          ),
          _panel(context),
        ],
      ),
    );
  }

  Widget _panel(BuildContext context) {
    final t = _trip;
    return Material(
      elevation: 8,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: t == null ? _requestPanel(context) : _tripPanel(context, t),
        ),
      ),
    );
  }

  Widget _requestPanel(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_locating) const Text('Finding your location...'),
        if (_locationDenied)
          const Text('Location is off. Tap the map to set your pickup point.'),
        SegmentedButton<_Pick>(
          segments: const [
            ButtonSegment(value: _Pick.pickup, label: Text('Set pickup'), icon: Icon(Icons.trip_origin)),
            ButtonSegment(value: _Pick.dropoff, label: Text('Set drop-off'), icon: Icon(Icons.flag)),
          ],
          selected: {_picking},
          onSelectionChanged: (s) => setState(() => _picking = s.first),
        ),
        const SizedBox(height: 8),
        Text(_dropoff == null ? 'Tap the map to choose where you are going.' : 'Drop-off chosen. Tap again to change it.'),
        if (_estimating) const Padding(padding: EdgeInsets.only(top: 8), child: LinearProgressIndicator()),
        if (_estimate != null) ...[
          const SizedBox(height: 8),
          Text(ugx(_estimate!.fare),
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.bold)),
          Text(
            '${_estimate!.distanceKm} km · about ${_estimate!.durationMin} min · pay cash to your captain'
            '${_estimate!.isEstimate ? '\nDistance is approximate' : ''}',
            textAlign: TextAlign.center,
          ),
        ],
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: (_estimate == null || _requesting) ? null : _request,
          child: _requesting
              ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : const Text('Request a boda'),
        ),
      ],
    );
  }

  Widget _tripPanel(BuildContext context, Trip t) {
    final c = t.captain;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(statusLabel(t.status),
            style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        Text('${ugx(t.fare)} cash · ${t.distanceKm} km'),
        if (t.status == 'requested') ...[
          const SizedBox(height: 8),
          const LinearProgressIndicator(),
        ],
        if (c != null) ...[
          const Divider(height: 24),
          Text(c.name, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          Text('${c.bikePlate}${c.bikeModel != null && c.bikeModel!.isNotEmpty ? ' · ${c.bikeModel}' : ''}'),
          Text(c.phone),
        ],
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ),
        const SizedBox(height: 12),
        if (t.status == 'no_captain' || t.status == 'cancelled')
          FilledButton(onPressed: _clearFinished, child: const Text('OK'))
        else if (t.status != 'in_progress' && !t.isFinal)
          OutlinedButton(onPressed: () => _cancel(t), child: const Text('Cancel trip')),
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
    return Padding(
      padding: EdgeInsets.fromLTRB(24, 24, 24, 24 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Trip complete · ${ugx(widget.trip.fare)}',
              textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 4),
          const Text('Please pay your captain in cash. How was the ride?', textAlign: TextAlign.center),
          const SizedBox(height: 12),
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
