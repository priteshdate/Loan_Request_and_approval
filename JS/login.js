let pendingEmployeeId = null;
let otpAttemptsUsed = 0;
const OTP_MAX_ATTEMPTS = 3;
const RESEND_COOLDOWN_SECONDS = 120; // 2 minutes — keep in sync if this ever changes

let resendCooldownRemaining = 0;
let resendTimerInterval = null;

// --- Forgot-password flow state (separate from the login-OTP flow above) ---
let resetEmployeeId = null;
let resetOtpAttemptsUsed = 0;
let resetResendCooldownRemaining = 0;
let resetResendTimerInterval = null;


// ============================================================================
// SHARED HELPERS
// ============================================================================

// Maps a usertype value coming back from the backend to the dashboard page
// it should redirect to. Centralized here so both /login (instant-grant
// case) and /verify-otp (post-OTP case) redirect the same way.
const USERTYPE_REDIRECTS = {
    "admin": "../HTML/admin-dashboard.html",
    "loan officer": "../HTML/officer-dashboard.html",
    "user": "../HTML/user-dashboard.html",
};

function redirectForUsertype(usertype) {
    const target = USERTYPE_REDIRECTS[(usertype || "").toLowerCase()];
    window.location.href = target || "../HTML/user-dashboard.html";
}

// Blocks any keystroke that isn't a digit (or a navigation/editing key) so
// letters never appear in an OTP field in the first place. Paste/autofill
// is still caught by the oninput cleanup set in the HTML on these inputs.
function digitsOnly(e) {
    const allowedKeys = ["Backspace", "Delete", "Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (allowedKeys.includes(e.key)) return;
    if (!/^\d$/.test(e.key)) {
        e.preventDefault();
    }
}

// Updates the "Attempts left: X" line under an OTP field. Goes red once
// the person is down to their last attempt, as an extra visual warning.
function updateAttemptsLeftDisplay(elementId, attemptsUsed) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const remaining = OTP_MAX_ATTEMPTS - attemptsUsed;
    el.textContent = `Attempts left: ${remaining}`;
    el.style.color = remaining <= 1 ? "#ef4444" : "#64748b";
}

// Shows an error message and forces a shake animation to restart even if
// the message text is identical to the previous attempt. Without this,
// a second wrong password/OTP in a row looks "stuck" because display:block
// and the same innerText don't produce any visible change on their own.
function showAttemptError(boxEl, message) {
    if (!boxEl) return;
    boxEl.classList.remove("shake");
    boxEl.innerText = message;
    boxEl.style.display = "block";
    void boxEl.offsetWidth; // force reflow so the animation can restart
    boxEl.classList.add("shake");
}

// Generic 2-minute resend cooldown with a live mm:ss countdown rendered
// directly into the resend link's text. Shared by both the login-OTP
// screen and the forgot-password reset-OTP screen via the isReset flag.
function startResendCooldown(linkId, isReset) {
    if (isReset) {
        resetResendCooldownRemaining = RESEND_COOLDOWN_SECONDS;
        clearInterval(resetResendTimerInterval);
    } else {
        resendCooldownRemaining = RESEND_COOLDOWN_SECONDS;
        clearInterval(resendTimerInterval);
    }

    const link = document.getElementById(linkId);
    if (link) {
        link.style.pointerEvents = "none";
        link.style.opacity = "0.5";
    }

    const tick = () => {
        if (isReset) {
            resetResendCooldownRemaining--;
        } else {
            resendCooldownRemaining--;
        }
        const remaining = isReset ? resetResendCooldownRemaining : resendCooldownRemaining;
        renderResendCountdown(linkId, remaining);

        if (remaining <= 0) {
            clearInterval(isReset ? resetResendTimerInterval : resendTimerInterval);
            if (link) {
                link.style.pointerEvents = "auto";
                link.style.opacity = "1";
            }
        }
    };

    if (isReset) {
        resetResendTimerInterval = setInterval(tick, 1000);
    } else {
        resendTimerInterval = setInterval(tick, 1000);
    }

    renderResendCountdown(linkId, RESEND_COOLDOWN_SECONDS);
}

