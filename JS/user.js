// ============================================================================
// USER DASHBOARD
// Reads session values written by login.js (sessionStorage), then calls
// the backend for this user's application, overview stats, and uploaded
// documents.
// ============================================================================

const PROGRESS_STEPS = ["submitted", "hr", "admin"];

// Default document types offered on the Documents tab. Free-text on the
// backend (DocType has no fixed enum), but these three are required
// before "Apply for Loan" will submit.
const REQUIRED_DOC_TYPES = ["Identity Proof", "Address Proof", "Income Proof"];

let uploadedDocuments = [];
let pendingUpload = false;

document.addEventListener("DOMContentLoaded", function () {
    renderAccountFromSession();
    initAccountDropdown();
    loadCurrentApplication();
    loadOverviewStats();
    initTabs();
    initApplyForm();
    initDocumentUpload();
    loadDocuments();
});


// ============================================================================
// TAB SWITCHING — Home / Apply for Loan / Documents / Track Status
// ============================================================================
function initTabs() {
    var navLinks = document.querySelectorAll(".nav-link");

    navLinks.forEach(function (link) {
        link.addEventListener("click", function (e) {
            e.preventDefault();
            var targetTab = link.getAttribute("data-tab");
            switchTab(targetTab);
        });
    });
}

function switchTab(tabName) {
    document.querySelectorAll(".nav-link").forEach(function (link) {
        link.classList.toggle("active", link.getAttribute("data-tab") === tabName);
    });

    document.querySelectorAll(".tab-panel").forEach(function (panel) {
        panel.classList.toggle("is-active", panel.id === "tab-" + tabName);
    });
}


// ============================================================================
// TOAST
// ============================================================================
let toastHideTimer = null;

function showToast(message, isError) {
    var toast = document.getElementById("appToast");
    var messageEl = document.getElementById("appToastMessage");
    if (!toast || !messageEl) return;

    messageEl.textContent = message;
    toast.classList.toggle("is-error", !!isError);
    toast.classList.add("is-visible");

    clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(function () {
        toast.classList.remove("is-visible");
    }, 3200);
}


// ============================================================================
// ACCOUNT / TOPBAR
// ============================================================================
function renderAccountFromSession() {
    var name = sessionStorage.getItem("employeeName");
    var nameEl = document.getElementById("accountName");
    var initialsEl = document.getElementById("accountInitials");
    var welcomeEl = document.getElementById("welcomeHeading");

    if (name) {
        nameEl.textContent = name;
        initialsEl.textContent = getInitials(name);
        welcomeEl.textContent = "Welcome back, " + name.split(" ")[0];
    } else {
        nameEl.textContent = "Guest";
        initialsEl.textContent = "--";
        welcomeEl.textContent = "Welcome back";
    }
}

function getInitials(fullName) {
    var parts = fullName.trim().split(/\s+/);
    var initials = parts[0].charAt(0);
    if (parts.length > 1) {
        initials += parts[parts.length - 1].charAt(0);
    }
    return initials.toUpperCase();
}


// ============================================================================
// ACCOUNT DROPDOWN — click the account chip to reveal username/email/
// usertype + logout. Closes on outside click or Escape.
// ============================================================================
function initAccountDropdown() {
    var chip = document.getElementById("accountChip");
    var dropdown = document.getElementById("accountDropdown");
    if (!chip || !dropdown) return;

    document.getElementById("dropdownName").textContent = sessionStorage.getItem("employeeName") || "—";
    document.getElementById("dropdownEmail").textContent = sessionStorage.getItem("employee_email") || "—";
    document.getElementById("dropdownUsertype").textContent = formatUsertype(sessionStorage.getItem("usertype"));

    chip.addEventListener("click", function (e) {
        e.stopPropagation();
        dropdown.classList.toggle("is-open");
    });

    document.addEventListener("click", function (e) {
        if (!dropdown.contains(e.target) && !chip.contains(e.target)) {
            dropdown.classList.remove("is-open");
        }
    });

    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") dropdown.classList.remove("is-open");
    });

    var logoutBtn = document.getElementById("dropdownLogoutBtn");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", function () {
            sessionStorage.clear();
            window.location.href = "../HTML/login.html";
        });
    }
}

