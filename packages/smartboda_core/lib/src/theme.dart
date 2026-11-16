import 'package:flutter/material.dart';

/// Smart Boda's own colours: bold hot pink and white. The gold accent is only for rating stars.
const Color brandPrimary = Color(0xFFFF1493);
const Color brandDark = Color(0xFFC4006A);
const Color brandAccent = Color(0xFFFFB300);
const Color brandSurface = Color(0xFFFFF5FA);

/// The Smart Boda look: bold hot pink and white, rounded shapes, big touch targets.
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
      titleTextStyle: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: Colors.white),
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
        textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        side: const BorderSide(color: brandPrimary, width: 1.5),
        textStyle: const TextStyle(fontWeight: FontWeight.w700),
      ),
    ),
  );
}
