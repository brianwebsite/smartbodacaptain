import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'models.dart';

/// Who is signed in. Keeps the sign-in token on the phone between launches.
class Session extends ChangeNotifier {
  Session(this.api, {required this.role}) {
    api.onUnauthorized = _signedOutByServer;
  }

  final ApiClient api;

  /// 'passenger' or 'captain'. An app only accepts accounts of its own kind.
  final String role;

  AppUser? user;
  bool loading = true;

  /// Set when the saved sign-in could not be checked because the network failed.
  String? loadError;

  static const _tokenKey = 'smartboda_token';

  Future<void> load() async {
    loading = true;
    loadError = null;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString(_tokenKey);
    if (saved != null) {
      api.token = saved;
      try {
        final r = await api.get('/api/me');
        final u = AppUser.fromJson(r['user'] as Map<String, dynamic>);
        if (u.role == role) {
          user = u;
        } else {
          await _clear();
        }
      } on ApiException catch (e) {
        if (e.status == 401) {
          await _clear();
        } else {
          loadError = e.message;
        }
      }
    }
    loading = false;
    notifyListeners();
  }

  Future<void> login(String phone, String password) async {
    final r = await api.post('/api/auth/login', {'phone': phone, 'password': password});
    await _accept(r);
  }

  Future<void> register(Map<String, dynamic> fields) async {
    final r = await api.post('/api/auth/register', {...fields, 'role': role});
    await _accept(r);
  }

  Future<void> _accept(Map<String, dynamic> r) async {
    final u = AppUser.fromJson(r['user'] as Map<String, dynamic>);
    final token = r['token'] as String;
    if (u.role != role) {
      api.token = token;
      try {
        await api.post('/api/auth/logout');
      } catch (_) {}
      api.token = null;
      throw ApiException(role == 'passenger'
          ? 'This account is a captain account. Use the Smart Boda Captain app.'
          : 'This account is a passenger account. Use the Smart Boda app.');
    }
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token);
    api.token = token;
    user = u;
    notifyListeners();
  }

  /// Fetch the latest details of the signed-in user, such as captain approval.
  Future<void> refreshUser() async {
    final r = await api.get('/api/me');
    user = AppUser.fromJson(r['user'] as Map<String, dynamic>);
    notifyListeners();
  }

  Future<void> logout() async {
    try {
      await api.post('/api/auth/logout');
    } catch (_) {
      // Signing out on the phone matters more than telling the server.
    }
    await _clear();
    notifyListeners();
  }

  void _signedOutByServer() {
    if (user == null && api.token == null) return;
    _clear().then((_) => notifyListeners());
  }

  Future<void> _clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
    api.token = null;
    user = null;
  }
}
