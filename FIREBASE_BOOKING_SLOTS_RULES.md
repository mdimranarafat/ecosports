# EcoSports Firebase Booking Slots Rules

Firebase Console-এ **Firestore Database → Rules** খুলে `match /databases/{database}/documents { ... }`-এর ভিতরে, `match /bookings/{bookingId}` ব্লকের আগে এই block যোগ করুন:

```firestore
// Public availability index. This collection intentionally contains only
// booking display data; phone, email, price, notes, and payment data remain
// private in the bookings collection.
match /bookingSlots/{slotId} {
  allow read: if true;

  allow create: if isValidPublicSlot() || hasPerm('bookings.create');

  allow update, delete: if hasPerm('bookings.edit') || isSuperAdmin();

  function isValidPublicSlot() {
    let d = request.resource.data;
    return d.status == 'active'
      && d.bookingId is string
      && d.facilityId is string
      && d.date is string
      && d.startMinutes is int
      && d.endMinutes is int
      && d.customerName is string
      && d.customerName.size() > 0;
  }
}
```

এরপর **Publish** চাপুন। এই rule customer-কে শুধু facility, date, time, status, এবং customer name পড়তে দেয়; customer phone/email/payment/notes প্রকাশ করে না।

## Required Firestore index

Firestore সাধারণত প্রথম query-এর সময় index link দেখাবে। Link-এ click করে index create করুন। অথবা `firestore.indexes.json`-এ এই index রাখুন:

```json
{
  "collectionGroup": "bookingSlots",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "facilityId", "order": "ASCENDING" },
    { "fieldPath": "date", "order": "ASCENDING" },
    { "fieldPath": "status", "order": "ASCENDING" }
  ]
}
```

Rules publish করার পর live booking page refresh করুন:

https://mdimranarafat.github.io/ecosports/booking.html?v=4289bc8

## Important

এই rules publish না হওয়া পর্যন্ত public availability query `permission-denied` দেখাবে এবং booking flow সঠিকভাবে কাজ করবে না। Source code-এ booking slots-এর conflict-safe transaction এবং public slot index write ইতিমধ্যে প্রস্তুত আছে।