function renderResendCountdown(linkId, remaining) {
    const link = document.getElementById(linkId);
    if (!link) return;
    if (remaining > 0) {
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        link.innerText = `Resend OTP (${mins}:${secs.toString().padStart(2, "0")})`;
    } else {
        link.innerText = "Resend OTP";
    }
}


// ============================================================================
// LOGIN STEP 1: CREDENTIALS -> ISSUES OTP
// ============================================================================
document
    .getElementById("authBtn")
    .addEventListener("click", validateLogin);
    
async function validateLogin() {
    var userInp = document.getElementById("username").value;
    var passInp = document.getElementById("password").value;
    var errorBox = document.getElementById("errorBox");

    try {
        const response = await fetch('http://127.0.0.1:8000/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userid: userInp,
                password: passInp,
            })
        });

        if (!response.ok) {
            throw new Error('Invalid credentials');
        }
        const data = await response.json();

        if (data.status === "OTP_SENT") {
            errorBox.style.display = "none";
            pendingEmployeeId = data.user_id;
            otpAttemptsUsed = 0;

            resetOtpStepUI();
            updateAttemptsLeftDisplay("otp-attempts-left", 0);
            startResendCooldown("resendBtn", false);

            // Show where the code was sent, using the masked email from the backend
            const subtitle = document.getElementById("subtitle");
            if (subtitle && data.masked_email) {
                subtitle.innerText = `OTP sent to ${data.masked_email}`;
            }

            // Swap the screen layouts visually
            document.getElementById("screen-credentials").classList.add("hidden");
            document.getElementById("screen-otp").classList.remove("hidden");
            return; // Stop execution here so it doesn't redirect to a dashboard yet
        }

        if (data.access === "granted") {
            errorBox.style.display = "none";

            sessionStorage.setItem("userSession", "active");
            sessionStorage.setItem("usertype", data.usertype);
            sessionStorage.setItem("employeeName", data.user_name);
            sessionStorage.setItem("employeeid", data.user_id);
            sessionStorage.setItem("phone", data.phone);
            sessionStorage.setItem("employee_email", data.email_id);

            redirectForUsertype(data.usertype);

        } else {
            throw new Error('Invalid Username or Password. Please try again.');
        }

    } catch (err) {
        showAttemptError(errorBox, "Invalid Username or Password. Please try again.");
    }
}


// ============================================================================
// LOGIN STEP 2: VERIFY OTP -> GRANTS ACCESS
// ============================================================================
async function validateOTP() {
    var otpInp = document.getElementById("otpCode").value;
    var errorBox2 = document.getElementById("errorBox2");

    if (!/^\d{6}$/.test(otpInp)) {
        showAttemptError(errorBox2, "Please enter a valid 6-digit code.");
        return;
    }

    // Client-side guard: don't even hit the API once the budget's gone.
    // (Backend still enforces this independently via OTPTries / 429.)
    if (otpAttemptsUsed >= OTP_MAX_ATTEMPTS) {
        lockOtpStepUI("Too many attempts. Please request a new code.");
        return;
    }

    try {
        const response = await fetch('http://127.0.0.1:8000/verify-otp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userid: pendingEmployeeId,
                user_otp: otpInp
            })
        });

        const data = await response.json();

        if (response.ok && data.access === "granted") {
            errorBox2.style.display = "none";

            sessionStorage.setItem("userSession", "active");
            sessionStorage.setItem("usertype", data.usertype);
            sessionStorage.setItem("employeeName", data.user_name);
            sessionStorage.setItem("employeeid", data.user_id);
            sessionStorage.setItem("phone", data.phone);
            sessionStorage.setItem("employee_email", data.email_id);

            redirectForUsertype(data.usertype);
            return;
        }

        // Wrong code (401) or server-confirmed lockout (429) or expired/missing (400)
        otpAttemptsUsed += 1;
        updateAttemptsLeftDisplay("otp-attempts-left", otpAttemptsUsed);

        if (response.status === 429 || otpAttemptsUsed >= OTP_MAX_ATTEMPTS) {
            lockOtpStepUI(data.detail || "Too many attempts. Please request a new code.");
            return;
        }

        throw new Error(data.detail || 'Invalid or expired code. Please try again.');

    } catch (err) {
        showAttemptError(errorBox2, err.message || "Invalid or expired code. Please try again.");
    }
}


