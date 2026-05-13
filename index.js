    import {
      loadCloudState,
      subscribeCloudState,
      syncBookingCountsToCloud,
      syncBookingsToCloud,
      syncSlotsToCloud,
    } from "./firebase.js";

    (function () {
      var form = document.getElementById("booking-form");
      var submitBtn = document.getElementById("submit-btn");
      var successBanner = document.getElementById("success-banner");
      var dateInput = document.getElementById("date");
      var calGrid = document.getElementById("cal-grid");
      var calTitle = document.getElementById("cal-month-title");
      var sectionListEl = document.getElementById("section-list");
      var sessionEmptyEl = document.getElementById("session-empty-state");
      var sessionEmptyMsg = document.getElementById("session-empty-msg");
      var sectionFieldGroup = document.getElementById("section-field-group");
      var timeFieldGroup = document.getElementById("time-field-group");
      var timeSlotValueInput = document.getElementById("time-slot");
      var cancelForm = document.getElementById("cancel-form");
      var cancelEmailInput = document.getElementById("cancel-email");
      var cancelPhoneInput = document.getElementById("cancel-phone");
      var cancelBanner = document.getElementById("cancel-banner");
      var cancelListEl = document.getElementById("cancel-list");

      var viewYear;
      var viewMonth;
      var selectedDateISO = "";
      var selectedSectionId = "";

      /** Same key as admin.html — slots persist in this browser (localStorage). */
      var STORAGE_KEY = "ib_admin_slots_v1";
      /** Per session + time slot booking counts (max 5 each). */
      var BOOKINGS_KEY = "ib_slot_bookings_v1";
      /** Confirmed bookings with contact info (same browser). */
      var BOOKINGS_DETAIL_KEY = "ib_bookings_detail_v1";
      var MAX_BOOKINGS_PER_SLOT = 5;
      var CANCEL_DEADLINE_MS = 24 * 60 * 60 * 1000;

      function loadBookingMap() {
        try {
          var raw = localStorage.getItem(BOOKINGS_KEY);
          if (!raw) return {};
          var o = JSON.parse(raw);
          return o && typeof o === "object" && !Array.isArray(o) ? o : {};
        } catch (err) {
          return {};
        }
      }

      function saveBookingMap(map) {
        localStorage.setItem(BOOKINGS_KEY, JSON.stringify(map));
        syncBookingCountsToCloud(map).catch(function (err) {
          console.error("Could not sync booking counts to Firebase", err);
        });
      }

      function bookingMapKey(sectionId, timeSlot) {
        return String(sectionId) + "\t" + String(timeSlot);
      }

      function getBookingCount(sectionId, timeSlot) {
        var m = loadBookingMap();
        var c = m[bookingMapKey(sectionId, timeSlot)];
        return typeof c === "number" && c >= 0 ? c : 0;
      }

      function incrementBookingCount(sectionId, timeSlot) {
        var m = loadBookingMap();
        var k = bookingMapKey(sectionId, timeSlot);
        m[k] = (m[k] || 0) + 1;
        saveBookingMap(m);
      }

      function decrementBookingCount(sectionId, timeSlot) {
        if (!sectionId || !timeSlot) return;
        var m = loadBookingMap();
        var k = bookingMapKey(sectionId, timeSlot);
        var current = typeof m[k] === "number" ? m[k] : 0;
        if (current > 1) {
          m[k] = current - 1;
        } else {
          delete m[k];
        }
        saveBookingMap(m);
      }

      function loadBookingsDetail() {
        try {
          var raw = localStorage.getItem(BOOKINGS_DETAIL_KEY);
          if (!raw) return [];
          var a = JSON.parse(raw);
          return Array.isArray(a) ? a : [];
        } catch (err) {
          return [];
        }
      }

      function saveBookingsDetail(arr) {
        localStorage.setItem(BOOKINGS_DETAIL_KEY, JSON.stringify(arr));
        syncBookingsToCloud(arr).catch(function (err) {
          console.error("Could not sync booking details to Firebase", err);
        });
        try {
          window.dispatchEvent(new Event("ib-bookings-changed"));
        } catch (err) {}
      }

      function applyCloudState(state) {
        if (state.slots) localStorage.setItem(STORAGE_KEY, JSON.stringify(state.slots));
        if (state.bookingCounts) localStorage.setItem(BOOKINGS_KEY, JSON.stringify(state.bookingCounts));
        if (state.bookings) localStorage.setItem(BOOKINGS_DETAIL_KEY, JSON.stringify(state.bookings));
        refreshScheduleFromStorage();
      }

      function initFirebaseSync() {
        loadCloudState()
          .then(function (state) {
            var localSlots = loadSlotsFromStorage();
            var localCounts = loadBookingMap();
            var localBookings = loadBookingsDetail();
            var cloudCountsEmpty = !Object.keys(state.bookingCounts || {}).length;

            if ((!state.slots || !state.slots.length) && localSlots.length) syncSlotsToCloud(localSlots);
            if (cloudCountsEmpty && Object.keys(localCounts).length) syncBookingCountsToCloud(localCounts);
            if ((!state.bookings || !state.bookings.length) && localBookings.length) syncBookingsToCloud(localBookings);

            applyCloudState({
              slots: state.slots && state.slots.length ? state.slots : localSlots,
              bookingCounts: cloudCountsEmpty ? localCounts : state.bookingCounts,
              bookings: state.bookings && state.bookings.length ? state.bookings : localBookings,
            });
          })
          .catch(function (err) {
            console.error("Could not load Firebase data", err);
          });

        subscribeCloudState(function (state) {
          applyCloudState(state);
        });
      }

      function appendBookingRecord(rec) {
        var list = loadBookingsDetail();
        list.push(rec);
        saveBookingsDetail(list);
      }

      function bookingRecordKey(rec, index) {
        return (
          rec.id ||
          [
            rec.sectionId || "",
            normalizeTimeStr(rec.startTime || ""),
            rec.emailNorm || rec.email || "",
            rec.phone || "",
            rec.date || "",
            rec.createdAt || "",
            index,
          ].join("\t")
        );
      }

      function lookupBookings(email, phone) {
        var normEmail = String(email || "").trim().toLowerCase();
        var phoneDigits = digitsOnly(String(phone || ""));
        return loadBookingsDetail()
          .map(function (rec, index) {
            return { key: bookingRecordKey(rec, index), record: rec };
          })
          .filter(function (item) {
            var rec = item.record;
            var recEmail = String(rec.emailNorm || rec.email || "").trim().toLowerCase();
            var recPhone = digitsOnly(String(rec.phone || ""));
            return recEmail === normEmail && (!phoneDigits || recPhone === phoneDigits);
          });
      }

      function bookingStartDate(rec) {
        if (!rec || !rec.date || !rec.startTime) return null;
        var d = new Date(rec.date + "T" + normalizeTimeStr(rec.startTime) + ":00");
        return isNaN(d.getTime()) ? null : d;
      }

      function canCancelBooking(rec) {
        var start = bookingStartDate(rec);
        return Boolean(start && start.getTime() - Date.now() >= CANCEL_DEADLINE_MS);
      }

      function formatBookingStart(rec) {
        var start = bookingStartDate(rec);
        if (!start) return rec.date || "Unknown date";
        try {
          return start.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
        } catch (err) {
          return (rec.date || "") + " " + (rec.startTime || "");
        }
      }

      function showCancelMessage(message, kind) {
        cancelBanner.textContent = message || "";
        cancelBanner.classList.toggle("visible", Boolean(message));
        cancelBanner.classList.toggle("error", kind === "error");
      }

      function clearCancelResults() {
        cancelListEl.innerHTML = "";
        showCancelMessage("", "");
      }

      function removeBookingByKey(targetKey) {
        var removed = null;
        var next = [];
        loadBookingsDetail().forEach(function (rec, index) {
          if (!removed && bookingRecordKey(rec, index) === targetKey) {
            removed = rec;
            return;
          }
          next.push(rec);
        });
        if (!removed) return false;
        saveBookingsDetail(next);
        decrementBookingCount(removed.sectionId, normalizeTimeStr(removed.startTime || ""));
        return true;
      }

      function renderCancelResults(items, message, kind) {
        cancelListEl.innerHTML = "";
        if (!items.length) {
          showCancelMessage(message || "No bookings found for that email and phone number.", kind || "error");
          return;
        }

        showCancelMessage(message || "Found " + items.length + " booking" + (items.length === 1 ? "." : "s."), kind || "ok");
        items.forEach(function (item) {
          var rec = item.record;
          var row = document.createElement("div");
          row.className = "cancel-booking";

          var main = document.createElement("div");
          var title = document.createElement("strong");
          title.textContent = rec.timeLabel || rec.startTime || "Interview";
          main.appendChild(title);

          var meta = document.createElement("small");
          meta.textContent = formatBookingStart(rec) + " · " + (rec.email || "");
          main.appendChild(meta);
          row.appendChild(main);

          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn btn-danger";
          btn.style.width = "auto";
          if (canCancelBooking(rec)) {
            btn.textContent = "Cancel Booking";
            btn.addEventListener("click", function () {
              if (!confirm("Cancel this booking?")) return;
              if (!canCancelBooking(rec)) {
                showCancelMessage("This booking is now within 24 hours and cannot be cancelled.", "error");
                renderCancelResults(lookupBookings(cancelEmailInput.value, cancelPhoneInput.value));
                return;
              }
              if (removeBookingByKey(item.key)) {
                refreshScheduleFromStorage();
                renderCancelResults(lookupBookings(cancelEmailInput.value, cancelPhoneInput.value), "Booking cancelled.", "ok");
              } else {
                showCancelMessage("Could not find that booking. Refresh and try again.", "error");
              }
            });
          } else {
            btn.textContent = "Cannot Cancel";
            btn.disabled = true;
            var reason = document.createElement("small");
            reason.textContent = "Less than 24 hours before start time.";
            main.appendChild(reason);
          }
          row.appendChild(btn);
          cancelListEl.appendChild(row);
        });
      }

      function sectionHasAvailableSlot(sec) {
        if (!sec || !sec.slots || !sec.slots.length) return false;
        return sec.slots.some(function (t) {
          return getBookingCount(sec.id, slotStartKey(t)) < MAX_BOOKINGS_PER_SLOT;
        });
      }

      function dateAvailabilityState(iso) {
        var secs = sectionsForDate(iso);
        if (!secs.length) return "closed";
        for (var i = 0; i < secs.length; i++) {
          if (sectionHasAvailableSlot(secs[i])) return "available";
        }
        return "full";
      }

      function pad2(n) {
        return String(n).padStart(2, "0");
      }

      function normalizeTimeStr(val) {
        if (val === undefined || val === null || val === "") return "";
        var p = String(val).split(":");
        var h = parseInt(p[0], 10);
        var m = parseInt(p[1], 10) || 0;
        if (isNaN(h)) h = 0;
        return pad2(h) + ":" + pad2(m);
      }

      function slotStartKey(slot) {
        if (slot && typeof slot === "object" && slot.start !== undefined && slot.start !== null)
          return normalizeTimeStr(slot.start);
        return normalizeTimeStr(slot);
      }

      function slotHasExplicitEnd(slot) {
        return Boolean(slot && typeof slot === "object" && slot.end);
      }

      function toISODate(d) {
        return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
      }

      function todayISODate() {
        return toISODate(new Date());
      }

      function loadSlotsFromStorage() {
        try {
          var raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return [];
          var data = JSON.parse(raw);
          return Array.isArray(data) ? data : [];
        } catch (err) {
          return [];
        }
      }

      var ADMIN_SECTIONS = [];

      function updateEmptyHint() {
        var hint = document.getElementById("cal-hint");
        if (!hint) return;
        if (!ADMIN_SECTIONS.length) {
          hint.textContent =
            "No slots yet. Open the Admin panel to add dates and times. Green days are bookable once added.";
        } else {
          hint.textContent =
            "Green = at least one open slot. Red = published but every slot is full (5 bookings each). Grey = no sessions.";
        }
      }

      function refreshScheduleFromStorage() {
        ADMIN_SECTIONS = loadSlotsFromStorage();
        updateEmptyHint();
        renderCalendar();
        if (selectedDateISO) {
          if (!datesWithOpeningsSet()[selectedDateISO] || dateAvailabilityState(selectedDateISO) !== "available") {
            selectedDateISO = "";
            selectedSectionId = "";
            dateInput.value = "";
            sectionListEl.innerHTML = "";
            resetTimeSlots();
          } else {
            var keepSection = selectedSectionId;
            renderSectionRadios(selectedDateISO, keepSection);
          }
        }
        updateSessionEmptyPlaceholder();
        updateSubmitState();
      }

      function updateSessionEmptyPlaceholder() {
        if (!sessionEmptyEl || !sessionEmptyMsg) return;
        var secs = selectedDateISO ? sectionsForDate(selectedDateISO) : [];
        var show = secs.length === 0;
        if (show) {
          if (!ADMIN_SECTIONS.length) {
            sessionEmptyMsg.textContent =
              "No interview sessions are open yet. Use the Admin panel to publish dates and times.";
          } else if (!selectedDateISO) {
            sessionEmptyMsg.textContent =
              "Select a green date on the calendar (red days are fully booked).";
          } else {
            sessionEmptyMsg.textContent = "No open sessions for this date.";
          }
          sessionEmptyEl.removeAttribute("hidden");
          sectionListEl.removeAttribute("role");
          sectionListEl.setAttribute("aria-hidden", "true");
        } else {
          sessionEmptyEl.setAttribute("hidden", "");
          sessionEmptyMsg.textContent = "";
          sectionListEl.removeAttribute("aria-hidden");
          sectionListEl.setAttribute("role", "radiogroup");
        }
      }

      function datesWithOpeningsSet() {
        var set = {};
        ADMIN_SECTIONS.forEach(function (s) {
          set[s.date] = true;
        });
        return set;
      }

      function sectionsForDate(iso) {
        return ADMIN_SECTIONS.filter(function (s) {
          return s.date === iso;
        });
      }

      var fields = {
        name: {
          el: document.getElementById("full-name"),
          group: document.querySelector('[data-field="name"]'),
          errorEl: document.querySelector('[data-field="name"] .error-text'),
        },
        email: {
          el: document.getElementById("email"),
          group: document.querySelector('[data-field="email"]'),
          errorEl: document.querySelector('[data-field="email"] .error-text'),
        },
        phone: {
          el: document.getElementById("phone"),
          group: document.querySelector('[data-field="phone"]'),
          errorEl: document.querySelector('[data-field="phone"] .error-text'),
        },
        date: {
          el: dateInput,
          group: document.querySelector('[data-field="date"]'),
          errorEl: document.querySelector('[data-field="date"] .error-text'),
        },
        section: {
          el: sectionListEl,
          group: document.querySelector('[data-field="section"]'),
          errorEl: document.querySelector('[data-field="section"] .error-text'),
        },
        time: {
          el: timeSlotValueInput,
          group: document.querySelector('[data-field="time"]'),
          errorEl: document.querySelector('[data-field="time"] .error-text'),
        },
        bookingQuota: {
          el: document.getElementById("email"),
          group: document.querySelector('[data-field="bookingQuota"]'),
          errorEl: document.querySelector('[data-field="bookingQuota"] .error-text'),
        },
      };

      var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      function digitsOnly(str) {
        return str.replace(/\D/g, "");
      }

      function validateName(value) {
        if (!value || !value.trim()) return "Please enter your full name.";
        return "";
      }

      function validateBookingQuota() {
        var rawEmail = fields.email.el.value;
        if (validateEmail(rawEmail)) return "";
        var norm = rawEmail.trim().toLowerCase();
        var dateVal = (dateInput.value || selectedDateISO || "").trim();
        if (!dateVal) return "";
        var list = loadBookingsDetail();
        var total = 0;
        var dayCount = 0;
        for (var i = 0; i < list.length; i++) {
          if (list[i].emailNorm === norm) {
            total++;
            if (list[i].date === dateVal) dayCount++;
          }
        }
        if (total >= 2) return "This email already has 2 bookings (the maximum).";
        if (dayCount >= 1) return "This email already has a booking on that date (limit: one session per day).";
        return "";
      }

      function validateEmail(value) {
        if (!value || !value.trim()) return "Please enter your email.";
        if (!emailPattern.test(value.trim())) return "Please enter a valid email address.";
        return "";
      }

      function validatePhone(value) {
        var d = digitsOnly(value);
        if (!value || !value.trim()) return "Please enter your phone number.";
        if (d.length !== 10) return "Phone number must be exactly 10 digits.";
        return "";
      }

      function validateDate(value) {
        if (!value) return "Please select a date on the calendar.";
        if (value < todayISODate()) return "Please choose today or a future date.";
        if (!datesWithOpeningsSet()[value]) return "That day has no published sessions. Pick a different date.";
        if (dateAvailabilityState(value) === "full")
          return "That date is fully booked (each time slot allows up to 5 bookings).";
        return "";
      }

      function validateSection() {
        if (!selectedDateISO) return "Pick a calendar date first.";
        var secs = sectionsForDate(selectedDateISO);
        if (!secs.length) return "No published times for this date.";
        if (!selectedSectionId) return "Please select an open time slot.";
        var sec = secs.find(function (s) {
          return s.id === selectedSectionId;
        });
        if (!sec) return "Please select a valid time slot.";
        if (!sectionHasAvailableSlot(sec)) return "That time slot is fully booked.";
        return "";
      }

      function validateTime(value) {
        if (!selectedSectionId) return "Choose a time slot first.";
        var sec = ADMIN_SECTIONS.find(function (s) {
          return s.id === selectedSectionId;
        });
        if (!sec) return "Choose a time slot first.";
        if (!value) return "No open time could be set. Pick a different slot.";
        var ok = sec.slots.some(function (s) {
          return slotStartKey(s) === value;
        });
        if (!ok) return "That time slot is no longer available. Choose another slot.";
        if (getBookingCount(sec.id, value) >= MAX_BOOKINGS_PER_SLOT)
          return "That time slot is full (5 bookings). Choose another time.";
        return "";
      }

      var validators = {
        name: function () {
          return validateName(fields.name.el.value);
        },
        email: function () {
          return validateEmail(fields.email.el.value);
        },
        phone: function () {
          return validatePhone(fields.phone.el.value);
        },
        date: function () {
          return validateDate(dateInput.value);
        },
        section: function () {
          return validateSection();
        },
        time: function () {
          return validateTime(fields.time.el.value);
        },
        bookingQuota: function () {
          return validateBookingQuota();
        },
      };

      function setFieldError(key, message) {
        var f = fields[key];
        f.errorEl.textContent = message;
        f.group.classList.toggle("has-error", Boolean(message));
      }

      function validateField(key, showError) {
        var msg = validators[key]();
        if (showError) setFieldError(key, msg);
        return !msg;
      }

      function isFormValid() {
        return (
          !validateName(fields.name.el.value) &&
          !validateEmail(fields.email.el.value) &&
          !validatePhone(fields.phone.el.value) &&
          !validateDate(dateInput.value) &&
          !validateSection() &&
          !validateTime(fields.time.el.value) &&
          !validateBookingQuota()
        );
      }

      function updateSubmitState() {
        submitBtn.disabled = !isFormValid();
        syncSectionTimeDisabledState();
      }

      function syncSectionTimeDisabledState() {
        var hasDate = Boolean(selectedDateISO);
        var secs = hasDate ? sectionsForDate(selectedDateISO) : [];
        sectionFieldGroup.classList.toggle("form-block-muted", !hasDate);
        timeFieldGroup.classList.toggle("form-block-muted", !selectedSectionId);
      }

      function resetTimeSlots() {
        timeSlotValueInput.value = "";
      }

      function rangeLabelForStoredTime(sectionId, timeVal) {
        if (!sectionId || !timeVal) return "";
        var sec = ADMIN_SECTIONS.find(function (s) {
          return s.id === sectionId;
        });
        if (!sec || !sec.slots) return timeVal;
        for (var i = 0; i < sec.slots.length; i++) {
          if (slotStartKey(sec.slots[i]) === timeVal) return slotRangeLabel(sec.slots, i);
        }
        return timeVal;
      }

      function slotEndLabel(startsOnly, index) {
        if (index < startsOnly.length - 1) return startsOnly[index + 1];
        var parts = String(startsOnly[index]).split(":");
        var h = parseInt(parts[0], 10) || 0;
        var m = parseInt(parts[1], 10) || 0;
        var total = h * 60 + m + 60;
        var eh = Math.floor(total / 60) % 24;
        var em = total % 60;
        return pad2(eh) + ":" + pad2(em);
      }

      function slotEndResolved(slots, index) {
        var raw = slots[index];
        if (slotHasExplicitEnd(raw)) return normalizeTimeStr(raw.end);
        var starts = slots.map(function (s) {
          return slotStartKey(s);
        });
        return slotEndLabel(starts, index);
      }

      function slotRangeLabel(slots, index) {
        return slotStartKey(slots[index]) + " – " + slotEndResolved(slots, index);
      }

      function renderSectionRadios(iso, preserveSectionId) {
        var preserveTime = timeSlotValueInput.value;
        sectionListEl.innerHTML = "";
        selectedSectionId = "";
        resetTimeSlots();
        var secs = sectionsForDate(iso);
        var selectable = [];

        secs.forEach(function (sec) {
          if (!sec.slots || !sec.slots.length) return;
          sec.slots.forEach(function (slot, slotIdx) {
            var startKey = slotStartKey(slot);
            var count = getBookingCount(sec.id, startKey);
            var full = count >= MAX_BOOKINGS_PER_SLOT;
            var rangeLabel = slotRangeLabel(sec.slots, slotIdx);

            if (!full) {
              selectable.push({ sectionId: sec.id, time: startKey, input: null });
            }

            var label = document.createElement("label");
            label.className = "section-option" + (full ? " section-option--disabled" : "");
            var input = document.createElement("input");
            input.type = "radio";
            input.name = "adminSection";
            input.value = sec.id + "\t" + startKey;
            input.required = true;
            input.disabled = full;
            input.setAttribute("data-section-id", sec.id);
            input.setAttribute("data-time", startKey);
            var card = document.createElement("span");
            card.className = "section-card" + (full ? " section-card--full" : "");
            if (full) {
              card.innerHTML =
                '<strong class="section-card-line">' +
                escapeHtml(rangeLabel) +
                '</strong><small>Full · ' +
                MAX_BOOKINGS_PER_SLOT +
                "/" +
                MAX_BOOKINGS_PER_SLOT +
                " booked</small>";
            } else {
              card.innerHTML =
                '<strong class="section-card-line">' +
                escapeHtml(rangeLabel) +
                '</strong><small>' +
                count +
                "/" +
                MAX_BOOKINGS_PER_SLOT +
                " booked</small>";
            }
            label.appendChild(input);
            label.appendChild(card);
            sectionListEl.appendChild(label);

            input.addEventListener("change", function () {
              if (!input.checked || input.disabled) return;
              selectedSectionId = sec.id;
              timeSlotValueInput.value = startKey;
              setFieldError("section", "");
              setFieldError("time", "");
              fields.section.group.classList.remove("has-error");
              fields.time.group.classList.remove("has-error");
              updateSubmitState();
            });
            if (!full) selectable[selectable.length - 1].input = input;
          });
        });

        if (selectable.length === 1) {
          selectable[0].input.checked = true;
          selectedSectionId = selectable[0].sectionId;
          timeSlotValueInput.value = selectable[0].time;
        } else if (preserveSectionId) {
          var fallback = null;
          for (var si = 0; si < selectable.length; si++) {
            if (selectable[si].sectionId !== preserveSectionId) continue;
            if (!fallback) fallback = selectable[si];
            if (preserveTime && selectable[si].time === preserveTime) {
              fallback = selectable[si];
              break;
            }
          }
          if (fallback) {
            fallback.input.checked = true;
            selectedSectionId = fallback.sectionId;
            timeSlotValueInput.value = fallback.time;
          }
        }
        updateSessionEmptyPlaceholder();
        updateSubmitState();
      }

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      function selectCalendarDate(iso) {
        selectedDateISO = iso;
        dateInput.value = iso;
        setFieldError("date", "");
        fields.date.group.classList.remove("has-error");
        setFieldError("section", "");
        setFieldError("time", "");
        setFieldError("bookingQuota", "");
        fields.section.group.classList.remove("has-error");
        fields.time.group.classList.remove("has-error");
        fields.bookingQuota.group.classList.remove("has-error");
        renderSectionRadios(iso);
        renderCalendar();
        updateSubmitState();
      }

      function openDatesSet() {
        return datesWithOpeningsSet();
      }

      function renderCalendar() {
        var open = openDatesSet();
        var today = todayISODate();
        var first = new Date(viewYear, viewMonth, 1);
        var startWeekday = first.getDay();
        var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
        calTitle.textContent = first.toLocaleString(undefined, { month: "long", year: "numeric" });

        calGrid.innerHTML = "";
        var totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;

        for (var i = 0; i < totalCells; i++) {
          var dayNum = i - startWeekday + 1;
          if (dayNum < 1 || dayNum > daysInMonth) {
            var empty = document.createElement("div");
            empty.className = "cal-cell";
            empty.setAttribute("aria-hidden", "true");
            calGrid.appendChild(empty);
            continue;
          }

          var cellDate = new Date(viewYear, viewMonth, dayNum);
          var iso = toISODate(cellDate);
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "cal-cell cal-cell--day";
          btn.textContent = String(dayNum);

          var isPast = iso < today;
          var hasSessions = Boolean(open[iso]);
          var availState = hasSessions ? dateAvailabilityState(iso) : "closed";

          if (isPast) {
            btn.classList.add("cal-cell--past");
            btn.disabled = true;
            btn.setAttribute("aria-label", iso + ", past date");
          } else if (!hasSessions) {
            btn.classList.add("cal-cell--closed");
            btn.setAttribute("aria-label", iso + ", no session published");
          } else if (availState === "available") {
            btn.classList.add("cal-cell--open");
            btn.setAttribute("aria-label", iso + ", open with availability");
          } else {
            btn.classList.add("cal-cell--full");
            btn.setAttribute("aria-label", iso + ", fully booked");
          }

          if (iso === today) btn.classList.add("cal-cell--today");
          if (selectedDateISO && iso === selectedDateISO) btn.classList.add("cal-cell--selected");

          if (!isPast && hasSessions && availState === "available") {
            btn.addEventListener("click", function (dIso) {
              return function () {
                selectCalendarDate(dIso);
              };
            }(iso));
          } else if (!isPast && !hasSessions) {
            btn.addEventListener("click", function () {
              setFieldError("date", "No session published that day. Choose another date.");
              fields.date.group.classList.add("has-error");
            });
          } else if (!isPast && hasSessions && availState === "full") {
            btn.addEventListener("click", function () {
              setFieldError(
                "date",
                "That date is fully booked. Each time slot allows up to " + MAX_BOOKINGS_PER_SLOT + " bookings."
              );
              fields.date.group.classList.add("has-error");
            });
          }

          calGrid.appendChild(btn);
        }
      }

      function initCalendarNav() {
        var now = new Date();
        viewYear = now.getFullYear();
        viewMonth = now.getMonth();

        document.querySelector(".cal-prev").addEventListener("click", function () {
          viewMonth--;
          if (viewMonth < 0) {
            viewMonth = 11;
            viewYear--;
          }
          renderCalendar();
        });
        document.querySelector(".cal-next").addEventListener("click", function () {
          viewMonth++;
          if (viewMonth > 11) {
            viewMonth = 0;
            viewYear++;
          }
          renderCalendar();
        });
      }

      function onPhoneInput() {
        fields.phone.el.value = digitsOnly(fields.phone.el.value).slice(0, 10);
      }

      fields.phone.el.addEventListener("input", function () {
        onPhoneInput();
        setFieldError("phone", "");
        fields.phone.group.classList.remove("has-error");
        updateSubmitState();
      });

      ["name", "email"].forEach(function (key) {
        fields[key].el.addEventListener("input", function () {
          setFieldError(key, "");
          fields[key].group.classList.remove("has-error");
          setFieldError("bookingQuota", "");
          fields.bookingQuota.group.classList.remove("has-error");
          updateSubmitState();
        });
      });

      sectionListEl.addEventListener("change", function () {
        updateSubmitState();
      });

      ["name", "email", "phone", "time", "bookingQuota"].forEach(function (key) {
        fields[key].el.addEventListener("blur", function () {
          validateField(key, true);
          updateSubmitState();
        });
      });

      sectionListEl.addEventListener("blur", function (e) {
        if (!sectionListEl.contains(e.relatedTarget)) {
          validateField("section", true);
          updateSubmitState();
        }
      }, true);

      cancelPhoneInput.addEventListener("input", function () {
        cancelPhoneInput.value = digitsOnly(cancelPhoneInput.value).slice(0, 10);
        clearCancelResults();
      });

      cancelEmailInput.addEventListener("input", function () {
        clearCancelResults();
      });

      cancelForm.addEventListener("submit", function (e) {
        e.preventDefault();
        cancelPhoneInput.value = digitsOnly(cancelPhoneInput.value).slice(0, 10);
        var email = cancelEmailInput.value.trim();
        var phone = cancelPhoneInput.value.trim();
        cancelListEl.innerHTML = "";

        if (!email || !emailPattern.test(email)) {
          showCancelMessage("Enter the email used for the booking.", "error");
          return;
        }
        if (phone && digitsOnly(phone).length !== 10) {
          showCancelMessage("Phone is optional, but if entered it must be 10 digits.", "error");
          return;
        }

        renderCancelResults(lookupBookings(email, phone));
      });

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        successBanner.classList.remove("visible");
        successBanner.textContent = "";

        var allOk = true;
        Object.keys(validators).forEach(function (key) {
          var ok = validateField(key, true);
          if (!ok) allOk = false;
        });

        updateSubmitState();
        if (!allOk) return;

        var bookSection = selectedSectionId;
        var bookTime = fields.time.el.value;
        var bookDate = dateInput.value;
        var timeRangeLabel = rangeLabelForStoredTime(bookSection, bookTime);
        var emailTrim = fields.email.el.value.trim();
        var nameTrim = fields.name.el.value.trim();
        var phoneDigits = digitsOnly(fields.phone.el.value);

        incrementBookingCount(bookSection, bookTime);
        appendBookingRecord({
          id: "bk-" + Date.now() + "-" + Math.floor(Math.random() * 100000),
          emailNorm: emailTrim.toLowerCase(),
          email: emailTrim,
          name: nameTrim,
          phone: phoneDigits,
          date: bookDate,
          sectionId: bookSection,
          startTime: bookTime,
          timeLabel: timeRangeLabel || bookTime,
          createdAt: new Date().toISOString(),
        });

        successBanner.textContent =
          "Booked for " +
          bookDate +
          (timeRangeLabel ? " · " + timeRangeLabel : " at " + bookTime) +
          ". Confirmation goes to " +
          emailTrim +
          ".";
        successBanner.classList.add("visible");

        form.reset();
        selectedDateISO = "";
        selectedSectionId = "";
        dateInput.value = "";
        sectionListEl.innerHTML = "";
        resetTimeSlots();
        var now = new Date();
        viewYear = now.getFullYear();
        viewMonth = now.getMonth();
        Object.keys(fields).forEach(function (key) {
          setFieldError(key, "");
        });
        updateSessionEmptyPlaceholder();
        renderCalendar();
        updateSubmitState();
      });

      initCalendarNav();

      window.addEventListener("storage", function (e) {
        if (e.key === STORAGE_KEY || e.key === BOOKINGS_KEY || e.key === BOOKINGS_DETAIL_KEY || e.key === null)
          refreshScheduleFromStorage();
      });
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) refreshScheduleFromStorage();
      });
      window.addEventListener("pageshow", function (e) {
        if (e.persisted) refreshScheduleFromStorage();
      });

      refreshScheduleFromStorage();
      initFirebaseSync();
    })();
