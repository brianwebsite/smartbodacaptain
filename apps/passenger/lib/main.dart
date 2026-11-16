import 'package:flutter/material.dart';
import 'package:smartboda_core/smartboda_core.dart';

import 'home_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const PassengerApp());
}

class PassengerApp extends StatefulWidget {
  const PassengerApp({super.key});

  @override
  State<PassengerApp> createState() => _PassengerAppState();
}

class _PassengerAppState extends State<PassengerApp> {
  late final ApiClient _api = ApiClient();
  late final Session _session = Session(_api, role: 'passenger')..load();

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Smart Boda',
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
            return AuthScreen(session: _session, appTitle: 'Smart Boda');
          }
          return HomeScreen(session: _session);
        },
      ),
    );
  }
}