function formatUsertype(raw) {
    if (!raw) return "—";
    return raw.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}


// ============================================================================
// DOCUMENTS TAB — upload Identity/Address/Income Proof (once, user-level)
// Expected endpoints:
//   POST /api/documents/upload   (multipart: userid, doc_type, file)
//   GET  /api/documents/<userid> -> { documents, required_doc_types,
//                                      missing_required, all_required_present }
// ============================================================================
function initDocumentUpload() {
    var form = document.getElementById("documentUploadForm");
    if (!form) return;

    form.addEventListener("submit", function (e) {
        e.preventDefault();
        submitDocumentUpload();
    });
}

async function loadDocuments() {
    var userid = sessionStorage.getItem("employeeid");
    var listEl = document.getElementById("documentList");
    if (!listEl) return;

    try {
        const response = await fetch('http://127.0.0.1:8000/api/documents/' + encodeURIComponent(userid || ''), {
            method: 'GET'
        });

        if (!response.ok) {
            throw new Error('Could not load documents');
        }

        const data = await response.json();
        uploadedDocuments = data.documents || [];
        renderDocumentList();
        renderMissingDocsNotice(data.missing_required || []);

    } catch (err) {
        uploadedDocuments = [];
        renderDocumentList();
        renderMissingDocsNotice(REQUIRED_DOC_TYPES);
    }
}

function renderDocumentList() {
    var listEl = document.getElementById("documentList");
    if (!listEl) return;

    listEl.innerHTML = "";

    if (uploadedDocuments.length === 0) {
        var empty = document.createElement("p");
        empty.className = "doc-empty-note";
        empty.textContent = "No documents uploaded yet.";
        listEl.appendChild(empty);
        return;
    }

    uploadedDocuments.forEach(function (doc) {
        var row = document.createElement("div");
        row.className = "doc-row";

        var label = document.createElement("span");
        label.textContent = doc.doc_type + " — " + doc.filename;

        var viewLink = document.createElement("a");
        viewLink.textContent = "View";
        viewLink.href = 'http://127.0.0.1:8000/api/documents/file/' + encodeURIComponent(doc.document_id);
        viewLink.target = "_blank";
        viewLink.rel = "noopener";

        row.appendChild(label);
        row.appendChild(viewLink);
        listEl.appendChild(row);
    });
}

function renderMissingDocsNotice(missing) {
    var notice = document.getElementById("missingDocsNotice");
    if (!notice) return;

    if (missing.length === 0) {
        notice.style.display = "none";
        notice.textContent = "";
    } else {
        notice.style.display = "block";
        notice.textContent = "Still needed before you can apply: " + missing.join(", ") + ".";
    }
}

async function submitDocumentUpload() {
    if (pendingUpload) return;

    var userid = sessionStorage.getItem("employeeid");
    var docType = document.getElementById("docTypeSelect").value;
    var fileInput = document.getElementById("docFileInput");
    var errorBox = document.getElementById("documentUploadError");
    var uploadBtn = document.getElementById("documentUploadBtn");

    errorBox.style.display = "none";

    if (!docType) {
        errorBox.textContent = "Please choose a document type.";
        errorBox.style.display = "block";
        return;
    }

    if (!fileInput.files || fileInput.files.length === 0) {
        errorBox.textContent = "Please choose a file to upload.";
        errorBox.style.display = "block";
        return;
    }

    var formData = new FormData();
    formData.append("userid", userid || "");
    formData.append("doc_type", docType);
    formData.append("file", fileInput.files[0]);

    pendingUpload = true;
    uploadBtn.disabled = true;
    uploadBtn.textContent = "Uploading…";

    try {
        const response = await fetch('http://127.0.0.1:8000/api/documents/upload', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "Couldn't upload the document. Please try again.");
        }

        showToast(docType + " uploaded successfully.");
        document.getElementById("documentUploadForm").reset();
        loadDocuments();

    } catch (err) {
        errorBox.textContent = err.message || "Couldn't upload the document. Please try again.";
        errorBox.style.display = "block";
    } finally {
        pendingUpload = false;
        uploadBtn.disabled = false;
        uploadBtn.textContent = "Upload Document";
    }
}


