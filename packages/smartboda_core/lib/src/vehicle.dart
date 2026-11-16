import 'package:flutter/material.dart';

/// A kind of ride a passenger can ask for and a captain can drive.
class VehicleType {
  const VehicleType(this.id, this.label, this.icon, this.blurb, this.color, {this.seats = 1});

  final String id;
  final String label;
  final IconData icon;
  final String blurb;
  final Color color;

  /// Passenger seats.
  final int seats;
}

const List<VehicleType> vehicleTypes = [
  VehicleType('boda', 'Boda', Icons.two_wheeler, 'Quick through traffic', Color(0xFF4B1FA8)),
  VehicleType('electric_boda', 'Electric boda', Icons.electric_moped, 'Quiet and clean', Color(0xFF00897B)),
  VehicleType('car', 'Car', Icons.directions_car, 'Up to 3 people', Color(0xFFFF8A00), seats: 3),
  VehicleType('car_xl', 'Car XL', Icons.airport_shuttle, 'Up to 6 people', Color(0xFFD81B60), seats: 6),
];

VehicleType vehicleById(String id) =>
    vehicleTypes.firstWhere((v) => v.id == id, orElse: () => vehicleTypes.first);
