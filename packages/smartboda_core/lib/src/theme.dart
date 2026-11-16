import 'package:flutter/material.dart';

/// Smart Boda's own colours: royal violet with a sunrise-orange accent.
const Color brandPrimary = Color(0xFF4B1FA8);
const Color brandDark = Color(0xFF33147A);
const Color brandAccent = Color(0xFFFF8A00);
const Color brandSurface = Color(0xFFF7F4FC);

/// The Smart Boda look: violet, orange highlights, rounded shapes, big touch targets.
ThemeData bodaTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: brandPrimary,
    primary: brandPrimary,
    secondary: brandAccent,
    brightness: Brightness.light,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: brandSurface,
    appBarTheme: const AppBarTheme(
      backgroundColor: brandPrimary,
      foregroundColor: Colors.white,
      centerTitle: false,
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: Colors.white,
      indicatorColor: brandPrimary.withValues(alpha: 0.14),
      labelTextStyle: WidgetStateProperty.all(const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
    ),
    inputDecorationTheme: const InputDecorationTheme(
      border: OutlineInputBorder(),
      contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
    ),
  );
}
