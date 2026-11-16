import 'package:flutter/material.dart';

const Color bodaGreen = Color(0xFF0B7A4B);
const Color bodaAmber = Color(0xFFF5A623);

/// The Smart Boda look: deep green, amber highlights, big touch targets.
ThemeData bodaTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: bodaGreen, brightness: Brightness.light);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: const Color(0xFFF4F7F5),
    appBarTheme: const AppBarTheme(
      backgroundColor: bodaGreen,
      foregroundColor: Colors.white,
      centerTitle: false,
    ),
    inputDecorationTheme: const InputDecorationTheme(
      border: OutlineInputBorder(),
      contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(52),
        textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
    ),
  );
}
