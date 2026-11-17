import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

import 'api.dart';

/// Push notifications through Firebase (free). They only turn on when the app was built with the
/// project's Firebase details; otherwise everything here quietly does nothing.
class PushService {
  static const _apiKey = String.fromEnvironment('FIREBASE_API_KEY');
  static const _appId = String.fromEnvironment('FIREBASE_APP_ID');
  static const _projectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
  static const _senderId = String.fromEnvironment('FIREBASE_SENDER_ID');

  static bool get configured => _apiKey.isNotEmpty && _appId.isNotEmpty && _projectId.isNotEmpty && _senderId.isNotEmpty;

  /// This phone's token, once we have it. Used to stop notifications when the person signs out.
  static String? token;
  static bool _listening = false;

  /// What happened last, in words the person can act on: 'on', 'blocked', or the problem.
  static String status = 'Not checked yet';

  static bool get isOn => status == 'on';

  /// Asks permission, gets this phone's token, and tells the server. Safe to call again.
  static Future<String> start(ApiClient api) async {
    if (!configured) {
      return status = 'This copy of the app was built without notifications. Install the newest version.';
    }
    try {
      if (Firebase.apps.isEmpty) {
        await Firebase.initializeApp(
          options: const FirebaseOptions(apiKey: _apiKey, appId: _appId, messagingSenderId: _senderId, projectId: _projectId),
        );
      }
      final messaging = FirebaseMessaging.instance;
      final settings = await messaging.requestPermission().timeout(const Duration(seconds: 90));
      final allowed = settings.authorizationStatus == AuthorizationStatus.authorized ||
          settings.authorizationStatus == AuthorizationStatus.provisional;
      token = await messaging.getToken();
      final t = token;
      if (t != null) await api.put('/api/me/push-token', {'token': t});
      status = t == null
          ? 'This phone did not give us a notification address. Check the internet and try again.'
          : (allowed ? 'on' : 'blocked');
      if (!_listening) {
        _listening = true;
        messaging.onTokenRefresh.listen((fresh) {
          token = fresh;
          api.put('/api/me/push-token', {'token': fresh}).catchError((_) => <String, dynamic>{});
        });
      }
    } catch (e) {
      // No push is better than a broken app, but say what went wrong so it can be fixed.
      final text = e.toString();
      status = 'Could not turn on notifications: ${text.length > 160 ? text.substring(0, 160) : text}';
    }
    return status;
  }
}
