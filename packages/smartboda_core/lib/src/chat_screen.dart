import 'dart:async';

import 'package:flutter/material.dart';

import 'api.dart';
import 'models.dart';
import 'theme.dart';

/// Messages between the passenger and the captain of one trip.
class ChatScreen extends StatefulWidget {
  const ChatScreen({
    super.key,
    required this.api,
    required this.tripId,
    required this.title,
    this.quickReplies = const [],
  });

  final ApiClient api;
  final String tripId;
  final String title;
  final List<String> quickReplies;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  Timer? _poll;
  List<ChatMessage> _messages = [];
  bool _loaded = false;
  bool _sending = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
    _poll = Timer.periodic(const Duration(seconds: 3), (_) => _load());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await widget.api.get('/api/trips/${widget.tripId}/messages');
      final list = (r['messages'] as List<dynamic>)
          .map((m) => ChatMessage.fromJson(m as Map<String, dynamic>))
          .toList();
      if (!mounted) return;
      final grew = list.length != _messages.length;
      setState(() {
        _messages = list;
        _loaded = true;
      });
      if (grew) _toBottom();
    } on ApiException catch (e) {
      if (mounted && !_loaded) setState(() => _error = e.message);
    }
  }

  void _toBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  Future<void> _send(String raw) async {
    final body = raw.trim();
    if (body.isEmpty || _sending) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      final r = await widget.api.post('/api/trips/${widget.tripId}/messages', {'body': body});
      final m = ChatMessage.fromJson(r['message'] as Map<String, dynamic>);
      if (mounted) {
        setState(() => _messages = [..._messages, m]);
        _input.clear();
        _toBottom();
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: Column(
        children: [
          Expanded(
            child: !_loaded
                ? Center(child: _error != null ? Text(_error!) : const CircularProgressIndicator())
                : _messages.isEmpty
                    ? const Center(
                        child: Padding(
                          padding: EdgeInsets.all(32),
                          child: Text('No messages yet. Say hello, or tap a quick reply below.', textAlign: TextAlign.center),
                        ),
                      )
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.all(12),
                        itemCount: _messages.length,
                        itemBuilder: (_, i) {
                          final m = _messages[i];
                          return Align(
                            alignment: m.mine ? Alignment.centerRight : Alignment.centerLeft,
                            child: Container(
                              margin: const EdgeInsets.symmetric(vertical: 3),
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                              constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
                              decoration: BoxDecoration(
                                color: m.mine ? bodaGreen : Colors.white,
                                borderRadius: BorderRadius.circular(16),
                                border: m.mine ? null : Border.all(color: Colors.black12),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  Text(m.body, style: TextStyle(color: m.mine ? Colors.white : Colors.black87, fontSize: 16)),
                                  const SizedBox(height: 2),
                                  Text(
                                    _clock(m.createdAt),
                                    style: TextStyle(fontSize: 11, color: m.mine ? Colors.white70 : Colors.black45),
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
          ),
          if (_error != null && _loaded)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
              child: Text(_error!, style: TextStyle(color: scheme.error)),
            ),
          if (widget.quickReplies.isNotEmpty)
            SizedBox(
              height: 46,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                children: [
                  for (final q in widget.quickReplies)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ActionChip(label: Text(q), onPressed: _sending ? null : () => _send(q)),
                    ),
                ],
              ),
            ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      textCapitalization: TextCapitalization.sentences,
                      minLines: 1,
                      maxLines: 4,
                      maxLength: 500,
                      decoration: const InputDecoration(hintText: 'Type a message', counterText: ''),
                      onSubmitted: _send,
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: _sending ? null : () => _send(_input.text),
                    icon: const Icon(Icons.send),
                    tooltip: 'Send',
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _clock(DateTime t) {
    final l = t.toLocal();
    return '${l.hour.toString().padLeft(2, '0')}:${l.minute.toString().padLeft(2, '0')}';
  }
}
