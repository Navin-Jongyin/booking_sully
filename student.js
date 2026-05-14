import {
  fetchCloudStudents,
  subscribeStudents,
  syncStudentsToCloud,
} from "./firebase.js";

(function () {
  var STUDENTS_KEY = "ib_students_v1";
  var form = document.getElementById("student-form");
  var submitBtn = document.getElementById("student-submit");
  var banner = document.getElementById("student-banner");
  var listEl = document.getElementById("student-list");
  var countEl = document.getElementById("student-count");

  var fields = {
    name: {
      el: document.getElementById("student-name"),
      group: document.querySelector('[data-field="name"]'),
      errorEl: document.querySelector('[data-field="name"] .error-text'),
    },
    email: {
      el: document.getElementById("student-email"),
      group: document.querySelector('[data-field="email"]'),
      errorEl: document.querySelector('[data-field="email"] .error-text'),
    },
    phone: {
      el: document.getElementById("student-phone"),
      group: document.querySelector('[data-field="phone"]'),
      errorEl: document.querySelector('[data-field="phone"] .error-text'),
    },
  };

  var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function digitsOnly(str) {
    return String(str || "").replace(/\D/g, "");
  }

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function studentEmailKey(student) {
    return normalizeEmail((student && (student.emailNorm || student.email)) || "");
  }

  function cleanStudents(students) {
    var seen = {};
    var clean = [];
    (students || []).forEach(function (student) {
      var emailNorm = studentEmailKey(student);
      if (!emailNorm || seen[emailNorm]) return;
      seen[emailNorm] = true;
      clean.push({
        id: student.id || "student-" + Date.now() + "-" + Math.floor(Math.random() * 100000),
        name: String(student.name || "").trim(),
        email: String(student.email || emailNorm).trim(),
        emailNorm: emailNorm,
        phone: digitsOnly(student.phone),
        createdAt: student.createdAt || new Date().toISOString(),
        updatedAt: student.updatedAt || new Date().toISOString(),
      });
    });
    return clean;
  }

  function loadStudents() {
    try {
      var raw = localStorage.getItem(STUDENTS_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (err) {
      return [];
    }
  }

  function saveStudents(students) {
    var clean = cleanStudents(students);
    localStorage.setItem(STUDENTS_KEY, JSON.stringify(clean));
    syncStudentsToCloud(clean).catch(function (err) {
      console.error("Could not sync students to Firebase", err);
    });
    renderStudents(clean);
    updateSubmitState();
  }

  function applyCloudStudents(students) {
    if (!students) return;
    var clean = cleanStudents(students);
    localStorage.setItem(STUDENTS_KEY, JSON.stringify(clean));
    renderStudents(clean);
    updateSubmitState();
    if (clean.length !== students.length) {
      syncStudentsToCloud(clean).catch(function (err) {
        console.error("Could not remove duplicate students from Firebase", err);
      });
    }
  }

  function initFirebaseSync() {
    var localStudents = loadStudents();

    function startStudentSubscription() {
      subscribeStudents(function (students) {
        applyCloudStudents(students);
      });
    }

    fetchCloudStudents()
      .then(function (cloudStudents) {
        if (!cloudStudents.length && localStudents.length) {
          applyCloudStudents(localStudents);
          syncStudentsToCloud(localStudents)
            .catch(function (err) {
              console.error("Could not sync students to Firebase", err);
            })
            .finally(startStudentSubscription);
          return;
        }

        applyCloudStudents(cloudStudents);
        startStudentSubscription();
      })
      .catch(function (err) {
        console.error("Could not load Firebase student data", err);
        renderStudents(loadStudents());
        startStudentSubscription();
      });
  }

  function validateName(value) {
    if (!value || !value.trim()) return "Please enter the student's name.";
    return "";
  }

  function validateEmail(value) {
    if (!value || !value.trim()) return "Please enter the student's email.";
    if (!emailPattern.test(value.trim())) return "Please enter a valid email address.";
    if (studentExistsByEmail(value)) return "This email is already in the student list.";
    return "";
  }

  function validatePhone(value) {
    var d = digitsOnly(value);
    if (!value || !value.trim()) return "Please enter the student's phone number.";
    if (d.length !== 10) return "Phone number must be exactly 10 digits.";
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
  };

  function setFieldError(key, message) {
    fields[key].errorEl.textContent = message;
    fields[key].group.classList.toggle("has-error", Boolean(message));
  }

  function validateField(key, showError) {
    var msg = validators[key]();
    if (showError) setFieldError(key, msg);
    return !msg;
  }

  function isFormValid() {
    return !validateName(fields.name.el.value) && !validateEmail(fields.email.el.value) && !validatePhone(fields.phone.el.value);
  }

  function updateSubmitState() {
    submitBtn.disabled = !isFormValid();
  }

  function showMessage(message, kind) {
    banner.textContent = message || "";
    banner.classList.toggle("visible", Boolean(message));
    banner.classList.toggle("error", kind === "error");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sortStudents(students) {
    return (students || []).slice().sort(function (a, b) {
      var nameCompare = String(a.name || "").localeCompare(String(b.name || ""));
      if (nameCompare) return nameCompare;
      return String(a.email || "").localeCompare(String(b.email || ""));
    });
  }

  function renderStudents(students) {
    var sorted = sortStudents(students || loadStudents());
    listEl.innerHTML = "";
    countEl.textContent = sorted.length
      ? sorted.length + " saved student" + (sorted.length === 1 ? "." : "s.")
      : "No students yet.";

    if (!sorted.length) {
      var empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Add a student above to start your roster.";
      listEl.appendChild(empty);
      return;
    }

    sorted.forEach(function (student) {
      var row = document.createElement("div");
      row.className = "student-row";
      row.innerHTML =
        "<div><strong>" +
        escapeHtml(student.name || "") +
        "</strong><span>" +
        escapeHtml(student.email || "") +
        "</span><span>Phone: " +
        escapeHtml(student.phone || "") +
        "</span></div>";

      var deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn btn-danger";
      deleteBtn.textContent = "Delete";
      deleteBtn.setAttribute("aria-label", "Delete student " + (student.name || student.email || ""));
      deleteBtn.addEventListener("click", function () {
        if (!confirm("Delete " + (student.name || student.email || "this student") + "?")) return;
        saveStudents(
          loadStudents().filter(function (item) {
            return studentEmailKey(item) !== studentEmailKey(student);
          })
        );
        showMessage("Student deleted.", "ok");
      });

      row.appendChild(deleteBtn);
      listEl.appendChild(row);
    });
  }

  function studentExistsByEmail(email) {
    var emailNorm = normalizeEmail(email);
    return loadStudents().some(function (student) {
      return studentEmailKey(student) === emailNorm;
    });
  }

  function addStudent(student) {
    var students = loadStudents();
    if (studentExistsByEmail(student.emailNorm)) return false;
    student.id = student.emailNorm;
    students.push(student);
    saveStudents(students);
    return true;
  }

  fields.phone.el.addEventListener("input", function () {
    fields.phone.el.value = digitsOnly(fields.phone.el.value).slice(0, 10);
    setFieldError("phone", "");
    updateSubmitState();
  });

  ["name", "email"].forEach(function (key) {
    fields[key].el.addEventListener("input", function () {
      setFieldError(key, "");
      updateSubmitState();
    });
  });

  Object.keys(fields).forEach(function (key) {
    fields[key].el.addEventListener("blur", function () {
      validateField(key, true);
      updateSubmitState();
    });
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    showMessage("", "");

    var allOk = true;
    Object.keys(validators).forEach(function (key) {
      if (!validateField(key, true)) allOk = false;
    });
    updateSubmitState();
    if (!allOk) return;

    var email = fields.email.el.value.trim();
    var emailNorm = normalizeEmail(email);
    if (studentExistsByEmail(emailNorm)) {
      setFieldError("email", "This email is already in the student list.");
      updateSubmitState();
      return;
    }

    var student = {
      id: emailNorm,
      name: fields.name.el.value.trim(),
      email: email,
      emailNorm: emailNorm,
      phone: digitsOnly(fields.phone.el.value),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (!addStudent(student)) {
      setFieldError("email", "This email is already in the student list.");
      updateSubmitState();
      return;
    }

    showMessage("Added " + student.email + ".", "ok");
    form.reset();
    Object.keys(fields).forEach(function (key) {
      setFieldError(key, "");
    });
    updateSubmitState();
  });

  window.addEventListener("storage", function (e) {
    if (e.key === STUDENTS_KEY || e.key === null) renderStudents(loadStudents());
  });

  renderStudents(loadStudents());
  updateSubmitState();
  initFirebaseSync();
})();
