class Place {
  const Place({required this.lat, required this.lng, this.label});

  final double lat;
  final double lng;
  final String? label;

  factory Place.fromJson(Map<String, dynamic> j) => Place(
        lat: (j['lat'] as num).toDouble(),
        lng: (j['lng'] as num).toDouble(),
        label: j['label'] as String?,
      );

  String get text => (label != null && label!.isNotEmpty)
      ? label!
      : '${lat.toStringAsFixed(4)}, ${lng.toStringAsFixed(4)}';
}

class AppUser {
  const AppUser({
    required this.id,
    required this.role,
    required this.name,
    required this.phone,
    required this.status,
    this.email,
    this.bikePlate,
    this.bikeModel,
    this.vehicleType = 'boda',
    this.online = false,
  });

  final String id;
  final String role;
  final String name;
  final String phone;
  final String? email;
  final String status;
  final String? bikePlate;
  final String? bikeModel;
  final String vehicleType;
  final bool online;

  factory AppUser.fromJson(Map<String, dynamic> j) {
    final cap = j['captain'] as Map<String, dynamic>?;
    return AppUser(
      id: j['id'] as String,
      role: j['role'] as String,
      name: j['name'] as String,
      phone: j['phone'] as String,
      email: j['email'] as String?,
      status: j['status'] as String,
      bikePlate: cap?['bikePlate'] as String?,
      bikeModel: cap?['bikeModel'] as String?,
      vehicleType: (cap?['vehicleType'] as String?) ?? 'boda',
      online: (cap?['online'] as bool?) ?? false,
    );
  }
}

class CaptainInfo {
  const CaptainInfo({
    required this.id,
    required this.name,
    required this.phone,
    required this.bikePlate,
    this.bikeModel,
    this.vehicleType = 'boda',
    this.stageName,
    this.rating,
    this.ratingCount = 0,
    this.completedTrips = 0,
    this.memberSince,
    this.lat,
    this.lng,
  });

  final String id;
  final String name;
  final String phone;
  final String bikePlate;
  final String? bikeModel;
  final String vehicleType;
  final String? stageName;
  final double? rating;
  final int ratingCount;
  final int completedTrips;
  final DateTime? memberSince;
  final double? lat;
  final double? lng;

  factory CaptainInfo.fromJson(Map<String, dynamic> j) {
    final loc = j['location'] as Map<String, dynamic>?;
    final since = j['memberSince'] as String?;
    return CaptainInfo(
      id: j['id'] as String,
      name: j['name'] as String,
      phone: j['phone'] as String,
      bikePlate: j['bikePlate'] as String,
      bikeModel: j['bikeModel'] as String?,
      vehicleType: (j['vehicleType'] as String?) ?? 'boda',
      stageName: j['stageName'] as String?,
      rating: (j['rating'] as num?)?.toDouble(),
      ratingCount: (j['ratingCount'] as num?)?.toInt() ?? 0,
      completedTrips: (j['completedTrips'] as num?)?.toInt() ?? 0,
      memberSince: since == null ? null : DateTime.tryParse(since),
      lat: (loc?['lat'] as num?)?.toDouble(),
      lng: (loc?['lng'] as num?)?.toDouble(),
    );
  }
}

class PassengerInfo {
  const PassengerInfo({required this.name, required this.phone});

  final String name;
  final String phone;

  factory PassengerInfo.fromJson(Map<String, dynamic> j) =>
      PassengerInfo(name: j['name'] as String, phone: j['phone'] as String);
}

class Trip {
  const Trip({
    required this.id,
    required this.status,
    required this.pickup,
    required this.dropoff,
    required this.distanceKm,
    required this.durationMin,
    required this.fare,
    required this.routeSource,
    required this.paymentMethod,
    required this.createdAt,
    this.vehicleType = 'boda',
    this.cancelReason,
    this.cancelledBy,
    this.unread = 0,
    this.captain,
    this.passenger,
    this.commission,
    this.captainEarnings,
    this.rating,
  });

  final String id;
  final String status;
  final Place pickup;
  final Place dropoff;
  final double distanceKm;
  final int durationMin;
  final int fare;
  final String routeSource;
  final String paymentMethod;
  final DateTime createdAt;
  final String vehicleType;
  final String? cancelReason;
  final String? cancelledBy;
  final int unread;
  final CaptainInfo? captain;
  final PassengerInfo? passenger;
  final int? commission;
  final int? captainEarnings;
  final int? rating;

  bool get isFinal => status == 'completed' || status == 'cancelled' || status == 'no_captain';

  factory Trip.fromJson(Map<String, dynamic> j) => Trip(
        id: j['id'] as String,
        status: j['status'] as String,
        pickup: Place.fromJson(j['pickup'] as Map<String, dynamic>),
        dropoff: Place.fromJson(j['dropoff'] as Map<String, dynamic>),
        distanceKm: (j['distanceKm'] as num).toDouble(),
        durationMin: (j['durationMin'] as num).toInt(),
        fare: (j['fare'] as num).toInt(),
        routeSource: j['routeSource'] as String,
        paymentMethod: j['paymentMethod'] as String,
        createdAt: DateTime.parse(j['createdAt'] as String),
        vehicleType: (j['vehicleType'] as String?) ?? 'boda',
        cancelReason: j['cancelReason'] as String?,
        cancelledBy: j['cancelledBy'] as String?,
        unread: (j['unread'] as num?)?.toInt() ?? 0,
        captain: j['captain'] == null
            ? null
            : CaptainInfo.fromJson(j['captain'] as Map<String, dynamic>),
        passenger: j['passenger'] == null
            ? null
            : PassengerInfo.fromJson(j['passenger'] as Map<String, dynamic>),
        commission: (j['commission'] as num?)?.toInt(),
        captainEarnings: (j['captainEarnings'] as num?)?.toInt(),
        rating: (j['rating'] as num?)?.toInt(),
      );
}