// ============================================================================
// APPLY FOR LOAN — gated on required documents, confirm dialog before submit
// Expected endpoint: POST /api/applications/apply
// Body: { userid, loan_type, amount, tenure, purpose }
// ============================================================================
function initApplyForm() {
    var form = document.getElementById("applyLoanForm");
    if (!form) return;

    form.addEventListener("submit", function (e) {
        e.preventDefault();
        handleApplySubmitClick();
    });

    var confirmYesBtn = document.getElementById("applyConfirmYesBtn");
    var confirmNoBtn = document.getElementById("applyConfirmNoBtn");
    if (confirmYesBtn) {
        confirmYesBtn.addEventListener("click", function () {
            closeApplyConfirmDialog();
            submitLoanApplication();
        });
    }
    if (confirmNoBtn) {
        confirmNoBtn.addEventListener("click", closeApplyConfirmDialog);
    }
}

function handleApplySubmitClick() {
    var errorBox = document.getElementById("applyFormError");
    errorBox.style.display = "none";

    var loanType = document.getElementById("loanType").value;
    var amount = document.getElementById("loanAmount").value;
    var tenure = document.getElementById("loanTenure").value;
    var purpose = document.getElementById("loanPurpose").value.trim();

    if (!loanType || !amount || !tenure || !purpose) {
        errorBox.textContent = "Please fill in every field before submitting.";
        errorBox.style.display = "block";
        return;
    }

    var missingDocs = REQUIRED_DOC_TYPES.filter(function (type) {
        return !uploadedDocuments.some(function (doc) { return doc.doc_type === type; });
    });

    if (missingDocs.length > 0) {
        errorBox.textContent = "Please upload the following before applying: " + missingDocs.join(", ") + ". Visit the Documents tab to add them.";
        errorBox.style.display = "block";
        return;
    }

    openApplyConfirmDialog({ loanType: loanType, amount: amount, tenure: tenure, purpose: purpose });
}

function openApplyConfirmDialog(details) {
    var overlay = document.getElementById("applyConfirmOverlay");
    if (!overlay) {
        // No confirm dialog in the markup — fall back to submitting directly.
        submitLoanApplication();
        return;
    }

    document.getElementById("applyConfirmLoanType").textContent = details.loanType;
    document.getElementById("applyConfirmAmount").textContent = details.amount;
    document.getElementById("applyConfirmTenure").textContent = details.tenure + " months";

    overlay.classList.add("is-open");
}

function closeApplyConfirmDialog() {
    var overlay = document.getElementById("applyConfirmOverlay");
    if (overlay) overlay.classList.remove("is-open");
}

async function submitLoanApplication() {
    var userid = sessionStorage.getItem("employeeid");
    var errorBox = document.getElementById("applyFormError");
    var submitBtn = document.getElementById("applySubmitBtn");

    var loanType = document.getElementById("loanType").value;
    var amount = document.getElementById("loanAmount").value;
    var tenure = document.getElementById("loanTenure").value;
    var purpose = document.getElementById("loanPurpose").value.trim();

    errorBox.style.display = "none";
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";

    try {
        const response = await fetch('http://127.0.0.1:8000/api/applications/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userid: userid,
                loan_type: loanType,
                amount: amount,
                tenure: tenure,
                purpose: purpose
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "Couldn't submit your application. Please try again.");
        }

        showToast("Application submitted — your officer will review it shortly.");

        document.getElementById("applyLoanForm").reset();

        loadCurrentApplication();
        loadOverviewStats();
        switchTab("home");

    } catch (err) {
        errorBox.textContent = err.message || "Couldn't submit your application. Please try again.";
        errorBox.style.display = "block";
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit Application";
    }
}


// ============================================================================
// CURRENT APPLICATION + STATUS + PROGRESS
// Expected endpoint: GET /api/applications/current?userid=<id>
// ============================================================================
async function loadCurrentApplication() {
    var userid = sessionStorage.getItem("employeeid");

    try {
        const response = await fetch('http://127.0.0.1:8000/api/applications/current?userid=' + encodeURIComponent(userid || ''), {
            method: 'GET'
        });

        if (!response.ok) {
            throw new Error('Could not load application');
        }

        const data = await response.json();

        if (!data.has_application) {
            renderNoApplicationState();
            return;
        }

        renderApplication(data);

    } catch (err) {
        renderNoApplicationState();
    }
}