// ============================================================================
// RESEND OTP (login flow)
// ============================================================================
async function resendOTPCode() {
    var errorBox2 = document.getElementById("errorBox2");

    if (!pendingEmployeeId || resendCooldownRemaining > 0) {
        return; // still cooling down, or no active OTP session
    }

    try {
        const response = await fetch('http://127.0.0.1:8000/resend-otp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userid: pendingEmployeeId
            })
        });

        const data = await response.json();

        if (response.ok && data.status === "OTP_SENT") {
            // A fresh OTP means a fresh attempt budget — unlock the step.
            otpAttemptsUsed = 0;
            resetOtpStepUI();
            updateAttemptsLeftDisplay("otp-attempts-left", 0);
            startResendCooldown("resendBtn", false);

            const subtitle = document.getElementById("subtitle");
            if (subtitle && data.masked_email) {
                subtitle.innerText = `OTP sent to ${data.masked_email}`;
            }
        } else {
            throw new Error(data.detail || "Couldn't resend the code. Please try again.");
        }
    } catch (err) {
        if (errorBox2) {
            showAttemptError(errorBox2, err.message || "Couldn't resend the code. Please try again.");
        }
    }
}


// ============================================================================
// LOCKOUT UI HELPERS (login-OTP screen)
// ============================================================================
function lockOtpStepUI(message) {
    var errorBox2 = document.getElementById("errorBox2");
    var otpInput = document.getElementById("otpCode");
    var verifyBtn = document.getElementById("verifyBtn");

    showAttemptError(errorBox2, message);
    if (otpInput) {
        otpInput.disabled = true;
    }
    if (verifyBtn) {
        verifyBtn.disabled = true;
    }
}

function resetOtpStepUI() {
    var errorBox2 = document.getElementById("errorBox2");
    var otpInput = document.getElementById("otpCode");
    var verifyBtn = document.getElementById("verifyBtn");

    if (errorBox2) {
        errorBox2.style.display = "none";
        errorBox2.innerText = "";
        errorBox2.classList.remove("shake");
    }
    if (otpInput) {
        otpInput.disabled = false;
        otpInput.value = "";
    }
    if (verifyBtn) {
        verifyBtn.disabled = false;
    }
}


// ============================================================================
// FORGOT PASSWORD: SCREEN NAVIGATION
// ============================================================================
function showForgotPasswordScreen() {
    document.getElementById("screen-credentials").classList.add("hidden");
    document.getElementById("screen-otp").classList.add("hidden");
    document.getElementById("screen-forgot").classList.remove("hidden");

    var errorBox3 = document.getElementById("errorBox3");
    if (errorBox3) {
        errorBox3.style.display = "none";
    }

    var subtitle = document.getElementById("subtitle");
    if (subtitle) {
        subtitle.innerText = "Enter your username to reset your password";
    }
}

