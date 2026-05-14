import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getAnalytics, isSupported as analyticsIsSupported } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-analytics.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  setDoc,
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAb2rzSQUohyDNE-Q2uhNucDKxiYDmkGOs",
  authDomain: "interview-booking-64178.firebaseapp.com",
  projectId: "interview-booking-64178",
  storageBucket: "interview-booking-64178.firebasestorage.app",
  messagingSenderId: "695274189930",
  appId: "1:695274189930:web:0c8ea7a61fb16262d80613",
  measurementId: "G-F0E2Y28699",
};

const COLLECTIONS = {
  slots: "slots",
  bookingCounts: "bookingCounts",
  bookings: "bookings",
  students: "students",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

analyticsIsSupported()
  .then(function (supported) {
    if (supported) getAnalytics(app);
  })
  .catch(function () {});

function countDocId(key) {
  return encodeURIComponent(String(key));
}

function bookingDocId(rec, index) {
  if (rec && rec.id) return String(rec.id);
  return encodeURIComponent(
    [
      (rec && rec.sectionId) || "",
      (rec && rec.startTime) || "",
      (rec && (rec.emailNorm || rec.email)) || "",
      (rec && rec.phone) || "",
      (rec && rec.date) || "",
      (rec && rec.createdAt) || "",
      index,
    ].join("\t")
  );
}

function studentDocId(student, index) {
  if (student && student.emailNorm) return encodeURIComponent(String(student.emailNorm));
  if (student && student.email) return encodeURIComponent(String(student.email).trim().toLowerCase());
  if (student && student.id) return String(student.id);
  return "student-" + index;
}

function splitBookingKey(key) {
  var parts = String(key).split("\t");
  return { sectionId: parts[0] || "", startTime: parts[1] || "" };
}

function stripPrivateFields(obj) {
  var out = {};
  Object.keys(obj || {}).forEach(function (key) {
    if (key.indexOf("__") !== 0) out[key] = obj[key];
  });
  return out;
}

async function replaceCollection(collectionName, desiredDocs) {
  var col = collection(db, collectionName);
  var existing = await getDocs(col);
  var desiredIds = {};

  await Promise.all(
    desiredDocs.map(function (entry) {
      desiredIds[entry.id] = true;
      return setDoc(doc(db, collectionName, entry.id), entry.data);
    })
  );

  await Promise.all(
    existing.docs
      .filter(function (snap) {
        return !desiredIds[snap.id];
      })
      .map(function (snap) {
        return deleteDoc(doc(db, collectionName, snap.id));
      })
  );
}

export async function fetchCloudSlots() {
  var snap = await getDocs(collection(db, COLLECTIONS.slots));
  return snap.docs
    .map(function (d) {
      return d.data();
    })
    .sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
}

export async function fetchCloudBookingCounts() {
  var snap = await getDocs(collection(db, COLLECTIONS.bookingCounts));
  var out = {};
  snap.docs.forEach(function (d) {
    var data = d.data();
    if (data && data.key && typeof data.count === "number" && data.count > 0) out[data.key] = data.count;
  });
  return out;
}

export async function fetchCloudBookings() {
  var snap = await getDocs(collection(db, COLLECTIONS.bookings));
  return snap.docs
    .map(function (d) {
      return d.data();
    })
    .sort(function (a, b) {
      return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    });
}

export async function fetchCloudStudents() {
  var snap = await getDocs(collection(db, COLLECTIONS.students));
  return snap.docs
    .map(function (d) {
      return d.data();
    })
    .sort(function (a, b) {
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
}

export async function loadCloudState() {
  var result = await Promise.all([fetchCloudSlots(), fetchCloudBookingCounts(), fetchCloudBookings()]);
  return { slots: result[0], bookingCounts: result[1], bookings: result[2] };
}

export async function fetchAdminCredentials() {
  var snap = await getDoc(doc(db, "authentication", "admin"));
  return snap.exists() ? snap.data() : null;
}

export function subscribeCloudState(onChange) {
  var unsubs = [
    onSnapshot(collection(db, COLLECTIONS.slots), function (snap) {
      var slots = snap.docs
        .map(function (d) {
          return d.data();
        })
        .sort(function (a, b) {
          if (a.date !== b.date) return a.date < b.date ? -1 : 1;
          return String(a.id).localeCompare(String(b.id));
        });
      onChange({ slots: slots });
    }),
    onSnapshot(collection(db, COLLECTIONS.bookingCounts), function (snap) {
      var bookingCounts = {};
      snap.docs.forEach(function (d) {
        var data = d.data();
        if (data && data.key && typeof data.count === "number" && data.count > 0) bookingCounts[data.key] = data.count;
      });
      onChange({ bookingCounts: bookingCounts });
    }),
    onSnapshot(collection(db, COLLECTIONS.bookings), function (snap) {
      var bookings = snap.docs
        .map(function (d) {
          return d.data();
        })
        .sort(function (a, b) {
          return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
        });
      onChange({ bookings: bookings });
    }),
  ];

  return function unsubscribeAll() {
    unsubs.forEach(function (unsub) {
      unsub();
    });
  };
}

export function syncSlotsToCloud(slots) {
  return replaceCollection(
    COLLECTIONS.slots,
    (slots || []).map(function (row) {
      return { id: String(row.id), data: stripPrivateFields(row) };
    })
  );
}

export function syncBookingCountsToCloud(map) {
  return replaceCollection(
    COLLECTIONS.bookingCounts,
    Object.keys(map || {})
      .filter(function (key) {
        return typeof map[key] === "number" && map[key] > 0;
      })
      .map(function (key) {
        var split = splitBookingKey(key);
        return {
          id: countDocId(key),
          data: {
            key: key,
            sectionId: split.sectionId,
            startTime: split.startTime,
            count: map[key],
          },
        };
      })
  );
}

export function syncBookingsToCloud(bookings) {
  return replaceCollection(
    COLLECTIONS.bookings,
    (bookings || []).map(function (rec, index) {
      return { id: bookingDocId(rec, index), data: stripPrivateFields(rec) };
    })
  );
}

export function syncStudentsToCloud(students) {
  return replaceCollection(
    COLLECTIONS.students,
    (students || []).map(function (student, index) {
      return { id: studentDocId(student, index), data: stripPrivateFields(student) };
    })
  );
}

export function subscribeStudents(onChange) {
  return onSnapshot(collection(db, COLLECTIONS.students), function (snap) {
    var students = snap.docs
      .map(function (d) {
        return d.data();
      })
      .sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
    onChange(students);
  });
}
