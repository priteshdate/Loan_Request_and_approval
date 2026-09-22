const PAGE_SIZE = 8;

let allApplications = [];
let filteredApplications = [];
let currentPage = 1;
let activeApplicationId = null;

document.addEventListener("DOMContentLoaded", function () {
    renderAccountFromSession();
    initAccountDropdown();
    loadQueue();

    document.getElementById("queueSearchInput").addEventListener("input", function (e) {
        currentPage = 1;
        applyFilter(e.target.value);
    });

    document.getElementById("modalCloseBtn").addEventListener("click", closeViewModal);
    document.getElementById("modalCancelBtn").addEventListener("click", closeViewModal);
    document.getElementById("viewModalOverlay").addEventListener("click", function (e) {
        if (e.target === this) closeViewModal();
    });
    document.getElementById("modalForwardBtn").addEventListener("click", forwardToAdmin);
});


// ============================================================================
// ACCOUNT / TOPBAR — same session contract as login.js / user-dashboard.js
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
// usertype + logout. Same behavior as user-dashboard.js.
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
// QUEUE LOADING
// Expected endpoint: GET /api/officer/queue
// Expected shape: {
//   applications: [{
//     application_id, applicant_name, loan_type, amount, submitted_on
//   }, ...]
// }
// ============================================================================
async function loadQueue() {
    try {
        const response = await fetch('http://127.0.0.1:8000/api/officer/queue', {
            method: 'GET'
        });

        if (!response.ok) {
            throw new Error('Could not load queue');
        }

        const data = await response.json();
        allApplications = data.applications || [];
        filteredApplications = allApplications.slice();
        renderQueueChip();
        renderTablePage();

    } catch (err) {
        // Backend not wired up yet — show a clean empty state rather than
        // fake rows.
        allApplications = [];
        filteredApplications = [];
        renderQueueChip();
        renderEmptyState("No pending applications right now.");
        document.getElementById("queuePagination").style.display = "none";
    }
}

function renderQueueChip() {
    var chip = document.getElementById("queueCountChip");
    var count = allApplications.length;
    chip.textContent = count + (count === 1 ? " pending" : " pending");
}


// ============================================================================
// SEARCH (client-side filter over already-loaded queue)
// ============================================================================
function applyFilter(rawQuery) {
    var query = (rawQuery || "").trim().toLowerCase();

    if (!query) {
        filteredApplications = allApplications.slice();
    } else {
        filteredApplications = allApplications.filter(function (app) {
            var name = (app.applicant_name || "").toLowerCase();
            var id = (app.application_id || "").toLowerCase();
            return name.indexOf(query) !== -1 || id.indexOf(query) !== -1;
        });
    }

    renderTablePage();
}


// ============================================================================
// TABLE + PAGINATION RENDERING
// ============================================================================
function renderTablePage() {
    var tbody = document.getElementById("queueTableBody");
    var resultCount = document.getElementById("queueResultCount");
    var totalRows = filteredApplications.length;

    if (totalRows === 0) {
        var message = allApplications.length === 0
            ? "No pending applications right now."
            : "No applications match your search.";
        renderEmptyState(message);
        resultCount.textContent = "";
        document.getElementById("queuePagination").style.display = "none";
        return;
    }

    var totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;

    var start = (currentPage - 1) * PAGE_SIZE;
    var pageRows = filteredApplications.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = "";
    pageRows.forEach(function (app) {
        tbody.appendChild(buildRow(app));
    });

    resultCount.textContent = totalRows + (totalRows === 1 ? " application" : " applications");
    renderPaginationControls(totalPages, totalRows, start, pageRows.length);
}

function buildRow(app) {
    var tr = document.createElement("tr");

    var nameTd = document.createElement("td");
    var wrap = document.createElement("div");
    wrap.className = "applicant-cell";

    var avatar = document.createElement("span");
    avatar.className = "applicant-avatar";
    avatar.textContent = getInitials(app.applicant_name || "?");

    var nameBlock = document.createElement("span");
    var nameSpan = document.createElement("span");
    nameSpan.className = "applicant-name";
    nameSpan.textContent = app.applicant_name || "Unknown";
    nameBlock.appendChild(nameSpan);

    wrap.appendChild(avatar);
    wrap.appendChild(nameBlock);
    nameTd.appendChild(wrap);

    var idTd = document.createElement("td");
    idTd.textContent = app.application_id || "—";

    var typeTd = document.createElement("td");
    typeTd.textContent = app.loan_type || "—";

    var amountTd = document.createElement("td");
    amountTd.textContent = app.amount || "—";

    var dateTd = document.createElement("td");
    dateTd.textContent = app.submitted_on || "—";

    var actionTd = document.createElement("td");
    var viewBtn = document.createElement("button");
    viewBtn.className = "view-btn";
    viewBtn.textContent = "View";
    viewBtn.addEventListener("click", function () {
        openViewModal(app.application_id);
    });
    actionTd.appendChild(viewBtn);

    [nameTd, idTd, typeTd, amountTd, dateTd, actionTd].forEach(function (td) {
        tr.appendChild(td);
    });

    return tr;
}

function renderEmptyState(message) {
    var tbody = document.getElementById("queueTableBody");
    tbody.innerHTML = "";
    var tr = document.createElement("tr");
    tr.className = "table-state-row";
    var td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = message;
    tr.appendChild(td);
    tbody.appendChild(tr);
}