function backToLoginScreen() {
    document.getElementById("screen-forgot").classList.add("hidden");
    document.getElementById("screen-reset-otp").classList.add("hidden");
    document.getElementById("screen-reset-password").classList.add("hidden");
    document.getElementById("screen-otp").classList.add("hidden");
    document.getElementById("screen-credentials").classList.remove("hidden");

    var subtitle = document.getElementById("subtitle");
    if (subtitle) {
        subtitle.innerText = "Please enter your credentials";
    }

    // Stop any running reset-OTP countdown so it doesn't keep ticking
    // (and writing to a now-hidden screen) after navigating away.
    clearInterval(resetResendTimerInterval);
    resetResendCooldownRemaining = 0;

    // Clear sensitive fields/state from the reset flow
    resetEmployeeId = null;
    resetOtpAttemptsUsed = 0;
    var forgotUsername = document.getElementById("forgotUsername");
    if (forgotUsername) forgotUsername.value = "";
    var resetOtpCode = document.getElementById("resetOtpCode");
    if (resetOtpCode) resetOtpCode.value = "";
    var newPasswordInput = document.getElementById("newPassword");
    if (newPasswordInput) newPasswordInput.value = "";
    var confirmPasswordInput = document.getElementById("confirmPassword");
    if (confirmPasswordInput) confirmPasswordInput.value = "";
}


// ============================================================================
// FORGOT PASSWORD STEP 1: USERNAME -> ISSUES OTP
// ============================================================================
async function submitForgotPassword() {
    var usernameInp = document.getElementById("forgotUsername").value;
    var errorBox3 = document.getElementById("errorBox3");

    try {
        const response = await fetch('http://127.0.0.1:8000/forgot-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username: usernameInp
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "Username not found.");
        }

        if (data.status === "OTP_SENT") {
            errorBox3.style.display = "none";
            resetEmployeeId = data.user_id;
            resetOtpAttemptsUsed = 0;

            document.getElementById("screen-forgot").classList.add("hidden");
            document.getElementById("screen-reset-otp").classList.remove("hidden");

            resetResetOtpStepUI();
            updateAttemptsLeftDisplay("reset-otp-attempts-left", 0);
            startResendCooldown("resendBtn2", true);

            var subtitle = document.getElementById("subtitle");
            if (subtitle && data.masked_email) {
                subtitle.innerText = `OTP sent to ${data.masked_email}`;
            }
        }
    } catch (err) {
        if (errorBox3) {
            errorBox3.innerText = err.message || "Couldn't send OTP. Please try again.";
            errorBox3.style.display = "block";
        }
    }
}


// ============================================================================
// FORGOT PASSWORD STEP 2: VERIFY OTP (does NOT log the user in)
// ============================================================================
async function verifyResetOTP() {
    var otpInp = document.getElementById("resetOtpCode").value;
    var errorBox4 = document.getElementById("errorBox4");

    if (!/^\d{6}$/.test(otpInp)) {
        showAttemptError(errorBox4, "Please enter a valid 6-digit code.");
        return;
    }

    if (resetOtpAttemptsUsed >= OTP_MAX_ATTEMPTS) {
        lockResetOtpStepUI("Too many attempts. Please request a new code.");
        return;
    }

    try {
        const response = await fetch('http://127.0.0.1:8000/verify-reset-otp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userid: resetEmployeeId,
                user_otp: otpInp
            })
        });

        const data = await response.json();

        if (response.ok && data.status === "success") {
            errorBox4.style.display = "none";
            clearInterval(resetResendTimerInterval);

            document.getElementById("screen-reset-otp").classList.add("hidden");
            document.getElementById("screen-reset-password").classList.remove("hidden");

            var resetEmpIdField = document.getElementById("resetEmployeeIdDisplay");
            if (resetEmpIdField) {
                resetEmpIdField.value = data.userid;
            }

            var subtitle = document.getElementById("subtitle");
            if (subtitle) {
                subtitle.innerText = "Choose a new password";
            }
            return;
        }

        resetOtpAttemptsUsed += 1;
        updateAttemptsLeftDisplay("reset-otp-attempts-left", resetOtpAttemptsUsed);

        if (response.status === 429 || resetOtpAttemptsUsed >= OTP_MAX_ATTEMPTS) {
            lockResetOtpStepUI(data.detail || "Too many attempts. Please request a new code.");
            return;
        }

        throw new Error(data.detail || "Invalid or expired code. Please try again.");

    } catch (err) {
        showAttemptError(errorBox4, err.message || "Invalid or expired code. Please try again.");
    }
}


