import 'package:flutter/material.dart';

/// A kind of ride a passenger can ask for and a captain can drive.
class VehicleType {
  const VehicleType(this.id, this.label, this.icon, this.blurb, this.color);

  final String id;
  final String label;
  final IconData icon;
  final String blurb;
  final Color color;
}

const List<VehicleType> vehicleTypes = [
  VehicleType('boda', 'Boda', Icons.two_wheeler, 'Quick through traffic', Color(0xFF0B7A4B)),
  VehicleType('electric_boda', 'Electric boda', Icons.electric_moped, 'Quiet and clean', Color(0xFF1E88E5)),
  VehicleType('car', 'Car', Icons.directions_car, 'Room for more people and bags', Color(0xFF6D4C41)),
];

VehicleType vehicleById(String id) =>
    vehicleTypes.firstWhere((v) => v.id == id, orElse: () => vehicleTypes.first);