function renderPaginationControls(totalPages, totalRows, start, shownCount) {
    var pagination = document.getElementById("queuePagination");
    var info = document.getElementById("paginationInfo");
    var buttonsWrap = document.getElementById("paginationButtons");

    pagination.style.display = "flex";
    info.textContent = "Showing " + (start + 1) + "–" + (start + shownCount) + " of " + totalRows;

    buttonsWrap.innerHTML = "";

    var prevBtn = document.createElement("button");
    prevBtn.textContent = "Previous";
    prevBtn.disabled = currentPage === 1;
    prevBtn.addEventListener("click", function () {
        currentPage -= 1;
        renderTablePage();
    });
    buttonsWrap.appendChild(prevBtn);

    for (var i = 1; i <= totalPages; i++) {
        var pageBtn = document.createElement("button");
        pageBtn.textContent = String(i);
        if (i === currentPage) pageBtn.classList.add("is-current");
        (function (pageNum) {
            pageBtn.addEventListener("click", function () {
                currentPage = pageNum;
                renderTablePage();
            });
        })(i);
        buttonsWrap.appendChild(pageBtn);
    }

    var nextBtn = document.createElement("button");
    nextBtn.textContent = "Next";
    nextBtn.disabled = currentPage === totalPages;
    nextBtn.addEventListener("click", function () {
        currentPage += 1;
        renderTablePage();
    });
    buttonsWrap.appendChild(nextBtn);
}


// ============================================================================
// VIEW MODAL — applicant detail + uploaded documents
// Expected endpoint: GET /api/officer/applications/<application_id>
// Expected shape: {
//   applicant_name, application_id, loan_type, amount, tenure, income, purpose,
//   documents: [{ document_id, doc_type, filename }, ...]
// }
// Documents come from the applicant's user-level DocumentStore uploads —
// not re-submitted per application — so there's no per-document
// verified/unverified flag here, just what was uploaded.
// ============================================================================
async function openViewModal(applicationId) {
    activeApplicationId = applicationId;
    var overlay = document.getElementById("viewModalOverlay");
    overlay.classList.add("is-open");

    document.getElementById("modalApplicantName").textContent = "Loading…";
    document.getElementById("modalApplicationMeta").textContent = "Application " + applicationId;
    document.getElementById("modalLoanType").textContent = "—";
    document.getElementById("modalAmount").textContent = "—";
    document.getElementById("modalTenure").textContent = "—";
    document.getElementById("modalIncome").textContent = "—";
    document.getElementById("modalPurpose").textContent = "—";
    document.getElementById("modalDocList").innerHTML = "";

    try {
        const response = await fetch('http://127.0.0.1:8000/api/officer/applications/' + encodeURIComponent(applicationId), {
            method: 'GET'
        });

        if (!response.ok) {
            throw new Error('Could not load application details');
        }

        const data = await response.json();
        renderModalDetails(data);

    } catch (err) {
        document.getElementById("modalApplicantName").textContent = "Couldn't load this application";
        document.getElementById("modalApplicationMeta").textContent = "Please try again.";
    }
}

function renderModalDetails(data) {
    document.getElementById("modalApplicantName").textContent = data.applicant_name || "Applicant";
    document.getElementById("modalApplicationMeta").textContent = "Application " + (data.application_id || "—");
    document.getElementById("modalLoanType").textContent = data.loan_type || "—";
    document.getElementById("modalAmount").textContent = data.amount || "—";
    document.getElementById("modalTenure").textContent = data.tenure || "—";
    document.getElementById("modalIncome").textContent = data.income || "—";
    document.getElementById("modalPurpose").textContent = data.purpose || "—";

    var docList = document.getElementById("modalDocList");
    docList.innerHTML = "";

    (data.documents || []).forEach(function (doc) {
        var row = document.createElement("div");
        row.className = "eligibility-check-row";

        var label = document.createElement("span");
        label.className = "eligibility-check-label";
        label.textContent = doc.doc_type;

        var link = document.createElement("a");
        link.className = "status-pill is-verified";
        link.textContent = "View";
        link.href = 'http://127.0.0.1:8000/api/documents/file/' + encodeURIComponent(doc.document_id);
        link.target = "_blank";
        link.rel = "noopener";

        row.appendChild(label);
        row.appendChild(link);
        docList.appendChild(row);
    });

    if (!data.documents || data.documents.length === 0) {
        var none = document.createElement("p");
        none.style.fontSize = "13px";
        none.style.color = "var(--muted)";
        none.textContent = "No documents submitted yet.";
        docList.appendChild(none);
    }
}

function closeViewModal() {
    document.getElementById("viewModalOverlay").classList.remove("is-open");
    activeApplicationId = null;
}


// ============================================================================
// FORWARD TO ADMIN
// Expected endpoint: POST /api/officer/applications/<application_id>/forward
// Body: { officer_id, note } — officer_id should be the logged-in
// officer's userid so the admin view can show "Forwarded by <name>".
// The officer's role ends here — basic eligibility/document check only.
// ============================================================================
async function forwardToAdmin() {
    if (!activeApplicationId) return;

    var officerId = sessionStorage.getItem("employeeid");
    var forwardBtn = document.getElementById("modalForwardBtn");
    forwardBtn.disabled = true;
    forwardBtn.textContent = "Forwarding…";

    try {
        const response = await fetch('http://127.0.0.1:8000/api/officer/applications/' + encodeURIComponent(activeApplicationId) + '/forward', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ officer_id: officerId })
        });

        if (!response.ok) {
            throw new Error('Could not forward application');
        }

        // Remove it from the local queue and refresh the table/pagination.
        allApplications = allApplications.filter(function (app) {
            return app.application_id !== activeApplicationId;
        });
        filteredApplications = filteredApplications.filter(function (app) {
            return app.application_id !== activeApplicationId;
        });

        renderQueueChip();
        renderTablePage();
        closeViewModal();

    } catch (err) {
        forwardBtn.textContent = "Couldn't forward — try again";
        setTimeout(function () {
            forwardBtn.textContent = "Forward to Admin";
            forwardBtn.disabled = false;
        }, 1800);
    }
}