// ============================================================================
// RESEND OTP (forgot-password flow)
// ============================================================================
async function resendResetOTPCode() {
    var errorBox4 = document.getElementById("errorBox4");

    if (!resetEmployeeId || resetResendCooldownRemaining > 0) {
        return;
    }

    try {
        const response = await fetch('http://127.0.0.1:8000/resend-otp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userid: resetEmployeeId
            })
        });

        const data = await response.json();

        if (response.ok && data.status === "OTP_SENT") {
            resetOtpAttemptsUsed = 0;
            resetResetOtpStepUI();
            updateAttemptsLeftDisplay("reset-otp-attempts-left", 0);
            startResendCooldown("resendBtn2", true);

            var subtitle = document.getElementById("subtitle");
            if (subtitle && data.masked_email) {
                subtitle.innerText = `OTP sent to ${data.masked_email}`;
            }
        } else {
            throw new Error(data.detail || "Couldn't resend the code. Please try again.");
        }
    } catch (err) {
        if (errorBox4) {
            showAttemptError(errorBox4, err.message || "Couldn't resend the code. Please try again.");
        }
    }
}


// ============================================================================
// RESET-OTP-STEP LOCKOUT UI HELPERS (mirrors lockOtpStepUI/resetOtpStepUI)
// ============================================================================
function lockResetOtpStepUI(message) {
    var errorBox4 = document.getElementById("errorBox4");
    var resetOtpInput = document.getElementById("resetOtpCode");
    var resetVerifyBtn = document.getElementById("resetVerifyBtn");

    showAttemptError(errorBox4, message);
    if (resetOtpInput) {
        resetOtpInput.disabled = true;
    }
    if (resetVerifyBtn) {
        resetVerifyBtn.disabled = true;
    }
}

function resetResetOtpStepUI() {
    var errorBox4 = document.getElementById("errorBox4");
    var resetOtpInput = document.getElementById("resetOtpCode");
    var resetVerifyBtn = document.getElementById("resetVerifyBtn");

    if (errorBox4) {
        errorBox4.style.display = "none";
        errorBox4.innerText = "";
        errorBox4.classList.remove("shake");
    }
    if (resetOtpInput) {
        resetOtpInput.disabled = false;
        resetOtpInput.value = "";
    }
    if (resetVerifyBtn) {
        resetVerifyBtn.disabled = false;
    }
}