class FareOption {
  const FareOption({required this.vehicleType, required this.fare, required this.nearbyCount, this.etaMin});

  final String vehicleType;
  final int fare;
  final int nearbyCount;

  /// Minutes until the nearest free captain of this type could arrive, if any.
  final int? etaMin;

  factory FareOption.fromJson(Map<String, dynamic> j) => FareOption(
        vehicleType: j['vehicleType'] as String,
        fare: (j['fare'] as num).toInt(),
        nearbyCount: (j['nearbyCount'] as num).toInt(),
        etaMin: (j['etaMin'] as num?)?.toInt(),
      );
}

class FareEstimate {
  const FareEstimate({
    required this.distanceKm,
    required this.durationMin,
    required this.source,
    required this.options,
  });

  final double distanceKm;
  final int durationMin;
  final String source;
  final List<FareOption> options;

  bool get isEstimate => source == 'estimate';

  FareOption? option(String vehicleType) {
    for (final o in options) {
      if (o.vehicleType == vehicleType) return o;
    }
    return null;
  }

  factory FareEstimate.fromJson(Map<String, dynamic> j) => FareEstimate(
        distanceKm: (j['distanceKm'] as num).toDouble(),
        durationMin: (j['durationMin'] as num).toInt(),
        source: j['source'] as String,
        options: (j['options'] as List<dynamic>)
            .map((o) => FareOption.fromJson(o as Map<String, dynamic>))
            .toList(),
      );
}

class NearbyDriver {
  const NearbyDriver({
    required this.id,
    required this.vehicleType,
    required this.lat,
    required this.lng,
    required this.etaMin,
  });

  final String id;
  final String vehicleType;
  final double lat;
  final double lng;
  final int etaMin;

  factory NearbyDriver.fromJson(Map<String, dynamic> j) => NearbyDriver(
        id: j['id'] as String,
        vehicleType: j['vehicleType'] as String,
        lat: (j['lat'] as num).toDouble(),
        lng: (j['lng'] as num).toDouble(),
        etaMin: (j['etaMin'] as num).toInt(),
      );
}

/// A search result for a destination.
class PlaceSuggestion {
  const PlaceSuggestion({required this.label, required this.title, required this.subtitle, required this.lat, required this.lng});

  final String label;
  final String title;
  final String subtitle;
  final double lat;
  final double lng;

  Place toPlace() => Place(lat: lat, lng: lng, label: label);

  factory PlaceSuggestion.fromJson(Map<String, dynamic> j) => PlaceSuggestion(
        label: j['label'] as String,
        title: j['title'] as String,
        subtitle: (j['subtitle'] as String?) ?? '',
        lat: (j['lat'] as num).toDouble(),
        lng: (j['lng'] as num).toDouble(),
      );
}

class ChatMessage {
  const ChatMessage({required this.id, required this.mine, required this.body, required this.createdAt});

  final String id;
  final bool mine;
  final String body;
  final DateTime createdAt;

  factory ChatMessage.fromJson(Map<String, dynamic> j) => ChatMessage(
        id: j['id'] as String,
        mine: j['mine'] as bool,
        body: j['body'] as String,
        createdAt: DateTime.parse(j['createdAt'] as String),
      );
}

class Offer {
  const Offer({required this.trip, required this.distanceToPickupKm, required this.expiresAt});

  final Trip trip;
  final double distanceToPickupKm;
  final DateTime expiresAt;

  factory Offer.fromJson(Map<String, dynamic> j) => Offer(
        trip: Trip.fromJson(j['trip'] as Map<String, dynamic>),
        distanceToPickupKm: (j['distanceToPickupKm'] as num).toDouble(),
        expiresAt: DateTime.parse(j['expiresAt'] as String),
      );
}

class DayEarning {
  const DayEarning({required this.day, required this.trips, required this.gross, required this.net});

  final String day;
  final int trips;
  final int gross;
  final int net;

  factory DayEarning.fromJson(Map<String, dynamic> j) => DayEarning(
        day: j['day'] as String,
        trips: (j['trips'] as num).toInt(),
        gross: (j['gross'] as num).toInt(),
        net: (j['net'] as num).toInt(),
      );
}

class Earnings {
  const Earnings({
    required this.days,
    required this.trips,
    required this.gross,
    required this.commission,
    required this.net,
    required this.commissionOwed,
    required this.byDay,
  });

  final int days;
  final int trips;
  final int gross;
  final int commission;
  final int net;
  final int commissionOwed;
  final List<DayEarning> byDay;

  factory Earnings.fromJson(Map<String, dynamic> j) {
    final t = j['totals'] as Map<String, dynamic>;
    return Earnings(
      days: (j['days'] as num).toInt(),
      trips: (t['trips'] as num).toInt(),
      gross: (t['gross'] as num).toInt(),
      commission: (t['commission'] as num).toInt(),
      net: (t['net'] as num).toInt(),
      commissionOwed: (j['commissionOwed'] as num).toInt(),
      byDay: (j['byDay'] as List<dynamic>)
          .map((d) => DayEarning.fromJson(d as Map<String, dynamic>))
          .toList(),
    );
  }
}
