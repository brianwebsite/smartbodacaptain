import 'dart:async';

import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';
import 'package:smartboda_core/smartboda_core.dart';

import 'map_picker_screen.dart';

/// Type a place name and pick from suggestions. Pops with the chosen [Place].
class SearchScreen extends StatefulWidget {
  const SearchScreen({
    super.key,
    required this.api,
    required this.title,
    this.near,
    this.here,
  });

  final ApiClient api;
  final String title;

  /// Results are ranked closer to here.
  final LatLng? near;

  /// The phone's current place, offered as "Use my current location".
  final Place? here;

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final _text = TextEditingController();
  Timer? _debounce;
  List<PlaceSuggestion> _results = [];
  bool _loading = false;
  String? _error;
  String _latest = '';

  @override
  void dispose() {
    _debounce?.cancel();
    _text.dispose();
    super.dispose();
  }

  void _changed(String value) {
    _debounce?.cancel();
    final q = value.trim();
    setState(() {
      _error = null;
      if (q.length < 2) {
        _results = [];
        _loading = false;
      }
    });
    if (q.length < 2) return;
    _debounce = Timer(const Duration(milliseconds: 200), () => _search(q));
  }

  Future<void> _search(String q) async {
    _latest = q;
    setState(() => _loading = true);
    final near = widget.near;
    final path = '/api/places/search?q=${Uri.encodeQueryComponent(q)}'
        '${near == null ? '' : '&lat=${near.latitude}&lng=${near.longitude}'}';
    try {
      final r = await widget.api.get(path);
      if (!mounted || _latest != q) return;
      setState(() {
        _results = (r['places'] as List<dynamic>)
            .map((p) => PlaceSuggestion.fromJson(p as Map<String, dynamic>))
            .toList();
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted || _latest != q) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  Future<void> _chooseOnMap() async {
    final picked = await Navigator.of(context).push<Place>(
      MaterialPageRoute(
        builder: (_) => MapPickerScreen(
          api: widget.api,
          title: widget.title,
          start: widget.near ?? kampalaCentre,
        ),
      ),
    );
    if (picked != null && mounted) Navigator.of(context).pop(picked);
  }

  @override
  Widget build(BuildContext context) {
    final q = _text.text.trim();
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: TextField(
              controller: _text,
              autofocus: true,
              textInputAction: TextInputAction.search,
              onChanged: _changed,
              decoration: InputDecoration(
                hintText: 'Search a place, area or landmark',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: q.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.close),
                        onPressed: () {
                          _text.clear();
                          _changed('');
                        },
                      ),
              ),
            ),
          ),
          if (_loading) const LinearProgressIndicator(minHeight: 2),
          Expanded(
            child: ListView(
              children: [
                if (widget.here != null)
                  ListTile(
                    leading: const Icon(Icons.my_location, color: Color(0xFF1A73E8)),
                    title: const Text('Use my current location'),
                    onTap: () => Navigator.of(context).pop(widget.here),
                  ),
                ListTile(
                  leading: const Icon(Icons.pin_drop_outlined),
                  title: const Text('Choose on the map'),
                  onTap: _chooseOnMap,
                ),
                const Divider(height: 1),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                  ),
                for (final p in _results)
                  ListTile(
                    leading: const Icon(Icons.place_outlined),
                    title: Text(p.title),
                    subtitle: p.subtitle.isEmpty ? null : Text(p.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis),
                    onTap: () => Navigator.of(context).pop(p.toPlace()),
                  ),
                if (!_loading && _error == null && q.length >= 2 && _results.isEmpty)
                  const Padding(
                    padding: EdgeInsets.all(24),
                    child: Text(
                      'No places found. Try another spelling, or choose the spot on the map.',
                      textAlign: TextAlign.center,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
