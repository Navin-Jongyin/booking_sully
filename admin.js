    import {
      fetchAdminCredentials,
      fetchCloudApplicants,
      loadCloudState,
      subscribeCloudState,
      subscribeApplicants,
      syncBookingCountsToCloud,
      syncBookingsToCloud,
      syncSlotsToCloud,
    } from "./firebase.js";

    (function () {
      var STORAGE_KEY = "ib_admin_slots_v1";
      var BOOKINGS_KEY = "ib_slot_bookings_v1";
      var BOOKINGS_DETAIL_KEY = "ib_bookings_detail_v1";
      var MAX_BOOKINGS_PER_SLOT = 5;
      var ADMIN_AUTH_KEY = "ib_admin_authenticated";

      var adminStarted = false;
      var bookingTabDate = null;
      var loginCard = document.getElementById("admin-login-card");
      var adminContent = document.getElementById("admin-content");
      var loginForm = document.getElementById("admin-login-form");
      var loginUsername = document.getElementById("admin-username");
      var loginPassword = document.getElementById("admin-password");
      var loginMsg = document.getElementById("admin-login-msg");
      var logoutBtn = document.getElementById("admin-logout");
      var dateInput = document.getElementById("slot-date");
      var form = document.getElementById("add-form");
      var formMsg = document.getElementById("form-msg");
      var publishedSlotsEl = document.getElementById("published-slots-for-day");
      var publishedDayEmpty = document.getElementById("published-day-empty");
      var btnClearDay = document.getElementById("btn-clear-day");
      var calGrid = document.getElementById("admin-cal-grid");
      var calTitle = document.getElementById("admin-cal-month");
      var selectedDateDisplay = document.getElementById("selected-date-display");
      var addTimeStart = document.getElementById("add-time-start");
      var addTimeEnd = document.getElementById("add-time-end");
      var btnAddOneTime = document.getElementById("btn-add-one-time");
      var pendingChips = document.getElementById("pending-chips");
      var btnClearPending = document.getElementById("btn-clear-pending");

      var viewYear;
      var viewMonth;
      var selectedDateISO = "";
      var applicantsByEmail = {};

      function pad2(n) {
        return String(n).padStart(2, "0");
      }

      function toISODate(d) {
        return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
      }

      function todayISODate() {
        return toISODate(new Date());
      }

      function normalizeTimeValue(val) {
        if (!val) return "";
        var p = String(val).split(":");
        var h = parseInt(p[0], 10);
        var m = parseInt(p[1], 10) || 0;
        if (isNaN(h)) h = 0;
        return pad2(h) + ":" + pad2(m);
      }

      function normalizeEmail(value) {
        return String(value || "").trim().toLowerCase();
      }

      function setApplicants(applicants) {
        applicantsByEmail = {};
        (applicants || []).forEach(function (applicant) {
          var email = normalizeEmail((applicant && applicant.email) || "");
          if (email) applicantsByEmail[email] = applicant;
        });
        renderBookingTabs();
      }

      function initApplicantSync() {
        fetchCloudApplicants()
          .then(setApplicants)
          .catch(function (err) {
            console.error("Could not load applicants", err);
          });

        subscribeApplicants(setApplicants);
      }

      function bookingNickname(rec) {
        var savedNickname = String((rec && rec.nickname) || "").trim();
        if (savedNickname) return savedNickname;
        var applicant = applicantsByEmail[normalizeEmail((rec && rec.email) || "")];
        return applicant ? String(applicant.nickname || "").trim() : "";
      }

      function datesWithPublishedSlots() {
        var set = {};
        loadSlots().forEach(function (row) {
          if (row.date) set[row.date] = true;
        });
        return set;
      }

      function setSelectedDate(iso) {
        selectedDateISO = iso;
        dateInput.value = iso || "";
        if (!iso) {
          selectedDateDisplay.textContent = "Select a date on the calendar.";
        } else {
          try {
            var d = new Date(iso + "T12:00:00");
            selectedDateDisplay.textContent =
              "Adding times for: " +
              d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
          } catch (e) {
            selectedDateDisplay.textContent = "Adding times for: " + iso;
          }
        }
        renderPublishedForSelectedDay();
        renderAdminCalendar();
      }

      function renderAdminCalendar() {
        var today = todayISODate();
        var published = datesWithPublishedSlots();
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
          if (isPast) {
            btn.classList.add("cal-cell--past");
            btn.disabled = true;
          } else {
            btn.addEventListener(
              "click",
              (function (dIso) {
                return function () {
                  setSelectedDate(dIso);
                };
              })(iso)
            );
          }

          if (iso === today) btn.classList.add("cal-cell--today");
          if (selectedDateISO && iso === selectedDateISO) btn.classList.add("cal-cell--selected");
          if (published[iso]) btn.classList.add("cal-cell--has-slots");

          calGrid.appendChild(btn);
        }
      }

      function initAdminCalendarNav() {
        var now = new Date();
        viewYear = now.getFullYear();
        viewMonth = now.getMonth();

        document.querySelector("#admin-calendar .cal-prev").addEventListener("click", function () {
          viewMonth--;
          if (viewMonth < 0) {
            viewMonth = 11;
            viewYear--;
          }
          renderAdminCalendar();
        });
        document.querySelector("#admin-calendar .cal-next").addEventListener("click", function () {
          viewMonth++;
          if (viewMonth > 11) {
            viewMonth = 0;
            viewYear++;
          }
          renderAdminCalendar();
        });
      }

      function loadSlots() {
        try {
          var raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return [];
          var data = JSON.parse(raw);
          return Array.isArray(data) ? data : [];
        } catch (e) {
          return [];
        }
      }

      function saveSlots(arr) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
        syncSlotsToCloud(arr).catch(function (err) {
          console.error("Could not sync slots to Firebase", err);
        });
        try {
          window.dispatchEvent(new Event("ib-slots-changed"));
        } catch (err) {}
        renderBookingTabs();
      }

      function newId() {
        return "sec-" + Date.now() + "-" + Math.floor(Math.random() * 100000);
      }

      function timeToMinutes(t) {
        var n = normalizeTimeValue(t);
        if (!n) return NaN;
        var p = n.split(":");
        return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
      }

      function normalizeSlotEntry(s) {
        if (s && typeof s === "object" && s.start !== undefined && s.start !== null) {
          return {
            start: normalizeTimeValue(String(s.start)),
            end: s.end ? normalizeTimeValue(String(s.end)) : null,
          };
        }
        return { start: normalizeTimeValue(String(s)), end: null };
      }

      function slotStartKey(slot) {
        if (slot && typeof slot === "object" && slot.start !== undefined && slot.start !== null)
          return normalizeTimeValue(String(slot.start));
        return normalizeTimeValue(String(slot));
      }

      function slotHasExplicitEnd(slot) {
        return Boolean(slot && typeof slot === "object" && slot.end);
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
        if (slotHasExplicitEnd(raw)) return normalizeTimeValue(String(raw.end));
        var starts = slots.map(function (s) {
          return slotStartKey(s);
        });
        return slotEndLabel(starts, index);
      }

      function slotRangeLabel(slots, index) {
        return slotStartKey(slots[index]) + " – " + slotEndResolved(slots, index);
      }

      function serializeSlot(o) {
        if (!o || !o.start) return null;
        if (o.end) return { start: o.start, end: o.end };
        return o.start;
      }

      function sortSlotEntries(arr) {
        return arr.slice().sort(function (a, b) {
          var as = timeToMinutes(a.start);
          var bs = timeToMinutes(b.start);
          if (as !== bs) return as - bs;
          var ae = a.end ? timeToMinutes(a.end) : -1;
          var be = b.end ? timeToMinutes(b.end) : -1;
          return ae - be;
        });
      }

      var DEFAULT_SLOT_TITLE = "Interview";

      function mergeOrAppend(list, date, slotEntries) {
        var mergedNew = sortSlotEntries(
          (slotEntries || []).map(normalizeSlotEntry).filter(function (o) {
            return o.start;
          })
        );
        if (!mergedNew.length) return { ok: false, reason: "Add at least one session with Add session." };

        var combined = {};
        var keepId = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].date === date) {
            if (keepId === null) keepId = list[i].id;
            (list[i].slots || []).forEach(function (s) {
              var o = normalizeSlotEntry(s);
              if (o.start) combined[o.start] = o;
            });
          }
        }
        mergedNew.forEach(function (o) {
          combined[o.start] = o;
        });

        var finalSlots = sortSlotEntries(Object.keys(combined).map(function (k) {
          return combined[k];
        }))
          .map(serializeSlot)
          .filter(Boolean);

        var next = list.filter(function (row) {
          return row.date !== date;
        });
        next.push({
          id: keepId || newId(),
          date: date,
          title: DEFAULT_SLOT_TITLE,
          slots: finalSlots,
        });
        next.sort(function (a, b) {
          if (a.date !== b.date) return a.date < b.date ? -1 : 1;
          return 0;
        });
        return { ok: true, list: next };
      }

      function setMsg(text, kind) {
        formMsg.textContent = text || "";
        formMsg.className = "msg" + (kind ? " " + kind : "");
      }

      function bookingMapKey(sectionId, timeSlot) {
        return String(sectionId) + "\t" + String(timeSlot);
      }

      function loadBookingMap() {
        try {
          var raw = localStorage.getItem(BOOKINGS_KEY);
          if (!raw) return {};
          var o = JSON.parse(raw);
          return o && typeof o === "object" && !Array.isArray(o) ? o : {};
        } catch (e) {
          return {};
        }
      }

      function saveBookingMap(map) {
        localStorage.setItem(BOOKINGS_KEY, JSON.stringify(map));
        syncBookingCountsToCloud(map).catch(function (err) {
          console.error("Could not sync booking counts to Firebase", err);
        });
        try {
          window.dispatchEvent(new Event("ib-bookings-counts-changed"));
        } catch (e) {}
      }

      function getBookingCount(sectionId, timeSlot) {
        var m = loadBookingMap();
        var c = m[bookingMapKey(sectionId, timeSlot)];
        return typeof c === "number" && c >= 0 ? c : 0;
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
        } catch (e) {
          return [];
        }
      }

      function stripAdminRecordKey(b) {
        var copy = {};
        Object.keys(b || {}).forEach(function (k) {
          if (k !== "__adminKey") copy[k] = b[k];
        });
        return copy;
      }

      function saveBookingsDetail(list) {
        var cleanList = (list || []).map(function (b) {
          return stripAdminRecordKey(b);
        });
        localStorage.setItem(
          BOOKINGS_DETAIL_KEY,
          JSON.stringify(cleanList)
        );
        syncBookingsToCloud(cleanList).catch(function (err) {
          console.error("Could not sync booking details to Firebase", err);
        });
        try {
          window.dispatchEvent(new Event("ib-bookings-changed"));
        } catch (e) {}
      }

      function applyCloudState(state) {
        if (state.slots) localStorage.setItem(STORAGE_KEY, JSON.stringify(state.slots));
        if (state.bookingCounts) localStorage.setItem(BOOKINGS_KEY, JSON.stringify(state.bookingCounts));
        if (state.bookings) localStorage.setItem(BOOKINGS_DETAIL_KEY, JSON.stringify(state.bookings));
        renderAdminCalendar();
        renderPublishedForSelectedDay();
        renderBookingTabs();
      }

      function initFirebaseSync() {
        loadCloudState()
          .then(function (state) {
            var localSlots = loadSlots();
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

      function uniqueSortedDates(rows) {
        var set = {};
        (rows || []).forEach(function (r) {
          if (r && r.date) set[r.date] = true;
        });
        loadBookingsDetail().forEach(function (b) {
          if (b && b.date) set[b.date] = true;
        });
        return Object.keys(set).sort();
      }

      function formatBookingTabLabel(iso) {
        try {
          var d = new Date(iso + "T12:00:00");
          return d.toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
          });
        } catch (e) {
          return iso;
        }
      }

      function bookingMatchesSectionSlot(b, sectionId, startKey) {
        return (
          b.sectionId === sectionId && normalizeTimeValue(String(b.startTime || "")) === startKey
        );
      }

      function sortBookingsNewestFirst(arr) {
        return arr.slice().sort(function (a, b) {
          return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
        });
      }

      function attachAdminRecordKeys(bookings) {
        return bookings.map(function (b, idx) {
          b.__adminKey =
            b.id ||
            [
              b.sectionId || "",
              normalizeTimeValue(String(b.startTime || "")),
              b.emailNorm || b.email || "",
              b.createdAt || "",
              idx,
            ].join("\t");
          return b;
        });
      }

      function refreshBookingDataViews(message) {
        renderBookingTabs();
        renderAdminCalendar();
        if (message) setMsg(message, "ok");
      }

      function deleteBookingRecord(rec) {
        if (!rec) return;
        var label = (rec.name || rec.email || "this booking") + (rec.timeLabel ? " at " + rec.timeLabel : "");
        if (!confirm("Delete " + label + "?")) return;

        var targetKey = rec.__adminKey;
        var next = attachAdminRecordKeys(loadBookingsDetail()).filter(function (b) {
          return b.__adminKey !== targetKey;
        });
        saveBookingsDetail(next);
        decrementBookingCount(rec.sectionId, normalizeTimeValue(String(rec.startTime || "")));
        refreshBookingDataViews("Deleted that booking.");
      }

      function removeCountOnlyBooking(sectionId, startKey) {
        if (!confirm("Remove one booking count for this slot?")) return;
        decrementBookingCount(sectionId, startKey);
        refreshBookingDataViews("Removed one count-only booking.");
      }

      function renderBookingPersonList(bookings) {
        var ulP = document.createElement("ul");
        ulP.className = "slot-booking-people";
        sortBookingsNewestFirst(bookings).forEach(function (p) {
          var li = document.createElement("li");
          var details = document.createElement("span");
          var strong = document.createElement("strong");
          strong.textContent = p.name || "—";
          details.appendChild(strong);
          details.appendChild(document.createTextNode(" "));
          var em = document.createElement("span");
          em.className = "person-email";
          em.textContent = p.email || "—";
          details.appendChild(em);
          var nickname = document.createElement("span");
          nickname.className = "person-nickname";
          nickname.textContent = "Nickname: " + (bookingNickname(p) || "—");
          details.appendChild(nickname);
          var phone = document.createElement("span");
          phone.className = "person-phone";
          phone.textContent = "Phone: " + (p.phone || "—");
          details.appendChild(phone);
          li.appendChild(details);

          var del = document.createElement("button");
          del.type = "button";
          del.className = "booking-delete-btn";
          del.textContent = "Delete";
          del.setAttribute("aria-label", "Delete booking for " + (p.name || p.email || "this person"));
          del.addEventListener("click", function () {
            deleteBookingRecord(p);
          });
          li.appendChild(del);
          ulP.appendChild(li);
        });
        return ulP;
      }

      function appendMissingDetailsNote(container, missingCount, sectionId, startKey) {
        if (missingCount <= 0) return;
        var note = document.createElement("p");
        note.className = "hint";
        note.style.margin = "8px 0 0";
        note.textContent =
          missingCount +
          " existing booking" +
          (missingCount === 1 ? "" : "s") +
          " for this slot do not have saved name/email details.";
        container.appendChild(note);

        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "booking-delete-btn booking-missing-action";
        btn.textContent = "Remove one count-only booking";
        btn.addEventListener("click", function () {
          removeCountOnlyBooking(sectionId, startKey);
        });
        container.appendChild(btn);
      }

      function renderBookingPanelForDate(iso) {
        var panel = document.getElementById("booking-panel-content");
        if (!panel) return;
        panel.innerHTML = "";
        if (!iso) return;

        var rows = loadSlots().filter(function (r) {
          return r.date === iso;
        });
        rows.sort(function (a, b) {
          return String(a.id).localeCompare(String(b.id));
        });

        var allDetails = attachAdminRecordKeys(
          loadBookingsDetail().filter(function (b) {
            return b.date === iso;
          })
        );

        if (!rows.length && !allDetails.length) {
          panel.innerHTML = "<p class=\"hint\">No sessions or bookings for this date.</p>";
          return;
        }

        if (!rows.length && allDetails.length) {
          var introN = document.createElement("p");
          introN.className = "hint";
          introN.style.marginTop = "0";
          introN.style.marginBottom = "12px";
          introN.textContent =
            "No published session row for this day. Bookings on file are grouped by session id and start time:";
          panel.appendChild(introN);

          var groups = {};
          allDetails.forEach(function (b) {
            var k = String(b.sectionId) + "\t" + normalizeTimeValue(String(b.startTime || ""));
            if (!groups[k]) {
              groups[k] = { label: b.timeLabel || b.startTime || k, list: [] };
            }
            groups[k].list.push(b);
          });

          Object.keys(groups)
            .sort()
            .forEach(function (gk) {
              var g = groups[gk];
              var block = document.createElement("div");
              block.className = "slot-booking-block";
              var head = document.createElement("div");
              head.className = "slot-booking-head";
              var timeEl = document.createElement("span");
              timeEl.className = "slot-booking-time";
              timeEl.textContent = g.label;
              head.appendChild(timeEl);
              var countEl = document.createElement("span");
              countEl.className = "slot-booking-count";
              countEl.textContent = g.list.length + " booked";
              head.appendChild(countEl);
              block.appendChild(head);
              block.appendChild(renderBookingPersonList(g.list));
              panel.appendChild(block);
            });
          return;
        }

        var intro = document.createElement("p");
        intro.className = "hint";
        intro.style.marginTop = "0";
        intro.style.marginBottom = "14px";
        intro.textContent = "Each time window shows who booked that slot (name and email).";
        panel.appendChild(intro);

        var matchedDetailIds = {};

        rows.forEach(function (row) {
          var wrap = document.createElement("div");
          wrap.className = "booking-day-group";

          var h = document.createElement("h3");
          h.textContent = row.title || "Interview";
          wrap.appendChild(h);

          (row.slots || []).forEach(function (slot, idx) {
            var startKey = slotStartKey(slot);
            var label = slotRangeLabel(row.slots, idx);

            var people = allDetails.filter(function (b) {
              return bookingMatchesSectionSlot(b, row.id, startKey);
            });
            people.forEach(function (b) {
              matchedDetailIds[b.__adminKey] = true;
            });
            var countFromMap = getBookingCount(row.id, startKey);
            var booked = Math.max(countFromMap, people.length);
            var missingDetails = Math.max(0, booked - people.length);

            var block = document.createElement("div");
            block.className = "slot-booking-block" + (booked >= MAX_BOOKINGS_PER_SLOT ? " is-full" : "");

            var head = document.createElement("div");
            head.className = "slot-booking-head";
            var timeEl = document.createElement("span");
            timeEl.className = "slot-booking-time";
            timeEl.textContent = label;
            var countEl = document.createElement("span");
            countEl.className = "slot-booking-count";
            countEl.textContent = booked + " / " + MAX_BOOKINGS_PER_SLOT + " booked";
            head.appendChild(timeEl);
            head.appendChild(countEl);
            block.appendChild(head);

            if (!people.length) {
              if (booked > 0) {
                appendMissingDetailsNote(block, missingDetails, row.id, startKey);
              } else {
                var none = document.createElement("p");
                none.className = "hint";
                none.style.margin = "0";
                none.textContent = "No bookings yet for this slot.";
                block.appendChild(none);
              }
            } else {
              block.appendChild(renderBookingPersonList(people));
              appendMissingDetailsNote(block, missingDetails, row.id, startKey);
            }

            wrap.appendChild(block);
          });

          panel.appendChild(wrap);
        });

        var orphans = allDetails.filter(function (b) {
          return !matchedDetailIds[b.__adminKey];
        });
        if (!orphans.length) return;

        var ob = document.createElement("div");
        ob.className = "booking-day-group booking-orphan-block";
        var oh = document.createElement("h3");
        oh.textContent = "Other bookings (slot or session changed)";
        ob.appendChild(oh);
        var op = document.createElement("p");
        op.className = "hint";
        op.style.marginBottom = "10px";
        op.textContent =
          "These entries do not match a current published slot for this day. They may be from an older schedule.";
        ob.appendChild(op);
        var oul = document.createElement("ul");
        oul.className = "slot-booking-people";
        sortBookingsNewestFirst(orphans).forEach(function (p) {
          var li = document.createElement("li");
          var strong = document.createElement("strong");
          strong.textContent = p.name || "—";
          li.appendChild(strong);
          li.appendChild(document.createTextNode(" "));
          var em = document.createElement("span");
          em.className = "person-email";
          em.textContent = p.email || "—";
          li.appendChild(em);
          var br = document.createElement("br");
          li.appendChild(br);
          var nickname = document.createElement("small");
          nickname.style.color = "var(--text-muted)";
          nickname.textContent = "Nickname: " + (bookingNickname(p) || "—");
          li.appendChild(nickname);
          li.appendChild(document.createElement("br"));
          var small = document.createElement("small");
          small.style.color = "var(--text-muted)";
          small.textContent = (p.timeLabel || p.startTime || "—") + " · session " + String(p.sectionId || "").slice(0, 14) + "…";
          li.appendChild(small);
          oul.appendChild(li);
        });
        ob.appendChild(oul);
        panel.appendChild(ob);
      }

      function setBookingTab(iso) {
        bookingTabDate = iso;
        var tabs = document.querySelectorAll("#booking-tabs .booking-tab");
        tabs.forEach(function (t) {
          var active = t.getAttribute("data-date") === iso;
          t.classList.toggle("booking-tab--active", active);
          t.setAttribute("aria-selected", active ? "true" : "false");
        });
        renderBookingPanelForDate(iso);
      }

      function renderBookingTabs() {
        var tabsEl = document.getElementById("booking-tabs");
        var emptyAll = document.getElementById("booking-empty-all");
        if (!tabsEl || !emptyAll) return;

        var rows = loadSlots();
        var dates = uniqueSortedDates(rows);

        tabsEl.innerHTML = "";
        if (!dates.length) {
          emptyAll.hidden = false;
          bookingTabDate = null;
          var panel = document.getElementById("booking-panel-content");
          if (panel) panel.innerHTML = "";
          return;
        }

        emptyAll.hidden = true;

        dates.forEach(function (iso) {
          var tab = document.createElement("button");
          tab.type = "button";
          tab.className = "booking-tab";
          tab.setAttribute("role", "tab");
          tab.setAttribute("data-date", iso);
          tab.setAttribute("aria-selected", "false");
          tab.id = "booking-tab-" + iso.replace(/[^0-9A-Za-z-]/g, "");
          tab.textContent = formatBookingTabLabel(iso);
          tab.addEventListener("click", function () {
            setBookingTab(iso);
          });
          tabsEl.appendChild(tab);
        });

        if (!bookingTabDate || dates.indexOf(bookingTabDate) === -1) {
          bookingTabDate = dates[0];
        }
        setBookingTab(bookingTabDate);
      }

      function pendingSlotsFromChips() {
        var out = [];
        pendingChips.querySelectorAll(".time-chip").forEach(function (chip) {
          var st = chip.getAttribute("data-start");
          var en = chip.getAttribute("data-end");
          if (st && en) out.push({ start: st, end: en });
        });
        return out;
      }

      function getSlotsForSubmit() {
        return pendingSlotsFromChips();
      }

      function clearPendingChips() {
        pendingChips.innerHTML = "";
      }

      function chipKey(start, end) {
        return start + "|" + end;
      }

      function addPendingSlot(start, end) {
        var normS = normalizeTimeValue(start);
        var normE = normalizeTimeValue(end);
        if (!normS || !normE) return false;
        var key = chipKey(normS, normE);
        if (pendingChips.querySelector('.time-chip[data-chip-key="' + key + '"]')) return false;

        var chip = document.createElement("span");
        chip.className = "time-chip";
        chip.setAttribute("data-start", normS);
        chip.setAttribute("data-end", normE);
        chip.setAttribute("data-chip-key", key);
        chip.appendChild(document.createTextNode(normS + "–" + normE + " "));

        var rm = document.createElement("button");
        rm.type = "button";
        rm.setAttribute("aria-label", "Remove session " + normS + " to " + normE);
        rm.textContent = "×";
        rm.addEventListener("click", function () {
          chip.remove();
        });
        chip.appendChild(rm);
        pendingChips.appendChild(chip);
        return true;
      }

      function renderPublishedForSelectedDay() {
        if (!publishedSlotsEl || !publishedDayEmpty || !btnClearDay) return;
        publishedSlotsEl.innerHTML = "";

        if (!selectedDateISO) {
          publishedDayEmpty.textContent = "Select a date on the calendar to see published sessions.";
          publishedDayEmpty.hidden = false;
          btnClearDay.hidden = true;
          return;
        }

        var rows = loadSlots();
        var row = null;
        for (var ri = 0; ri < rows.length; ri++) {
          if (rows[ri].date === selectedDateISO) {
            row = rows[ri];
            break;
          }
        }

        if (!row || !row.slots || !row.slots.length) {
          publishedDayEmpty.textContent = "No sessions published for this day yet.";
          publishedDayEmpty.hidden = false;
          btnClearDay.hidden = true;
          return;
        }

        publishedDayEmpty.hidden = true;
        btnClearDay.hidden = false;

        row.slots.forEach(function (slot, idx) {
          var o = normalizeSlotEntry(slot);
          var label = o.end ? o.start + "–" + o.end : o.start;
          var wrap = document.createElement("span");
          wrap.className = "published-chip";
          wrap.appendChild(document.createTextNode(label + " "));

          var rm = document.createElement("button");
          rm.type = "button";
          rm.setAttribute("aria-label", "Remove published session " + label);
          rm.textContent = "×";
          rm.addEventListener(
            "click",
            (function (slotIndex) {
              return function () {
                removePublishedSlotAtIndex(slotIndex);
              };
            })(idx)
          );
          wrap.appendChild(rm);
          publishedSlotsEl.appendChild(wrap);
        });
      }

      function removePublishedSlotAtIndex(slotIndex) {
        var iso = selectedDateISO;
        if (!iso) return;
        var rows = loadSlots();
        var ri = -1;
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].date === iso) {
            ri = i;
            break;
          }
        }
        if (ri === -1) return;
        var row = rows[ri];
        if (!row.slots || slotIndex < 0 || slotIndex >= row.slots.length) return;

        var next = rows.slice();
        var copy = { id: row.id, date: row.date, title: row.title, slots: row.slots.slice() };
        copy.slots.splice(slotIndex, 1);
        if (copy.slots.length === 0) {
          next.splice(ri, 1);
        } else {
          next[ri] = copy;
        }
        saveSlots(next);
        renderPublishedForSelectedDay();
        renderAdminCalendar();
        setMsg("Removed that session.", "ok");
      }

      function addSessionFromPicker() {
        setMsg("", "");
        var normS = normalizeTimeValue(addTimeStart.value);
        var normE = normalizeTimeValue(addTimeEnd.value);
        if (!normS || !normE) {
          setMsg("Pick both start and end times.", "error");
          return;
        }
        if (timeToMinutes(normE) <= timeToMinutes(normS)) {
          setMsg("End time must be after start time.", "error");
          return;
        }
        var before = pendingChips.querySelectorAll(".time-chip").length;
        var added = addPendingSlot(normS, normE);
        var after = pendingChips.querySelectorAll(".time-chip").length;
        if (after > before && added) {
          setMsg("Added " + normS + "–" + normE + ".", "ok");
        } else {
          setMsg("That session is already in the list.", "error");
        }
      }

      function bindEnterAdd(el) {
        el.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            addSessionFromPicker();
          }
        });
      }

      function setLoginMessage(text, kind) {
        loginMsg.textContent = text || "";
        loginMsg.className = "msg" + (kind ? " " + kind : "");
      }

      function showAdminContent() {
        loginCard.hidden = true;
        adminContent.hidden = false;
      }

      function startAdminApp() {
        if (adminStarted) return;
        adminStarted = true;
        showAdminContent();

        initAdminCalendarNav();
        setSelectedDate(todayISODate());
        renderBookingTabs();
        initFirebaseSync();
        initApplicantSync();

        window.addEventListener("storage", function (e) {
          if (e.key === BOOKINGS_KEY || e.key === STORAGE_KEY || e.key === BOOKINGS_DETAIL_KEY || e.key === null)
            renderBookingTabs();
        });
        window.addEventListener("ib-bookings-changed", function () {
          renderBookingTabs();
        });
        document.addEventListener("visibilitychange", function () {
          if (!document.hidden) renderBookingTabs();
        });

        btnAddOneTime.addEventListener("click", function () {
          addSessionFromPicker();
        });
        bindEnterAdd(addTimeStart);
        bindEnterAdd(addTimeEnd);

        btnClearPending.addEventListener("click", function () {
          clearPendingChips();
          setMsg("Cleared sessions.", "ok");
        });

        form.addEventListener("submit", function (e) {
          e.preventDefault();
          setMsg("", "");

          var d = dateInput.value || selectedDateISO;
          if (!d) {
            setMsg("Choose a date on the calendar.", "error");
            return;
          }
          if (d < todayISODate()) {
            setMsg("Date cannot be in the past.", "error");
            return;
          }

          var sessions = getSlotsForSubmit();
          var list = loadSlots();
          var res = mergeOrAppend(list, d, sessions);
          if (!res.ok) {
            setMsg(res.reason, "error");
            return;
          }

          saveSlots(res.list);
          renderPublishedForSelectedDay();
          clearPendingChips();
          setMsg("Saved. It appears on the booking page now.", "ok");
          renderAdminCalendar();
        });

        btnClearDay.addEventListener("click", function () {
          if (!selectedDateISO) return;
          if (!confirm("Remove every published session for this day?")) return;
          var next = loadSlots().filter(function (r) {
            return r.date !== selectedDateISO;
          });
          saveSlots(next);
          renderPublishedForSelectedDay();
          renderAdminCalendar();
          setMsg("Removed all sessions for this day.", "ok");
        });
      }

      function logoutAdmin() {
        sessionStorage.removeItem(ADMIN_AUTH_KEY);
        location.reload();
      }

      function setupAdminLogin() {
        adminContent.hidden = true;
        loginCard.hidden = false;
        logoutBtn.addEventListener("click", logoutAdmin);

        if (sessionStorage.getItem(ADMIN_AUTH_KEY) === "true") {
          startAdminApp();
          return;
        }

        loginForm.addEventListener("submit", function (e) {
          e.preventDefault();
          setLoginMessage("Checking login...", "");

          var username = loginUsername.value.trim();
          var password = loginPassword.value;
          if (!username || !password) {
            setLoginMessage("Enter username and password.", "error");
            return;
          }

          fetchAdminCredentials()
            .then(function (creds) {
              if (!creds) {
                setLoginMessage("Admin credentials were not found in Firebase.", "error");
                return;
              }
              if (username === String(creds.username || "") && password === String(creds.password || "")) {
                sessionStorage.setItem(ADMIN_AUTH_KEY, "true");
                setLoginMessage("", "");
                startAdminApp();
              } else {
                setLoginMessage("Incorrect username or password.", "error");
              }
            })
            .catch(function (err) {
              console.error("Could not check admin credentials", err);
              setLoginMessage("Could not check Firebase credentials. Try again.", "error");
            });
        });
      }

      setupAdminLogin();
    })();
