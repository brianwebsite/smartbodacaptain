import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import 'api.dart';
import 'theme.dart';

/// A round picture of a person, or their first letter when they have not added one.
class ProfileAvatar extends StatelessWidget {
  const ProfileAvatar({
    super.key,
    required this.api,
    required this.userId,
    required this.name,
    required this.photoVersion,
    this.radius = 24,
  });

  final ApiClient api;
  final String userId;
  final String name;

  /// 0 means no picture. It changes when a new picture is added, so the app fetches it again.
  final int photoVersion;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final letter = Text(
      name.trim().isEmpty ? '?' : name.trim()[0].toUpperCase(),
      style: TextStyle(color: Colors.white, fontSize: radius * 0.9, fontWeight: FontWeight.bold),
    );
    if (photoVersion <= 0) {
      return CircleAvatar(radius: radius, backgroundColor: brandPrimary, child: letter);
    }
    return CircleAvatar(
      radius: radius,
      backgroundColor: brandPrimary,
      child: ClipOval(
        child: Image.network(
          '${api.baseUrl}/api/photos/$userId?v=$photoVersion',
          headers: {'Authorization': 'Bearer ${api.token ?? ''}'},
          width: radius * 2,
          height: radius * 2,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => Center(child: letter),
        ),
      ),
    );
  }
}

/// Lets the person choose a picture from their phone and saves it. Returns true when it was saved.
Future<bool> pickAndUploadPhoto(BuildContext context, ApiClient api) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final file = await ImagePicker().pickImage(
      source: ImageSource.gallery,
      maxWidth: 320,
      maxHeight: 320,
      imageQuality: 50,
    );
    if (file == null) return false;
    final bytes = await file.readAsBytes();
    await api.put('/api/me/photo', {'image': base64Encode(bytes)});
    messenger.showSnackBar(const SnackBar(content: Text('Your picture is saved')));
    return true;
  } on ApiException catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(e.message)));
  } catch (_) {
    messenger.showSnackBar(const SnackBar(content: Text('Could not open your pictures')));
  }
  return false;
}
