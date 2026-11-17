import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:smartboda_core/smartboda_core.dart';

import 'search_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.session, this.onOpenWallet});

  final Session session;
  final VoidCallback? onOpenWallet;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with SingleTickerProviderStateMixin {
  ApiClient get _api => widget.session.api;
  late final RouteFinder _roads = RouteFinder(_api);

  void _redraw() {
    if (mounted) setState(() {});
  }

  final MapController _map = MapController();
  Timer? _tripTimer;
  Timer? _nearbyTimer;
  Timer? _meTimer;
  Timer? _bannerTimer;
  late final SmoothPoint _captainPoint = SmoothPoint(
    vsync: this,
    duration: const Duration(milliseconds: 3200),
    onChange: () {
      if (mounted) setState(() {});
    },
  );

  // where I am, and the trip I am planning
  LatLng? _me;
  Place? _pickup;
  bool _pickupIsMe = true;
  Place? _dropoff;
  bool _locating = true;

  FareEstimate? _estimate;
  bool _estimating = false;
  String _vehicle = 'boda';
  String _kind = 'ride'; // 'ride' or 'delivery'
  String _payment = 'cash'; // 'cash' or 'wallet'
  final _item = TextEditingController();
  final _receiverName = TextEditingController();
  final _receiverPhone = TextEditingController();
  bool _requesting = false;
  String? _error;

  List<NearbyDriver> _nearby = [];
  bool _nearbyLoaded = false;

  // the trip in progress
  Trip? _trip;
  bool _ratingOpen = false;
  final Set<String> _skippedRatings = {};
  String? _fittedFor;

  // following the captain: how far away they were at first, and what we already told the passenger
  String? _legKey;
  double _legStartKm = 0;
  double? _legKm;
  String? _lastStatus;
  int _lastBucket = 0;
  String? _banner;

  @override
  void initState() {
    super.initState();
    _findMe();
    _refreshTrip();
    _loadNearby();
    _tripTimer = Timer.periodic(const Duration(seconds: 3), (_) => _refreshTrip());
    _nearbyTimer = Timer.periodic(const Duration(seconds: 5), (_) => _loadNearby());
    _meTimer = Timer.periodic(const Duration(seconds: 12), (_) => _updateMe());
  }

  @override
  void dispose() {
    _tripTimer?.cancel();
    _nearbyTimer?.cancel();
    _meTimer?.cancel();
    _bannerTimer?.cancel();
    _captainPoint.dispose();
    _item.dispose();
    _receiverName.dispose();
    _receiverPhone.dispose();
    super.dispose();
  }

  // ---------- my location ----------

  Future<void> _findMe() async {
    final me = await currentLatLng();
    if (!mounted) return;
    setState(() {
      _locating = false;
      _me = me;
    });
    if (me == null) return;
    _moveMap(me, 16);
    if (_pickup == null || _pickupIsMe) {
      _setPickupFromMe(me);
    }
    _loadNearby();
  }

  /// Quietly keeps the blue dot (and an automatic pickup) up to date, and the account details fresh.
  Future<void> _updateMe() async {
    widget.session.refreshUser().catchError((_) {});
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
        padding: const EdgeInsets.fromLTRB(48, 120, 48, 420),
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
      final fresh = (r['drivers'] as List<dynamic>)
          .map((d) => NearbyDriver.fromJson(d as Map<String, dynamic>))
          .toList();
      // Someone just came online: say so, so a person waiting to choose a ride knows.
      String? arrived;
      if (_nearbyLoaded && _dropoff != null) {
        for (final v in vehicleTypes) {
          final was = _nearby.any((d) => d.vehicleType == v.id);
          final now = fresh.any((d) => d.vehicleType == v.id);
          if (!was && now) arrived = v.label;
        }
      }
      setState(() {
        _nearby = fresh;
        _nearbyLoaded = true;
      });
      if (arrived != null) _announce('A $arrived is now online near you');
    } on ApiException {
      // Keep the last list.
    }
  }

  // ---------- choosing places ----------

  Future<void> _choose({required bool forPickup}) async {
    final here = _me == null ? null : Place(lat: _me!.latitude, lng: _me!.longitude, label: 'Current location');
    final p = await Navigator.of(context).push<Place>(
      MaterialPageRoute(
        builder: (_) => SearchScreen(
          api: _api,
          title: forPickup ? 'Where should we pick you up?' : (_kind == 'delivery' ? 'Where should we deliver?' : 'Where are you going?'),
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
        'kind': _kind,
      });
      if (mounted) {
        final est = FareEstimate.fromJson(r);
        setState(() {
          _estimate = est;
          // Start on a type that has a captain nearby, but let the person pick any type.
          final current = est.option(_vehicle);
          if (current == null || (current.nearbyCount == 0 && _vehicle == 'boda')) {
            for (final o in est.options) {
              if (o.nearbyCount > 0) {
                _vehicle = o.vehicleType;
                break;
              }
            }
          }
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _estimating = false);
    }
  }

  void _setKind(String kind) {
    if (kind == _kind) return;
    setState(() {
      _kind = kind;
      _estimate = null;
      _error = null;
    });
    if (_dropoff != null) _getEstimate();
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
    if (_kind == 'delivery') {
      if (_item.text.trim().length < 2 || _receiverName.text.trim().length < 2 || _receiverPhone.text.trim().length < 9) {
        setState(() => _error = 'Tell us what you are sending, and the name and phone number of who receives it.');
        return;
      }
    }
    setState(() {
      _requesting = true;
      _error = null;
    });
    try {
      final body = <String, dynamic>{
        'pickup': {'lat': pu.lat, 'lng': pu.lng},
        'dropoff': {'lat': dr.lat, 'lng': dr.lng},
        'pickupLabel': pu.label,
        'dropoffLabel': dr.label,
        'vehicleType': _vehicle,
        'paymentMethod': _payment,
        'kind': _kind,
        if (_kind == 'delivery') ...{
          'deliveryItem': _item.text.trim(),
          'receiverName': _receiverName.text.trim(),
          'receiverPhone': _receiverPhone.text.trim(),
        },
      };
      final r = await _api.post('/api/trips', body);
      if (mounted) {
        HapticFeedback.mediumImpact();
        setState(() {
          _trip = Trip.fromJson(r['trip'] as Map<String, dynamic>);
          _estimate = null;
          _nearby = [];
        });
      }
    } on ApiException catch (e) {
      if (e.code == 'phone_needed' && mounted) {
        // Riders need a number to call. Ask for it once, then send the request again.
        if (await _askPhone()) {
          if (mounted) setState(() => _requesting = false);
          return _request();
        }
      } else if (mounted) {
        setState(() => _error = e.message);
      }
    } finally {
      if (mounted) setState(() => _requesting = false);
    }
  }

  Future<bool> _askPhone() async {
    final ctrl = TextEditingController();
    String? error;
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: const Text('Your phone number'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Your captain needs a number to call you when they arrive.'),
              TextField(
                controller: ctrl,
                autofocus: true,
                keyboardType: TextInputType.phone,
                decoration: InputDecoration(labelText: 'Phone number', hintText: '0772 123456', errorText: error),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(
              onPressed: () async {
                try {
                  await _api.put('/api/me/phone', {'phone': ctrl.text.trim()});
                  if (ctx.mounted) Navigator.pop(ctx, true);
                } on ApiException catch (e) {
                  setLocal(() => error = e.message);
                }
              },
              child: const Text('Save and continue'),
            ),
          ],
        ),
      ),
    );
    if (saved == true) await widget.session.refreshUser().catchError((_) {});
    return saved == true;
  }

  Future<void> _refreshTrip() async {
    try {
      final r = await _api.get('/api/passenger/current');
      if (!mounted) return;
      final t = r['trip'] == null ? null : Trip.fromJson(r['trip'] as Map<String, dynamic>);
      final unrated = r['unrated'] == null ? null : Trip.fromJson(r['unrated'] as Map<String, dynamic>);
      final before = _trip;
      Trip? shown = t;
      var finishedNow = false;
      if (t == null && before != null && !before.isFinal) {
        // The trip left the active list: find out how it ended.
        try {
          final fr = await _api.get('/api/trips/${before.id}');
          final ft = Trip.fromJson(fr['trip'] as Map<String, dynamic>);
          if (ft.status == 'no_captain' || ft.status == 'cancelled') shown = ft;
          if (ft.status == 'completed') finishedNow = true;
        } on ApiException {
          // The next poll tries again.
        }
      } else if (t == null && before != null && before.isFinal && before.status != 'completed') {
        shown = before; // keep the ending visible until the passenger taps OK
      }
      if (!mounted) return;
      setState(() => _trip = shown);
      if (finishedNow) _startFresh(); // the journey is over: no more fare work-out for the old trip
      if (shown != null) _followTrip(shown);
      if (shown == null) {
        _captainPoint.moveTo(null);
        _legKey = null;
        _legKm = null;
        _lastStatus = null;
      }
      if (t == null && unrated != null && !_ratingOpen && !_skippedRatings.contains(unrated.id)) {
        widget.session.refreshUser().catchError((_) {});
        _openRating(unrated);
      }
    } on ApiException {
      // Keep showing the last known state; the next poll will retry.
    }
  }

  /// Shows a short message at the top of the map and buzzes the phone.
  void _announce(String message) {
    HapticFeedback.mediumImpact();
    _bannerTimer?.cancel();
    setState(() => _banner = message);
    _bannerTimer = Timer(const Duration(seconds: 6), () {
      if (mounted) setState(() => _banner = null);
    });
  }

  /// Keeps the captain's marker gliding, works out the distance left, and says out loud
  /// when something changes (accepted, closer, arrived, started).
  void _followTrip(Trip t) {
    final c = t.captain;
    final cap = (c?.lat != null && c?.lng != null) ? LatLng(c!.lat!, c.lng!) : null;
    _captainPoint.moveTo(cap);
    final pickup = LatLng(t.pickup.lat, t.pickup.lng);
    final dropoff = LatLng(t.dropoff.lat, t.dropoff.lng);

    // distance left on the current leg
    double? leg;
    String? stage;
    if (cap != null && (t.status == 'accepted' || t.status == 'arrived')) {
      leg = kmBetween(cap, pickup);
      stage = 'pickup';
    } else if (cap != null && t.status == 'in_progress') {
      leg = kmBetween(cap, dropoff);
      stage = 'dropoff';
    }
    _legKm = leg;
    if (leg != null) {
      final key = '${t.id}-$stage';
      if (key != _legKey) {
        _legKey = key;
        _legStartKm = leg;
        _lastBucket = 0;
      } else if (leg > _legStartKm) {
        _legStartKm = leg; // the captain had to go around
      }
    }

    if (t.status != _lastStatus) {
      final first = _lastStatus == null;
      _lastStatus = t.status;
      if (!(first && t.status == 'requested')) {
        switch (t.status) {
          case 'accepted':
            _announce('${c?.name ?? 'A captain'} accepted your ${t.isDelivery ? 'delivery' : 'ride'} and is coming');
          case 'arrived':
            _announce('Your captain has arrived');
          case 'in_progress':
            _announce(t.isDelivery ? 'Your delivery is on its way' : 'Your trip has started');
          case 'cancelled':
            _announce('The trip was cancelled');
        }
      }
    } else if (t.status == 'accepted' && leg != null) {
      final bucket = leg <= 0.2 ? 3 : (leg <= 0.5 ? 2 : (leg <= 1 ? 1 : 0));
      if (bucket > _lastBucket) {
        _lastBucket = bucket;
        _announce(switch (bucket) {
          1 => 'Your captain is less than 1 km away',
          2 => 'Your captain is about ${distanceText(leg)} away',
          _ => 'Your captain is almost there',
        });
      }
    }

    // frame the map once per stage
    final key = '${t.id}-${t.status}-${cap != null}';
    if (key == _fittedFor) return;
    _fittedFor = key;
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
      final r = await _api.post('/api/trips/${t.id}/cancel', {'reason': reason});
      widget.session.applyUserJson(r['user']);
      final standing = widget.session.user?.standing;
      if (mounted && standing != null && !standing.isOk && standing.message != null) {
        await showDialog<void>(
          context: context,
          builder: (ctx) => AlertDialog(
            icon: const Icon(Icons.warning_amber_rounded, color: Color(0xFFB26A00), size: 40),
            title: const Text('Please be careful'),
            content: Text(standing.message!),
            actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('I understand'))],
          ),
        );
      }
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
    _startFresh();
    await _refreshTrip();
  }

  /// After a finished journey the home screen goes back to a clean start. The old destination is
  /// forgotten, so the app does not work out the same fare again.
  void _startFresh() {
    if (!mounted || _trip != null) return;
    setState(() {
      _dropoff = null;
      _estimate = null;
      _estimating = false;
      _fittedFor = null;
      _error = null;
    });
    if (_me != null) _moveMap(_me!, 16);
    _loadNearby();
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
    _captainPoint.moveTo(null);
    if (_me != null) _moveMap(_me!, 16);
    _loadNearby();
  }

  // ---------- drawing ----------

  List<Marker> _markers() {
    final out = <Marker>[];
    final t = _trip;
    if (t != null) {
      final pickup = LatLng(t.pickup.lat, t.pickup.lng);
      out.add(pinMarker(pickup, color: brandPrimary));
      out.add(pinMarker(LatLng(t.dropoff.lat, t.dropoff.lng), color: Colors.red));
      if (t.status == 'requested') out.add(searchingMarker(pickup));
      final cap = _captainPoint.value;
      if (cap != null && t.status != 'requested') out.add(animatedVehicleMarker(cap, t.vehicleType));
    } else {
      for (final d in _nearby) {
        if (_dropoff != null && d.vehicleType != _vehicle) continue; // show the type being looked at
        out.add(vehicleMarker(LatLng(d.lat, d.lng), d.vehicleType));
      }
      if (_pickup != null) out.add(pinMarker(LatLng(_pickup!.lat, _pickup!.lng), color: brandPrimary));
      if (_dropoff != null) out.add(pinMarker(LatLng(_dropoff!.lat, _dropoff!.lng), color: Colors.red));
    }
    if (_me != null) out.add(meMarker(_me!));
    return out;
  }

  List<Polyline> _lines() {
    final t = _trip;
    if (t != null) {
      final cap = _captainPoint.value;
      final pickup = LatLng(t.pickup.lat, t.pickup.lng);
      final dropoff = LatLng(t.dropoff.lat, t.dropoff.lng);
      if (t.status == 'accepted' && cap != null) {
        return [RouteFinder.draw(_roads.line(cap, pickup, _redraw))];
      }
      if (t.status == 'in_progress' && cap != null) {
        return [RouteFinder.draw(_roads.line(cap, dropoff, _redraw))];
      }
      if (t.status == 'requested') {
        return [RouteFinder.draw(_roads.line(pickup, dropoff, _redraw), color: Colors.black54, width: 4)];
      }
      return const [];
    }
    final pu = _pickup, dr = _dropoff;
    if (pu != null && dr != null) {
      final a = LatLng(pu.lat, pu.lng), b = LatLng(dr.lat, dr.lng);
      final est = _estimate;
      if (est == null) return [RouteFinder.draw([a, b], color: Colors.black38, width: 3)]; // the fare is still being worked out
      if (est.path != null) _roads.remember(a, b, est.path); // the estimate already carried the road
      return [RouteFinder.draw(_roads.line(a, b, _redraw))];
    }
    return const [];
  }

  @override
  Widget build(BuildContext context) {
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
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 300),
                transitionBuilder: (child, anim) => FadeTransition(
                  opacity: anim,
                  child: SlideTransition(
                    position: Tween(begin: const Offset(0, -0.4), end: Offset.zero).animate(anim),
                    child: child,
                  ),
                ),
                child: _banner == null
                    ? const SizedBox(key: ValueKey('none'), width: double.infinity)
                    : Material(
                        key: ValueKey(_banner),
                        color: brandPrimary,
                        elevation: 6,
                        borderRadius: BorderRadius.circular(14),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                          child: Row(
                            children: [
                              const Icon(Icons.notifications_active, color: brandAccent),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Text(_banner!, style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w600)),
                              ),
                            ],
                          ),
                        ),
                      ),
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
                _panel(context, t),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _panel(BuildContext context, Trip? t) {
    final maxHeight = MediaQuery.of(context).size.height * 0.8;
    final footer = t == null ? _requestFooter(context) : null;
    return Material(
      elevation: 12,
      color: Theme.of(context).colorScheme.surface,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Flexible(
              child: SingleChildScrollView(
                padding: EdgeInsets.fromLTRB(16, 12, 16, footer == null ? 10 : 6),
                child: AnimatedSize(
                  duration: const Duration(milliseconds: 250),
                  alignment: Alignment.topCenter,
                  child: t != null ? _tripPanel(context, t) : _planPanel(context),
                ),
              ),
            ),
            if (footer != null) Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 10), child: footer),
          ],
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

  // ---------- planning: kind, places card, options ----------

  Widget _kindSwitch() {
    return SegmentedButton<String>(
      showSelectedIcon: false,
      style: const ButtonStyle(visualDensity: VisualDensity.compact),
      segments: const [
        ButtonSegment(value: 'ride', icon: Icon(Icons.hail), label: Text('Ride')),
        ButtonSegment(value: 'delivery', icon: Icon(Icons.inventory_2_outlined), label: Text('Delivery')),
      ],
      selected: {_kind},
      onSelectionChanged: (s) => _setKind(s.first),
    );
  }

  Widget _planPanel(BuildContext context) {
    final user = widget.session.user;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (user != null) StandingBanner(user.standing),
        _kindSwitch(),
        const SizedBox(height: 8),
        _placesCard(),
        if (_dropoff == null) _errorLine(context) else _optionsSection(context),
      ],
    );
  }

  Widget _placesCard() {
    return Card(
      elevation: 0,
      margin: EdgeInsets.zero,
      color: brandSurface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: const BorderSide(color: Colors.black12)),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            dense: true,
            visualDensity: VisualDensity.compact,
            leading: const Icon(Icons.trip_origin, color: brandPrimary),
            title: Text(
              _pickup?.text ?? (_locating ? 'Current location' : 'Set your pickup'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            subtitle: Text(_pickupIsMe && _pickup != null ? 'Your current location' : 'Pickup'),
            trailing: const Icon(Icons.edit_outlined, size: 20),
            onTap: () => _choose(forPickup: true),
          ),
          const Divider(height: 1, indent: 56),
          ListTile(
            dense: true,
            visualDensity: VisualDensity.compact,
            leading: const Icon(Icons.location_on, color: Colors.red),
            title: Text(
              _dropoff?.text ?? (_kind == 'delivery' ? 'Where to deliver?' : 'Where to?'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontWeight: _dropoff == null ? FontWeight.w700 : null, fontSize: 17),
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

  Widget _deliveryForm() {
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        children: [
          TextField(
            controller: _item,
            textCapitalization: TextCapitalization.sentences,
            decoration: const InputDecoration(
              labelText: 'What are you sending?',
              prefixIcon: Icon(Icons.inventory_2_outlined),
              isDense: true,
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _receiverName,
                  textCapitalization: TextCapitalization.words,
                  decoration: const InputDecoration(labelText: 'Receiver name', isDense: true),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _receiverPhone,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'Receiver phone', isDense: true),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// One ride type as a compact square tile. Two sit side by side.
  Widget _optionTile(FareOption o, TextTheme t) {
    final v = vehicleById(o.vehicleType);
    final here = _nearby.where((d) => d.vehicleType == o.vehicleType).toList();
    // Once the live list is in, it is the truth; before that, use what the fare estimate said.
    final count = _nearbyLoaded ? here.length : o.nearbyCount;
    final eta = _nearbyLoaded ? (here.isEmpty ? null : here.map((d) => d.etaMin).reduce((a, b) => a < b ? a : b)) : o.etaMin;
    final available = count > 0;
    final selected = o.vehicleType == _vehicle;
    return Opacity(
      opacity: available || selected ? 1 : 0.7,
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () {
          setState(() => _vehicle = o.vehicleType);
          _loadNearby(); // look again right now, so a captain who just came online shows up
        },
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: selected ? brandPrimary : Colors.black12, width: selected ? 2.5 : 1),
            color: selected ? brandPrimary.withValues(alpha: 0.08) : Colors.white,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Icon(v.icon, size: 26, color: v.color),
                  const Spacer(),
                  Text(ugx(o.fare), style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
                ],
              ),
              const SizedBox(height: 2),
              Text(
                v.seats > 1 ? '${v.label} · ${v.seats}' : v.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
              ),
              Text(
                eta == null ? 'None online yet' : '${count > 1 ? '$count online · ' : ''}$eta min away',
                style: t.bodySmall?.copyWith(fontSize: 11),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// After a destination is chosen: pick a vehicle, how to pay, and request.
  Widget _optionsSection(BuildContext context) {
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
      return Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            const SizedBox(height: 8),
            OutlinedButton(onPressed: _getEstimate, child: const Text('Try again')),
          ],
        ),
      );
    }
    final chosen = est.option(_vehicle);
    final chosenHere = _nearbyLoaded ? _nearby.any((d) => d.vehicleType == _vehicle) : (chosen?.nearbyCount ?? 0) > 0;
    final walletOk = chosen != null && est.walletAvailable >= chosen.fare;
    if (_payment == 'wallet' && !walletOk) _payment = 'cash';
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_kind == 'delivery') _deliveryForm(),
        const SizedBox(height: 4),
        Text(
          '${est.distanceKm} km · about ${est.durationMin} min${est.isEstimate ? ' · approximate distance' : ''}',
          style: t.bodyMedium,
        ),
        const SizedBox(height: 6),
        for (var i = 0; i < est.options.length; i += 2)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(child: _optionTile(est.options[i], t)),
                  const SizedBox(width: 8),
                  Expanded(child: i + 1 < est.options.length ? _optionTile(est.options[i + 1], t) : const SizedBox.shrink()),
                ],
              ),
            ),
          ),
        if (!chosenHere)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(
              'None of these are online near you yet. Request anyway: the first one to come online will see you.',
              style: t.bodySmall,
            ),
          ),
        Row(
          children: [
            ChoiceChip(
              visualDensity: VisualDensity.compact,
              avatar: const Icon(Icons.payments_outlined, size: 18),
              label: const Text('Cash'),
              selected: _payment == 'cash',
              onSelected: (_) => setState(() => _payment = 'cash'),
            ),
            const SizedBox(width: 8),
            ChoiceChip(
              visualDensity: VisualDensity.compact,
              avatar: const Icon(Icons.account_balance_wallet_outlined, size: 18),
              label: Text('Wallet · ${ugx(est.walletAvailable)}'),
              selected: _payment == 'wallet',
              onSelected: walletOk ? (_) => setState(() => _payment = 'wallet') : null,
            ),
            if (!walletOk && widget.onOpenWallet != null)
              TextButton(onPressed: widget.onOpenWallet, child: const Text('Add money')),
          ],
        ),
      ],
    );
  }

  /// The request button stays fixed at the bottom, so it never needs scrolling to.
  Widget? _requestFooter(BuildContext context) {
    final est = _estimate;
    if (_dropoff == null || est == null || _estimating) return null;
    final chosen = est.option(_vehicle);
    final chosenType = vehicleById(_vehicle);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _errorLine(context),
        const SizedBox(height: 6),
        FilledButton(
          onPressed: _requesting ? null : _request,
          child: _requesting
              ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : Text(
                  '${_kind == 'delivery' ? 'Send with' : 'Request'} ${chosenType.label}${chosen == null ? '' : ' · ${ugx(chosen.fare)}'}',
                ),
        ),
      ],
    );
  }

  // ---------- following a trip ----------

  Widget _tripPanel(BuildContext context, Trip t) {
    final th = Theme.of(context).textTheme;
    final c = t.captain;
    final v = vehicleById(t.vehicleType);
    final leg = _legKm;
    final title = switch (t.status) {
      'requested' => 'Finding your ${v.label.toLowerCase()}...',
      'accepted' => 'Your captain is on the way',
      'arrived' => 'Your captain has arrived',
      'in_progress' => t.isDelivery ? 'Your delivery is on its way' : 'On your trip',
      'no_captain' => 'No captain found',
      'cancelled' => 'Trip cancelled',
      _ => statusLabel(t.status),
    };
    final user = widget.session.user;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (user != null) StandingBanner(user.standing),
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 250),
          child: Text(title, key: ValueKey(title), style: th.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
        ),
        if (leg != null && t.status == 'accepted') ...[
          const SizedBox(height: 10),
          ArrivalBar(
            startKm: _legStartKm,
            nowKm: leg,
            title: '${distanceText(leg)} away · about ${etaMinutes(leg)} min',
          ),
        ],
        if (leg != null && t.status == 'in_progress') ...[
          const SizedBox(height: 10),
          ArrivalBar(
            startKm: _legStartKm,
            nowKm: leg,
            color: Colors.green,
            title: '${distanceText(leg)} to go · about ${etaMinutes(leg)} min',
          ),
        ],
        if (t.pickupPin != null) ...[
          const SizedBox(height: 10),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: brandPrimary.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: brandPrimary.withValues(alpha: 0.4)),
            ),
            child: Row(
              children: [
                const Icon(Icons.lock_outline, color: brandPrimary),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(t.isDelivery
                      ? 'Delivery code. Give it to the person receiving the item. The captain asks for it at the drop-off.'
                      : 'Your trip code. Tell it to the captain only when you are on board.'),
                ),
                Text(t.pickupPin!, style: th.headlineSmall?.copyWith(fontWeight: FontWeight.bold, letterSpacing: 4)),
              ],
            ),
          ),
        ],
        if (t.status == 'arrived') ...[
          const SizedBox(height: 10),
          Row(
            children: [
              const Pulse(size: 44, color: Colors.green, child: Icon(Icons.place, color: Colors.green)),
              const SizedBox(width: 8),
              Expanded(child: Text(t.isDelivery ? 'Hand over your item to the captain.' : 'Please head to your captain now.')),
            ],
          ),
        ],
        if (t.status == 'requested') ...[
          const SizedBox(height: 10),
          _SearchingCard(key: ValueKey(t.id), trip: t),
        ],
        if (t.status == 'no_captain')
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('No captain was available in the last few minutes. Please try again, or try another type of ride.'),
          ),
        if (t.isDelivery)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: brandSurface, borderRadius: BorderRadius.circular(12)),
              child: Row(
                children: [
                  const Icon(Icons.inventory_2_outlined, color: brandPrimary),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text('${t.deliveryItem ?? 'Item'}  →  ${t.receiverName ?? ''}', style: const TextStyle(fontWeight: FontWeight.w600)),
                  ),
                ],
              ),
            ),
          ),
        if (c != null) ...[
          const SizedBox(height: 12),
          InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: () => showCaptainDetails(context, _api, c, onMessage: () => _openChat(t)),
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(border: Border.all(color: Colors.black12), borderRadius: BorderRadius.circular(14)),
              child: Row(
                children: [
                  ProfileAvatar(api: _api, userId: c.id, name: c.name, photoVersion: c.photoVersion, radius: 24),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(c.name, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                        Row(children: [
                          const Icon(Icons.star, size: 16, color: brandAccent),
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
                      color: brandAccent,
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
        Text(
          '${ugx(t.fare)} · ${t.paymentMethod == 'wallet' ? 'wallet' : 'cash'} · ${t.distanceKm} km',
          style: th.bodyMedium,
        ),
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

/// "Looking for a captain": a spinner and a running time. The request stays open, so a captain
/// who comes online a few minutes later still sees it.
class _SearchingCard extends StatefulWidget {
  const _SearchingCard({super.key, required this.trip});

  final Trip trip;

  @override
  State<_SearchingCard> createState() => _SearchingCardState();
}

class _SearchingCardState extends State<_SearchingCard> {
  Timer? _timer;
  late DateTime _start;

  @override
  void initState() {
    super.initState();
    // Use the trip's own start when the clocks agree, otherwise start counting now.
    final age = DateTime.now().difference(widget.trip.createdAt).inSeconds;
    _start = DateTime.now().subtract(Duration(seconds: age >= 0 && age < 3600 ? age : 0));
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final elapsed = DateTime.now().difference(_start).inSeconds;
    final clock = '${elapsed ~/ 60}:${(elapsed % 60).toString().padLeft(2, '0')}';
    final message = elapsed < 20
        ? 'Looking for a captain...'
        : 'Still looking. As soon as a captain comes online, they will see your request.';
    return Row(
      children: [
        SizedBox(
          width: 64,
          height: 64,
          child: Stack(
            alignment: Alignment.center,
            children: [
              const SizedBox(width: 64, height: 64, child: CircularProgressIndicator(strokeWidth: 6, color: brandPrimary)),
              Text(clock, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: brandPrimary)),
            ],
          ),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 300),
            child: Text(message, key: ValueKey(message), style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          ),
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
          Text(widget.trip.isDelivery ? 'Delivery complete' : 'Trip complete',
              textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 10),
          AmountSummary(label: widget.trip.isDelivery ? 'Delivery amount' : 'Trip amount', amount: ugx(widget.trip.fare)),
          const SizedBox(height: 18),
          Text(name == null ? 'How was your ride?' : 'How was your ride with $name?', textAlign: TextAlign.center),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              for (var i = 1; i <= 5; i++)
                IconButton(
                  iconSize: 40,
                  onPressed: () => setState(() => _stars = i),
                  icon: Icon(i <= _stars ? Icons.star : Icons.star_border, color: brandAccent),
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