function renderApplication(data) {
    document.getElementById("applicationId").textContent = "Application " + (data.application_id || "—");
    document.getElementById("applicationMeta").textContent = (data.loan_type || "Loan") + " · Submitted " + (data.submitted_on || "—");
    document.getElementById("applicationSubmittedOn").textContent = data.submitted_on ? ("Submitted " + data.submitted_on) : "—";

    document.getElementById("detailLoanType").textContent = data.loan_type || "—";
    document.getElementById("detailAmount").textContent = data.amount || "—";
    document.getElementById("detailTenure").textContent = data.tenure || "—";

    setStatusPill(data.status);
    setProgressTracker(data.status, data.step_dates || {});
}

function renderNoApplicationState() {
    document.getElementById("applicationId").textContent = "No active application";
    document.getElementById("applicationMeta").textContent = "Apply for a loan to see its status here.";
    document.getElementById("applicationSubmittedOn").textContent = "—";

    document.getElementById("detailLoanType").textContent = "—";
    document.getElementById("detailAmount").textContent = "—";
    document.getElementById("detailTenure").textContent = "—";

    var pill = document.getElementById("applicationStatusPill");
    pill.textContent = "No Application";
    pill.className = "status-pill is-pending";

    setProgressTracker(null, {});
}

function setStatusPill(status) {
    var pill = document.getElementById("applicationStatusPill");
    var map = {
        submitted: { label: "Submitted", cls: "is-pending" },
        hr_verification: { label: "HR Verification", cls: "is-progress" },
        admin_approval: { label: "Admin Approval", cls: "is-progress" },
        approved: { label: "Approved", cls: "is-approved" },
        rejected: { label: "Rejected", cls: "is-rejected" }
    };
    var entry = map[status] || { label: "Pending", cls: "is-pending" };
    pill.textContent = entry.label;
    pill.className = "status-pill " + entry.cls;
}

function setProgressTracker(status, stepDates) {
    var completedUpTo = -1;
    if (status === "hr_verification") completedUpTo = 0;
    if (status === "admin_approval") completedUpTo = 1;
    if (status === "approved" || status === "rejected") completedUpTo = 2;

    var currentIndex = -1;
    if (status === "submitted") currentIndex = 0;
    if (status === "hr_verification") currentIndex = 1;
    if (status === "admin_approval") currentIndex = 2;

    PROGRESS_STEPS.forEach(function (stepKey, index) {
        var el = document.querySelector('.progress-step[data-step="' + stepKey + '"]');
        if (!el) return;
        el.classList.remove("is-complete", "is-current");
        if (index <= completedUpTo) {
            el.classList.add("is-complete");
        } else if (index === currentIndex) {
            el.classList.add("is-current");
        }
    });

    document.getElementById("stepSubmittedDate").textContent = stepDates.submitted || (status ? "—" : "Not started");
    document.getElementById("stepHrDate").textContent = stepDates.hr || "Pending";
    document.getElementById("stepAdminDate").textContent = stepDates.admin || "Pending";
}


// ============================================================================
// OVERVIEW STATS (right column)
// Expected endpoint: GET /api/applications/overview?userid=<id>
// ============================================================================
async function loadOverviewStats() {
    var userid = sessionStorage.getItem("employeeid");

    try {
        const response = await fetch('http://127.0.0.1:8000/api/applications/overview?userid=' + encodeURIComponent(userid || ''), {
            method: 'GET'
        });

        if (!response.ok) {
            throw new Error('Could not load overview');
        }

        const data = await response.json();

        document.getElementById("statTotalApplications").textContent = data.total_applications ?? "0";
        document.getElementById("statActive").textContent = data.active ?? "0";
        document.getElementById("statPendingActions").textContent = data.pending_actions ?? "0";

        var foot = document.getElementById("statPendingActionsFoot");
        foot.textContent = (data.pending_actions && data.pending_actions > 0)
            ? "Action needed on your end"
            : "Nothing needs your attention";

    } catch (err) {
        document.getElementById("statTotalApplications").textContent = "0";
        document.getElementById("statActive").textContent = "0";
        document.getElementById("statPendingActions").textContent = "0";
        document.getElementById("statPendingActionsFoot").textContent = "Nothing needs your attention";
    }
}