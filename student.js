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
    var clean = (students || []).map(function (student) {
      return {
        id: student.id,
        name: student.name,
        email: student.email,
        emailNorm: student.emailNorm,
        phone: student.phone,
        createdAt: student.createdAt,
        updatedAt: student.updatedAt,
      };
    });
    localStorage.setItem(STUDENTS_KEY, JSON.stringify(clean));
    syncStudentsToCloud(clean).catch(function (err) {
      console.error("Could not sync students to Firebase", err);
    });
    renderStudents(clean);
  }

  function applyCloudStudents(students) {
    if (!students) return;
    localStorage.setItem(STUDENTS_KEY, JSON.stringify(students));
    renderStudents(students);
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
            return (item.emailNorm || item.email) !== (student.emailNorm || student.email);
          })
        );
        showMessage("Student deleted.", "ok");
      });

      row.appendChild(deleteBtn);
      listEl.appendChild(row);
    });
  }

  function upsertStudent(student) {
    var students = loadStudents();
    var existingIndex = -1;
    for (var i = 0; i < students.length; i++) {
      if (students[i].emailNorm === student.emailNorm) {
        existingIndex = i;
        break;
      }
    }

    if (existingIndex >= 0) {
      student.id = students[existingIndex].id;
      student.createdAt = students[existingIndex].createdAt || student.createdAt;
      students[existingIndex] = student;
      saveStudents(students);
      return "Updated " + student.email + ".";
    }

    students.push(student);
    saveStudents(students);
    return "Added " + student.email + ".";
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
    var student = {
      id: "student-" + Date.now() + "-" + Math.floor(Math.random() * 100000),
      name: fields.name.el.value.trim(),
      email: email,
      emailNorm: email.toLowerCase(),
      phone: digitsOnly(fields.phone.el.value),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    showMessage(upsertStudent(student), "ok");
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
