import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// Where the apps find the server. Set at build time:
///   flutter build apk --dart-define=API_BASE_URL=https://api.example.com
/// The default is the address an Android emulator uses to reach the computer
/// it runs on.
const String apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://10.0.2.2:8080',
);

class ApiException implements Exception {
  const ApiException(this.message, {this.status = 0, this.code});

  final String message;
  final int status;
  final String? code;

  @override
  String toString() => message;
}

class ApiClient {
  ApiClient([String? baseUrl]) : baseUrl = baseUrl ?? apiBaseUrl;

  final String baseUrl;
  String? token;

  /// Called when the server says the saved sign-in is no longer valid.
  void Function()? onUnauthorized;

  final http.Client _http = http.Client();

  Future<Map<String, dynamic>> get(String path) => _send('GET', path, null);

  Future<Map<String, dynamic>> post(String path, [Map<String, dynamic>? body]) =>
      _send('POST', path, body ?? <String, dynamic>{});

  Future<Map<String, dynamic>> _send(String method, String path, Map<String, dynamic>? body) async {
    final uri = Uri.parse('$baseUrl$path');
    final headers = <String, String>{
      'Content-Type': 'application/json',
      if (token != null) 'Authorization': 'Bearer $token',
    };

    http.Response res;
    try {
      final Future<http.Response> request = method == 'GET'
          ? _http.get(uri, headers: headers)
          : _http.post(uri, headers: headers, body: jsonEncode(body));
      res = await request.timeout(const Duration(seconds: 20));
    } on TimeoutException {
      throw const ApiException('The server took too long to answer. Check your internet.', code: 'timeout');
    } catch (_) {
      throw const ApiException('Cannot reach Smart Boda. Check your internet connection.', code: 'network');
    }

    Map<String, dynamic> data = <String, dynamic>{};
    if (res.bodyBytes.isNotEmpty) {
      try {
        final decoded = jsonDecode(utf8.decode(res.bodyBytes));
        if (decoded is Map<String, dynamic>) data = decoded;
      } catch (_) {
        // A reply that is not JSON is treated like an empty one.
      }
    }

    if (res.statusCode == 401 && token != null) {
      onUnauthorized?.call();
    }
    if (res.statusCode >= 400) {
      throw ApiException(
        (data['error'] as String?) ?? 'Something went wrong. Please try again.',
        status: res.statusCode,
        code: data['code'] as String?,
      );
    }
    return data;
  }
}