// ============================================================================
// FORGOT PASSWORD STEP 3: SET NEW PASSWORD
// ============================================================================
const PASSWORD_RULES = [
    { id: "rule-length", test: (pw) => pw.length >= 8, label: "At least 8 characters" },
    { id: "rule-letter", test: (pw) => /[A-Za-z]/.test(pw), label: "At least one letter" },
    { id: "rule-number", test: (pw) => /\d/.test(pw), label: "At least one number" },
    { id: "rule-special", test: (pw) => /[!@#$%^&*()\-_=+\[\]{};:'",.<>/?\\|`~]/.test(pw), label: "At least one special character" },
];

// Live validation: called on every keystroke in the New Password field.
// Each rule line turns green once satisfied, red while not yet satisfied.
function checkPasswordRules() {
    var pw = document.getElementById("newPassword").value;

    PASSWORD_RULES.forEach(function (rule) {
        var el = document.getElementById(rule.id);
        if (!el) return;
        if (rule.test(pw)) {
            el.style.color = "#16a34a"; // green
        } else {
            el.style.color = "#ef4444"; // red
        }
    });

    checkPasswordsMatch();
}

function checkPasswordsMatch() {
    var pw = document.getElementById("newPassword").value;
    var confirmPw = document.getElementById("confirmPassword").value;
    var matchMsg = document.getElementById("passwordMatchMsg");

    if (!matchMsg) return;

    if (confirmPw.length === 0) {
        matchMsg.innerText = "";
        return;
    }

    if (pw === confirmPw) {
        matchMsg.style.color = "#16a34a"; // green
        matchMsg.innerText = "Passwords match";
    } else {
        matchMsg.style.color = "#ef4444"; // red
        matchMsg.innerText = "Passwords do not match";
    }
}

function allPasswordRulesPass(pw) {
    return PASSWORD_RULES.every(function (rule) {
        return rule.test(pw);
    });
}

async function submitNewPassword() {
    var newPw = document.getElementById("newPassword").value;
    var confirmPw = document.getElementById("confirmPassword").value;
    var errorBox5 = document.getElementById("errorBox5");

    if (errorBox5) {
        errorBox5.style.display = "none";
    }

    if (newPw !== confirmPw) {
        if (errorBox5) {
            errorBox5.innerText = "Passwords do not match.";
            errorBox5.style.display = "block";
        }
        return;
    }

    if (!allPasswordRulesPass(newPw)) {
        if (errorBox5) {
            errorBox5.innerText = "Password does not meet all requirements.";
            errorBox5.style.display = "block";
        }
        return;
    }

    try {
        const response = await fetch('http://127.0.0.1:8000/reset-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userid: resetEmployeeId,
                new_password: newPw,
                confirm_password: confirmPw
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "Couldn't reset password. Please try again.");
        }


        backToLoginScreen();
        var subtitle = document.getElementById("subtitle");
        if (subtitle) {
            subtitle.innerText = "Password reset successful. Please sign in.";
        }

    } catch (err) {
        if (errorBox5) {
            errorBox5.innerText = err.message || "Couldn't reset password. Please try again.";
            errorBox5.style.display = "block";
        }
    }
}


// ============================================================================
// SIGN UP: SCREEN NAVIGATION (UI ONLY — backend wiring to follow later)
// ============================================================================
function showSignUpScreen() {
    document.getElementById("screen-credentials").classList.add("hidden");
    document.getElementById("screen-signup").classList.remove("hidden");

    var errorBoxSignup = document.getElementById("errorBoxSignup");
    if (errorBoxSignup) {
        errorBoxSignup.style.display = "none";
    }

    var subtitle = document.getElementById("subtitle");
    if (subtitle) {
        subtitle.innerText = "Create your account";
    }
}

function backToLoginFromSignUp() {
    document.getElementById("screen-signup").classList.add("hidden");
    document.getElementById("screen-credentials").classList.remove("hidden");

    var subtitle = document.getElementById("subtitle");
    if (subtitle) {
        subtitle.innerText = "Please enter your credentials";
    }

    // Clear the sign-up fields on the way out
    ["signupFullName", "signupEmail", "signupUsername", "signupPassword", "signupConfirmPassword"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = "";
    });

    var errorBoxSignup = document.getElementById("errorBoxSignup");
    if (errorBoxSignup) {
        errorBoxSignup.style.display = "none";
    }
}

// Placeholder only — no API call yet. This will be wired up to a real
// signup endpoint (and DB insert) in a later update.
function submitSignUp() {
    var errorBoxSignup = document.getElementById("errorBoxSignup");
    var fullName = document.getElementById("signupFullName").value;
    var email = document.getElementById("signupEmail").value;
    var username = document.getElementById("signupUsername").value;
    var password = document.getElementById("signupPassword").value;
    var confirmPassword = document.getElementById("signupConfirmPassword").value;

    if (errorBoxSignup) {
        errorBoxSignup.style.display = "none";
    }

    if (!fullName || !email || !username || !password || !confirmPassword) {
        if (errorBoxSignup) {
            errorBoxSignup.innerText = "Please fill in all fields.";
            errorBoxSignup.style.display = "block";
        }
        return;
    }

    if (password !== confirmPassword) {
        if (errorBoxSignup) {
            errorBoxSignup.innerText = "Passwords do not match.";
            errorBoxSignup.style.display = "block";
        }
        return;
    }

    // TODO: replace this with a real fetch() to a /signup endpoint once
    // the backend + DB insert (Prac stored procedure) is ready.
    alert("Sign up is not yet connected to the system. This will be enabled in a future update.");
}