import 'package:flutter/material.dart';
import 'package:smartboda_core/smartboda_core.dart';

import 'shell.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const CaptainApp());
}

class CaptainApp extends StatefulWidget {
  const CaptainApp({super.key});

  @override
  State<CaptainApp> createState() => _CaptainAppState();
}

class _CaptainAppState extends State<CaptainApp> {
  late final ApiClient _api = ApiClient();
  late final Session _session = Session(_api, role: 'captain')..load();

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Smart Boda Captain',
      debugShowCheckedModeBanner: false,
      theme: bodaTheme(),
      home: ListenableBuilder(
        listenable: _session,
        builder: (context, _) {
          if (_session.loading) {
            return const Scaffold(body: Center(child: CircularProgressIndicator()));
          }
          if (_session.loadError != null) {
            return Scaffold(
              body: Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(_session.loadError!, textAlign: TextAlign.center),
                      const SizedBox(height: 16),
                      FilledButton(onPressed: _session.load, child: const Text('Try again')),
                    ],
                  ),
                ),
              ),
            );
          }
          if (_session.user == null) {
            return AuthScreen(session: _session, appTitle: 'Smart Boda Captain');
          }
          return Shell(session: _session);
        },
      ),
    );
  }
}
