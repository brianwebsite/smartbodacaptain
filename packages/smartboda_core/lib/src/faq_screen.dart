import 'package:flutter/material.dart';

import 'api.dart';
import 'theme.dart';

/// Ready-made answers. Type a few words and the matching questions stay on the list.
class FaqScreen extends StatefulWidget {
  const FaqScreen({super.key, required this.api, required this.isCaptain, required this.onContact});

  final ApiClient api;
  final bool isCaptain;

  /// Opens the Contact us page when the answers are not enough.
  final VoidCallback onContact;

  @override
  State<FaqScreen> createState() => _FaqScreenState();
}

class _FaqScreenState extends State<FaqScreen> {
  List<({String q, String a, String words})>? _all;
  String? _error;
  String _search = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await widget.api.get('/api/faq?audience=${widget.isCaptain ? 'captain' : 'passenger'}');
      final list = (r['faq'] as List<dynamic>)
          .map((e) => (q: e['q'] as String, a: e['a'] as String, words: (e['words'] as String?) ?? ''))
          .toList();
      if (mounted) setState(() => _all = list);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  bool _matches(({String q, String a, String words}) e) {
    final terms = _search.toLowerCase().split(RegExp(r'\s+')).where((t) => t.length > 1).toList();
    if (terms.isEmpty) return true;
    final hay = '${e.q} ${e.a} ${e.words}'.toLowerCase();
    return terms.every(hay.contains);
  }

  @override
  Widget build(BuildContext context) {
    final all = _all;
    final shown = all?.where(_matches).toList() ?? const <({String q, String a, String words})>[];
    return Scaffold(
      backgroundColor: brandSurface,
      appBar: AppBar(title: const Text('Help and FAQ')),
      body: all == null
          ? Center(child: _error != null ? Text(_error!) : const CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                TextField(
                  onChanged: (v) => setState(() => _search = v),
                  decoration: InputDecoration(
                    hintText: 'Type your question, for example "cancel" or "wallet"',
                    prefixIcon: const Icon(Icons.search),
                    filled: true,
                    fillColor: Colors.white,
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(16)),
                  ),
                ),
                const SizedBox(height: 14),
                for (final e in shown)
                  Container(
                    margin: const EdgeInsets.only(bottom: 10),
                    decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16), border: Border.all(color: Colors.black12)),
                    child: Theme(
                      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                      child: ExpansionTile(
                        key: PageStorageKey(e.q),
                        tilePadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
                        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                        expandedCrossAxisAlignment: CrossAxisAlignment.start,
                        title: Text(e.q, style: const TextStyle(fontWeight: FontWeight.w700)),
                        children: [Text(e.a, style: const TextStyle(height: 1.4))],
                      ),
                    ),
                  ),
                if (shown.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 24),
                    child: Center(child: Text('No answer matches. Try other words, or ask us.')),
                  ),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  onPressed: widget.onContact,
                  icon: const Icon(Icons.support_agent),
                  label: const Text('Still need help? Contact us'),
                ),
              ],
            ),
    );
  }
}
