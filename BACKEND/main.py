import os
import hashlib
import pyodbc
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, EmailStr
import plotly.express as px
import smtplib
from email.mime.text import MIMEText
import re
import io

load_dotenv()
DB_SERVER = os.getenv("DB_SERVER")
DB_DATABASE = os.getenv("DB_DATABASE")
DB_USERNAME = os.getenv("DB_USERNAME")
DB_PASSWORD = os.getenv("DB_PASSWORD")
HELPDESK_RECIPIENT_EMAIL = os.getenv("HELPDESK_RECIPIENT_EMAIL")

CONN_STRING = (
    f"DRIVER={{ODBC Driver 17 for SQL Server}};"
    f"SERVER={DB_SERVER};"
    f"DATABASE={DB_DATABASE};"
    # f"UID={DB_USERNAME};"
    # f"PWD={DB_PASSWORD};"
    f"Trusted_Connection=yes;"
)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

OTP_MAX_ATTEMPTS = 3

VALID_USERTYPES = {"admin", "loan officer", "user"}

# Document types shown on the user dashboard's Documents tab. Not a hard
# DB-level constraint (DocType is free text), but the frontend uses this
# fixed set of three to gate "Apply for Loan" until all three are present.
REQUIRED_DOC_TYPES = ["Identity Proof", "Address Proof", "Income Proof"]

# ─── MODELS ───────────────────────────────────────────────────────────────────

class LoginEnvelope(BaseModel):
    userid: str
    password: str


class Employee(BaseModel):
    username: str = Field(
        ...,
        pattern=r"^[A-Za-z\s]+$",
        description="Name must contain only letters and spaces"
    )
    phone: str = Field(
        ...,
        pattern=r"^\d{10}$",
        description="Phone number must be exactly 10 digits"
    )
    email: str = Field(
        ...,
        pattern=r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.com$",
        description="Email must be valid and end with .com"
    )
    usertype: str = Field(
        ...,
        description="One of: admin, loan officer, user"
    )


class VerifyOtpRequest(BaseModel):
    userid: str
    user_otp: str  # matches what login.js sends as userOtp


class ResendOtpRequest(BaseModel):
    userid: str


class ForgotPasswordRequest(BaseModel):
    username: str


class VerifyResetOtpRequest(BaseModel):
    userid: str
    user_otp: str


class ResetPasswordRequest(BaseModel):
    userid: str
    new_password: str = Field(..., min_length=8)
    confirm_password: str = Field(..., min_length=8)


class ChangePasswordRequest(BaseModel):
    userid: str
    old_password: str
    new_password: str = Field(..., min_length=8)
    confirm_password: str = Field(..., min_length=8)

class SignUpRequest(BaseModel):
    full_name: str = Field(
        ...,
        pattern=r"^[A-Za-z\s]+$",
        description="Name must contain only letters and spaces"
    )
    email_id: str = Field(
        ...,
        pattern=r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.com$",
        description="Email must be valid and end with .com"
    )
    username: str = Field(..., min_length=3)
    password: str = Field(..., min_length=8)
    confirm_password: str = Field(..., min_length=8)


class VerifySignUpOtpRequest(BaseModel):
    userid: str
    user_otp: str


# --- User dashboard: Apply for Loan ---

class ApplyLoanRequest(BaseModel):
    userid: str
    loan_type: str
    amount: str
    tenure: str
    purpose: str = Field(..., min_length=1)


# --- Loan Approval Officer dashboard ---

class ForwardApplicationRequest(BaseModel):
    officer_id: str | None = None
    note: str | None = None


# --- Admin dashboard ---

class ApplicationDecisionRequest(BaseModel):
    decision: str = Field(..., pattern=r"^(approved|rejected)$")
    reason: str | None = None
    admin_id: str | None = None


# ─── DB HELPER ────────────────────────────────────────────────────────────────

def get_conn():
    return pyodbc.connect(CONN_STRING)


def hash_password(plain_password: str) -> str:
    return hashlib.sha256(plain_password.encode("utf-8")).hexdigest()


def mask_email(email: str) -> str:
    try:
        local, domain = email.split("@", 1)
        masked_local = (local[0] + "***") if local else "***"
        return f"{masked_local}@{domain}"
    except ValueError:
        return "***"


def validate_password_strength(password: str) -> None:

    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters long.")
    if not re.search(r"[A-Za-z]", password):
        raise HTTPException(status_code=400, detail="Password must contain at least one letter.")
    if not re.search(r"\d", password):
        raise HTTPException(status_code=400, detail="Password must contain at least one number.")
    if not re.search(r"[!@#$%^&*()\-_=+\[\]{};:'\",.<>/?\\|`~]", password):
        raise HTTPException(status_code=400, detail="Password must contain at least one special character.")


def issue_otp_for_employee(cursor, userid: str) -> None:
    cursor.execute(
        "{CALL dbo.SendOtpEmail (?)}",
        (userid,)
    )


# ─── LOGIN: STEP 1 (credentials -> issues OTP) ─────────────────────────────────

@app.post("/login")
def check_login(data: LoginEnvelope):
    try:
        conn = get_conn()
        cursor = conn.cursor()

        cursor.execute("{CALL dbo.loanverifylogin (?, ?)}", (data.userid, data.password))
        user_record = cursor.fetchone()

        if not (user_record and user_record[0].lower() == "verified"):
            conn.close()
            raise HTTPException(status_code=401, detail="Invalid credentials")

        cursor.execute("{CALL dbo.GetUserDetails (?)}", (data.userid,))
        user_record = cursor.fetchone()

        user_id = str(user_record[0]).strip()
        email_id = str(user_record[2]).strip()

        # Instead of granting access immediately, issue an OTP and stop here.
        issue_otp_for_employee(cursor, user_id)
        conn.commit()
        conn.close()

        return {
            "status": "OTP_SENT",
            "user_id": user_id,
            "masked_email": mask_email(email_id),
        }

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── LOGIN: STEP 2 (verify OTP -> grants access) ─────────────────────────
# usertype is read straight off User_data and returned as-is so the
# frontend can redirect to the right dashboard (admin / loan officer / user).
@app.post("/verify-otp")
def verify_otp(req: VerifyOtpRequest):
    try:
        conn = get_conn()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT OTPHash, OTPExpiry, OTPTries FROM dbo.User_data WHERE userid = ?",
            (req.userid,)
        )
        row = cursor.fetchone()

        if row is None:
            conn.close()
            raise HTTPException(status_code=404, detail="Employee not found")

        stored_otp, expires_at, tries = row

        if stored_otp is None or expires_at is None:
            conn.close()
            raise HTTPException(status_code=400, detail="No active OTP. Please request a new one.")

        if tries is not None and tries >= OTP_MAX_ATTEMPTS:
            conn.close()
            raise HTTPException(status_code=429, detail="Too many attempts. Please request a new code.")


        if datetime.now(timezone.utc).replace(tzinfo=None) > expires_at:
            conn.close()
            raise HTTPException(status_code=400, detail="Code expired. Please request a new one.")

        # Plaintext comparison — OTPHash now holds the plain 6-digit code,
        # not a hash. Strip both sides to avoid whitespace mismatches.
        if req.user_otp.strip() != str(stored_otp).strip():
            cursor.execute(
                "UPDATE dbo.User_data SET OTPTries = OTPTries + 1 WHERE userid = ?",
                (req.userid,)
            )
            conn.commit()
            conn.close()
            raise HTTPException(status_code=401, detail="Invalid code. Please try again.")

        # Correct code — clear OTP fields so it can't be reused/replayed
        cursor.execute(
            "UPDATE dbo.User_data SET OTPHash = NULL, OTPExpiry = NULL, OTPTries = 0 "
            "WHERE userid = ?",
            (req.userid,)
        )

        # Fetch and return everything the original /login granted on success
        cursor.execute("{CALL dbo.GetUserDetails (?)}", (req.userid,))
        user_record = cursor.fetchone()

        username  = str(user_record[1]).strip()
        user_id    = str(user_record[0]).strip()
        phone     = str(user_record[3]).strip()
        email_id  = str(user_record[2]).strip()
        usertype  = str(user_record[4]).strip()

        conn.commit()
        conn.close()

        return {
            "status": "success",
            "access": "granted",
            "user_name": username,
            "user_id": user_id,
            "phone": phone,
            "email_id": email_id,
            "usertype": usertype,
        }

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── RESEND OTP ─────────────────────────────────────────────────────────────────

@app.post("/resend-otp")
def resend_otp(req: ResendOtpRequest):
    try:
        conn = get_conn()
        cursor = conn.cursor()

        cursor.execute("{CALL dbo.GetUserDetails (?)}", (req.userid,))
        user_record = cursor.fetchone()

        if user_record is None:
            conn.close()
            raise HTTPException(status_code=404, detail="Employee not found")

        email_id = str(user_record[2]).strip()

        issue_otp_for_employee(cursor, req.userid)
        conn.commit()
        conn.close()

        return {"status": "OTP_SENT", "masked_email": mask_email(email_id)}

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── FORGOT PASSWORD: STEP 1 (username -> issues OTP) ─────────────────────────

@app.post("/forgot-password")
def forgot_password(req: ForgotPasswordRequest):
    try:
        conn = get_conn()
        cursor = conn.cursor()
        cursor.execute("{CALL dbo.GetUserDetails (?)}", (req.username,))
        user_record = cursor.fetchone()

        if user_record is None:
            conn.close()
            raise HTTPException(status_code=404, detail="Username not found")

        user_id = str(user_record[0]).strip()
        email_id = str(user_record[2]).strip()

        # Same OTP proc/columns as login OTP (OTPHash/OTPExpiry/OTPTries reused).
        issue_otp_for_employee(cursor, user_id)
        conn.commit()
        conn.close()

        return {
            "status": "OTP_SENT",
            "user_id": user_id,
            "masked_email": mask_email(email_id),
        }

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── FORGOT PASSWORD: STEP 2 (verify OTP -> unlocks reset form) ────────────────

@app.post("/verify-reset-otp")
def verify_reset_otp(req: VerifyResetOtpRequest):
    try:
        conn = get_conn()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT OTPHash, OTPExpiry, OTPTries FROM dbo.User_data WHERE userid = ?",
            (req.userid,)
        )
        row = cursor.fetchone()

        if row is None:
            conn.close()
            raise HTTPException(status_code=404, detail="Employee not found")

        stored_otp, expires_at, tries = row

        if stored_otp is None or expires_at is None:
            conn.close()
            raise HTTPException(status_code=400, detail="No active OTP. Please request a new one.")

        if tries is not None and tries >= OTP_MAX_ATTEMPTS:
            conn.close()
            raise HTTPException(status_code=429, detail="Too many attempts. Please request a new code.")

        if datetime.now(timezone.utc).replace(tzinfo=None) > expires_at:
            conn.close()
            raise HTTPException(status_code=400, detail="Code expired. Please request a new one.")

        if req.user_otp.strip() != str(stored_otp).strip():
            cursor.execute(
                "UPDATE dbo.User_data SET OTPTries = OTPTries + 1 WHERE userid = ?",
                (req.userid,)
            )
            conn.commit()
            conn.close()
            raise HTTPException(status_code=401, detail="Invalid code. Please try again.")

        cursor.execute(
            "UPDATE dbo.User_data SET OTPHash = NULL, OTPExpiry = NULL, OTPTries = 0 "
            "WHERE userid = ?",
            (req.userid,)
        )
        conn.commit()
        conn.close()

        return {
            "status": "success",
            "userid": req.userid,
        }

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── FORGOT PASSWORD: STEP 3 (set new password) ────────────────────────────────

@app.post("/reset-password")
def reset_password(req: ResetPasswordRequest):
    if req.new_password != req.confirm_password:
        raise HTTPException(status_code=400, detail="Passwords do not match.")

    validate_password_strength(req.new_password)

    try:
        conn = get_conn()
        cursor = conn.cursor()

        # Block reuse of the current password.
        cursor.execute(
            "SELECT password_hash FROM User_data WHERE userid = ?",
            (req.userid,)
        )
        row = cursor.fetchone()

        if row is None:
            conn.close()
            raise HTTPException(status_code=404, detail="Employee not found")

        current_hash = row[0]
        new_hash = hash_password(req.new_password)

        if current_hash is not None and str(current_hash).strip() == new_hash:
            conn.close()
            raise HTTPException(status_code=400, detail="New password cannot be the same as your previous password.")

        cursor.execute("""
            UPDATE User_data
            SET password_hash = ?
            WHERE userid = ?
        """, (new_hash, req.userid))

        if cursor.rowcount == 0:
            conn.close()
            raise HTTPException(status_code=404, detail="Employee not found")

        conn.commit()
        conn.close()

        return {"status": "success", "message": "Password reset successfully"}

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── CHANGE PASSWORD (logged-in user, from change-password modal) ─────────────

@app.post("/change-password")
def change_password(req: ChangePasswordRequest):
    if req.new_password != req.confirm_password:
        raise HTTPException(status_code=400, detail="Passwords do not match.")

    validate_password_strength(req.new_password)

    try:
        conn = get_conn()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT password_hash FROM dbo.User_data WHERE userid = ?",
            (req.userid,)
        )
        row = cursor.fetchone()

        if row is None:
            conn.close()
            raise HTTPException(status_code=404, detail="Employee not found")

        current_hash = row[0]
        old_hash = hash_password(req.old_password)

        if current_hash is None or str(current_hash).strip() != old_hash:
            conn.close()
            raise HTTPException(status_code=401, detail="Current password is incorrect.")

        new_hash = hash_password(req.new_password)

        if str(current_hash).strip() == new_hash:
            conn.close()
            raise HTTPException(status_code=400, detail="New password cannot be the same as your previous password.")

        cursor.execute(
            "UPDATE dbo.User_data SET password_hash = ? WHERE userid = ?",
            (new_hash, req.userid)
        )

        if cursor.rowcount == 0:
            conn.close()
            raise HTTPException(status_code=404, detail="Employee not found")

        conn.commit()
        conn.close()

        return {"status": "success", "message": "Password changed successfully"}

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))

@app.post("/signup")
def sign_up(req: SignUpRequest):
    if req.password != req.confirm_password:
        raise HTTPException(status_code=400, detail="Passwords do not match.")

    validate_password_strength(req.password)

    try:
        conn = get_conn()
        cursor = conn.cursor()

        # Reuses verifylogin-style lookups to reject duplicates up front.
        cursor.execute(
            "SELECT userid FROM dbo.User_data WHERE username = ? OR email = ?",
            (req.username, req.email_id)
        )
        existing = cursor.fetchone()

        if existing is not None:
            conn.close()
            raise HTTPException(status_code=409, detail="Username or email is already registered.")

        password_hash = hash_password(req.password)
        default_usertype = "user"

        cursor.execute(
            "{CALL dbo.CreateSignUpAccount (?, ?, ?, ?, ?)}",
            (req.full_name, req.email_id, req.username, password_hash, default_usertype)
        )
        new_account = cursor.fetchone()

        if new_account is None:
            conn.close()
            raise HTTPException(status_code=500, detail="Could not create account.")

        user_id = str(new_account[0]).strip()

        issue_otp_for_employee(cursor, user_id)
        conn.commit()
        conn.close()

        return {
            "status": "OTP_SENT",
            "user_id": user_id,
            "masked_email": mask_email(req.email_id),
        }

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── SIGN UP: STEP 2 (verify OTP -> activates account) ─────────────────────────

@app.post("/verify-signup-otp")
def verify_signup_otp(req: VerifySignUpOtpRequest):
    try:
        conn = get_conn()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT OTPHash, OTPExpiry, OTPTries FROM dbo.User_data WHERE userid = ?",
            (req.userid,)
        )
        row = cursor.fetchone()

        if row is None:
            conn.close()
            raise HTTPException(status_code=404, detail="Employee not found")

        stored_otp, expires_at, tries = row

        if stored_otp is None or expires_at is None:
            conn.close()
            raise HTTPException(status_code=400, detail="No active OTP. Please request a new one.")

        if tries is not None and tries >= OTP_MAX_ATTEMPTS:
            conn.close()
            raise HTTPException(status_code=429, detail="Too many attempts. Please request a new code.")

        if datetime.now(timezone.utc).replace(tzinfo=None) > expires_at:
            conn.close()
            raise HTTPException(status_code=400, detail="Code expired. Please request a new one.")

        if req.user_otp.strip() != str(stored_otp).strip():
            cursor.execute(
                "UPDATE dbo.User_data SET OTPTries = OTPTries + 1 WHERE userid = ?",
                (req.userid,)
            )
            conn.commit()
            conn.close()
            raise HTTPException(status_code=401, detail="Invalid code. Please try again.")

        # Correct code — clear OTP fields and flag the account as verified.
        cursor.execute(
            "UPDATE dbo.User_data SET OTPHash = NULL, OTPExpiry = NULL, OTPTries = 0, "
            "IsVerified = 1 WHERE userid = ?",
            (req.userid,)
        )
        conn.commit()
        conn.close()

        return {"status": "success", "userid": req.userid}

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── ACCOUNT DROPDOWN: lightweight profile lookup ──────────────────────────
# Used by the account-chip dropdown on every dashboard. Returns just enough
# to render the popover without re-deriving anything from sessionStorage —
# sessionStorage is still the fast path; this exists so the dropdown can
# refresh live values (e.g. if usertype/email changed) without forcing a
# fresh login.

@app.get("/api/users/{userid}/profile")
def get_user_profile(userid: str):
    try:
        conn = get_conn()
        cursor = conn.cursor()

        cursor.execute("{CALL dbo.GetUserDetails (?)}", (userid,))
        user_record = cursor.fetchone()
        conn.close()

        if user_record is None:
            raise HTTPException(status_code=404, detail="User not found")

        return {
            "userid": str(user_record[0]).strip(),
            "username": str(user_record[1]).strip(),
            "email": str(user_record[2]).strip(),
            "phone": str(user_record[3]).strip(),
            "usertype": str(user_record[4]).strip(),
        }

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── DOCUMENTS: upload (user-level, not application-level) ────────────────────
# Documents belong to the user, uploaded once on the Documents tab, and are
# picked up by every loan application that user submits afterward — they
# are not re-uploaded per application. DocType is free text (no fixed set
# enforced at the DB layer); the frontend currently offers Identity Proof,
# Address Proof, Income Proof as a default set of options.

@app.post("/api/documents/upload")
async def upload_document(
    userid: str = Form(...),
    doc_type: str = Form(...),
    file: UploadFile = File(...)
):
    file_bytes = await file.read()

    try:
        conn = get_conn()
        cursor = conn.cursor()

        # UploadUserDocument is expected to insert into DocumentStore
        # (DocumentID identity, UserID, DocType, FileName, FileBinary,
        # UploadedOn = GETDATE()) and return the new DocumentID.
        cursor.execute(
            "{CALL dbo.UploadUserDocument (?, ?, ?, ?)}",
            (userid, doc_type, file.filename, file_bytes)
        )
        new_row = cursor.fetchone()
        conn.commit()
        conn.close()

        document_id = str(new_row[0]).strip() if new_row else None

        return {
            "status": "success",
            "document_id": document_id,
            "doc_type": doc_type,
            "filename": file.filename,
        }

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── DOCUMENTS: list (metadata only, no binary) ────────────────────────────────
# Powers both the user's own Documents tab and the officer/admin detail
# views — same endpoint, since "this user's uploaded documents" is the
# same list regardless of who's looking at it.

@app.get("/api/documents/{userid}")
def list_user_documents(userid: str):
    try:
        conn = get_conn()
        cursor = conn.cursor()

        # GetUserDocuments expected column order:
        # [0] document_id  [1] doc_type  [2] filename  [3] uploaded_on
        cursor.execute("{CALL dbo.GetUserDocuments (?)}", (userid,))
        rows = cursor.fetchall()
        conn.close()

        documents = [
            {
                "document_id": str(row[0]).strip(),
                "doc_type": str(row[1]).strip(),
                "filename": str(row[2]).strip(),
                "uploaded_on": str(row[3]).strip() if row[3] else None,
            }
            for row in rows
        ]

        uploaded_types = {doc["doc_type"] for doc in documents}
        missing_required = [t for t in REQUIRED_DOC_TYPES if t not in uploaded_types]

        return {
            "documents": documents,
            "required_doc_types": REQUIRED_DOC_TYPES,
            "missing_required": missing_required,
            "all_required_present": len(missing_required) == 0,
        }

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── DOCUMENTS: download a single file's binary ────────────────────────────────
# Used by officer/admin "view document" links, and by the user re-viewing
# something they uploaded earlier.

@app.get("/api/documents/file/{document_id}")
def download_document(document_id: str):
    try:
        conn = get_conn()
        cursor = conn.cursor()

        # GetDocumentBinary expected column order:
        # [0] filename  [1] file_binary
        cursor.execute("{CALL dbo.GetDocumentBinary (?)}", (document_id,))
        row = cursor.fetchone()
        conn.close()

        if row is None:
            raise HTTPException(status_code=404, detail="Document not found")

        filename = str(row[0]).strip()
        file_binary = row[1]

        return StreamingResponse(
            io.BytesIO(file_binary),
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'}
        )

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


@app.post("/api/applications/apply")
def apply_for_loan(req: ApplyLoanRequest):
    try:
        conn = get_conn()
        cursor = conn.cursor()

        cursor.execute(
            "{CALL dbo.SubmitLoanApplication (?, ?, ?, ?, ?)}",
            (req.userid, req.loan_type, req.amount, req.tenure, req.purpose)
        )
        new_row = cursor.fetchone()

        if new_row is None:
            conn.close()
            raise HTTPException(status_code=500, detail="Could not submit application.")

        application_id = str(new_row[0]).strip()

        conn.commit()
        conn.close()

        return {"status": "success", "application_id": application_id}

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── USER DASHBOARD: current application + status + progress ─────────────────
# Response shape consumed directly by user-dashboard.js renderApplication():
# has_application, application_id, loan_type, amount, tenure, submitted_on,
# status ("submitted" | "hr_verification" | "admin_approval" | "approved" |
# "rejected"), step_dates: { submitted, hr, admin }.

@app.get("/api/applications/current")
def get_current_application(userid: str = Query(...)):
    try:
        conn = get_conn()
        cursor = conn.cursor()
        cursor.execute("{CALL dbo.GetCurrentApplication (?)}", (userid,))
        row = cursor.fetchone()
        conn.close()

        if row is None:
            return {"has_application": False}

        return {
            "has_application": True,
            "application_id": str(row[0]).strip(),
            "loan_type": str(row[1]).strip(),
            "amount": str(row[2]).strip(),
            "tenure": str(row[3]).strip(),
            "submitted_on": str(row[4]).strip() if row[4] else None,
            "status": str(row[5]).strip(),
            "step_dates": {
                "submitted": str(row[6]).strip() if row[6] else None,
                "hr": str(row[7]).strip() if row[7] else None,
                "admin": str(row[8]).strip() if row[8] else None,
            },
        }

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── USER DASHBOARD: overview stat cards (right column) ───────────────────────

@app.get("/api/applications/overview")
def get_application_overview(userid: str = Query(...)):
    try:
        conn = get_conn()
        cursor = conn.cursor()

        # GetApplicationOverview is expected to return a single row:
        # [0] total_applications   [1] active   [2] pending_actions
        cursor.execute("{CALL dbo.GetApplicationOverview (?)}", (userid,))
        row = cursor.fetchone()
        conn.close()

        if row is None:
            return {"total_applications": 0, "active": 0, "pending_actions": 0}

        return {
            "total_applications": int(row[0] or 0),
            "active": int(row[1] or 0),
            "pending_actions": int(row[2] or 0),
        }

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── LOAN APPROVAL OFFICER: pending-decision queue ────────────────────────────
# Response shape consumed by officer-dashboard.js: applications: [{
#   application_id, applicant_name, loan_type, amount, submitted_on }, ...]

@app.get("/api/officer/queue")
def get_officer_queue():
    try:
        conn = get_conn()
        cursor = conn.cursor()

        # GetOfficerQueue returns every application still awaiting the
        # officer's eligibility check (not yet forwarded to admin).
        # Expected column order per row:
        # [0] application_id  [1] applicant_name  [2] loan_type
        # [3] amount          [4] submitted_on
        cursor.execute("{CALL dbo.GetOfficerQueue}")
        rows = cursor.fetchall()
        conn.close()

        applications = [
            {
                "application_id": str(row[0]).strip(),
                "applicant_name": str(row[1]).strip(),
                "loan_type": str(row[2]).strip(),
                "amount": str(row[3]).strip(),
                "submitted_on": str(row[4]).strip() if row[4] else None,
            }
            for row in rows
        ]

        return {"applications": applications}

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── APPLICATION DETAIL (shared shape: officer view + admin view) ────────────
# Response shape consumed by both officer-dashboard.js and admin-dashboard.js:
# applicant_name, application_id, loan_type, amount, tenure, income, purpose,
# documents: [{ document_id, doc_type, filename }, ...]. Admin's view
# additionally reads officer_name / officer_note, absent/None on the
# officer's own call.
#
# Documents are now sourced from DocumentStore via the applicant's userid
# (GetApplicationDetails is expected to also return the applicant's userid
# in column [7] so we know whose documents to pull) rather than the old
# per-application GetApplicationDocuments SP.

@app.get("/api/officer/applications/{application_id}")
def get_officer_application_detail(application_id: str):
    try:
        conn = get_conn()
        cursor = conn.cursor()

        # GetApplicationDetails expected column order:
        # [0] applicant_name  [1] application_id  [2] loan_type
        # [3] amount          [4] tenure          [5] income (nullable)
        # [6] purpose (nullable)  [7] applicant_userid
        cursor.execute("{CALL dbo.GetApplicationDetails (?)}", (application_id,))
        row = cursor.fetchone()

        if row is None:
            conn.close()
            raise HTTPException(status_code=404, detail="Application not found")

        applicant_userid = str(row[7]).strip() if len(row) > 7 and row[7] else None

        documents = []
        if applicant_userid:
            cursor.execute("{CALL dbo.GetUserDocuments (?)}", (applicant_userid,))
            doc_rows = cursor.fetchall()
            documents = [
                {
                    "document_id": str(doc[0]).strip(),
                    "doc_type": str(doc[1]).strip(),
                    "filename": str(doc[2]).strip(),
                }
                for doc in doc_rows
            ]

        conn.close()

        return {
            "applicant_name": str(row[0]).strip(),
            "application_id": str(row[1]).strip(),
            "loan_type": str(row[2]).strip(),
            "amount": str(row[3]).strip(),
            "tenure": str(row[4]).strip(),
            "income": str(row[5]).strip() if len(row) > 5 and row[5] else None,
            "purpose": str(row[6]).strip() if len(row) > 6 and row[6] else None,
            "documents": documents,
        }

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── LOAN APPROVAL OFFICER: forward application to admin ─────────────────────
# This is the officer's only decision power — confirming basic eligibility
# (documents present) and handing off to Admin. It does not approve or
# reject the loan itself. officer_id should be passed so the admin view
# can show "Forwarded by <officer name>".

@app.post("/api/officer/applications/{application_id}/forward")
def forward_application_to_admin(application_id: str, req: ForwardApplicationRequest = ForwardApplicationRequest()):
    try:
        conn = get_conn()
        cursor = conn.cursor()

        # ForwardApplicationToAdmin is expected to move the application's
        # status to "admin_approval" and stamp the officer-verification
        # step date/officer id, the same status value
        # /api/applications/current reads.
        cursor.execute(
            "{CALL dbo.ForwardApplicationToAdmin (?, ?, ?)}",
            (application_id, req.officer_id, req.note)
        )

        if cursor.rowcount == 0:
            conn.close()
            raise HTTPException(status_code=404, detail="Application not found")

        conn.commit()
        conn.close()

        return {"status": "success", "application_id": application_id}

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── ADMIN: applications awaiting decision ────────────────────────────────────
# Response shape consumed by admin-dashboard.js: applications: [{
#   application_id, applicant_name, loan_type, amount, forwarded_on }, ...]

@app.get("/api/admin/queue")
def get_admin_queue():
    try:
        conn = get_conn()
        cursor = conn.cursor()

        # GetAdminQueue returns every application the officer has already
        # forwarded (status = "admin_approval") and not yet decided.
        # Expected column order per row:
        # [0] application_id  [1] applicant_name  [2] loan_type
        # [3] amount          [4] forwarded_on
        cursor.execute("{CALL dbo.GetAdminQueue}")
        rows = cursor.fetchall()
        conn.close()

        applications = [
            {
                "application_id": str(row[0]).strip(),
                "applicant_name": str(row[1]).strip(),
                "loan_type": str(row[2]).strip(),
                "amount": str(row[3]).strip(),
                "forwarded_on": str(row[4]).strip() if row[4] else None,
            }
            for row in rows
        ]

        return {"applications": applications}

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── ADMIN: application detail, including the officer's verification note ────
# Same base shape as the officer's detail view (documents sourced from
# DocumentStore the same way), plus officer_name / officer_note so
# admin-dashboard.js can show "Approved by <officer name>" / what the
# officer confirmed before forwarding.

@app.get("/api/admin/applications/{application_id}")
def get_admin_application_detail(application_id: str):
    try:
        conn = get_conn()
        cursor = conn.cursor()

        # GetApplicationDetails expected column order:
        # [0] applicant_name  [1] application_id  [2] loan_type
        # [3] amount          [4] tenure          [5] income (nullable)
        # [6] purpose (nullable)  [7] applicant_userid
        cursor.execute("{CALL dbo.GetApplicationDetails (?)}", (application_id,))
        row = cursor.fetchone()

        if row is None:
            conn.close()
            raise HTTPException(status_code=404, detail="Application not found")

        applicant_userid = str(row[7]).strip() if len(row) > 7 and row[7] else None

        documents = []
        if applicant_userid:
            cursor.execute("{CALL dbo.GetUserDocuments (?)}", (applicant_userid,))
            doc_rows = cursor.fetchall()
            documents = [
                {
                    "document_id": str(doc[0]).strip(),
                    "doc_type": str(doc[1]).strip(),
                    "filename": str(doc[2]).strip(),
                }
                for doc in doc_rows
            ]

        # GetForwardingOfficer is expected to return the officer's name and
        # any note they left when forwarding (both nullable if not set).
        # Expected column order: [0] officer_name   [1] note
        cursor.execute("{CALL dbo.GetForwardingOfficer (?)}", (application_id,))
        officer_row = cursor.fetchone()
        conn.close()

        return {
            "applicant_name": str(row[0]).strip(),
            "application_id": str(row[1]).strip(),
            "loan_type": str(row[2]).strip(),
            "amount": str(row[3]).strip(),
            "tenure": str(row[4]).strip(),
            "income": str(row[5]).strip() if len(row) > 5 and row[5] else None,
            "purpose": str(row[6]).strip() if len(row) > 6 and row[6] else None,
            "documents": documents,
            "officer_name": str(officer_row[0]).strip() if officer_row and officer_row[0] else None,
            "officer_note": str(officer_row[1]).strip() if officer_row and len(officer_row) > 1 and officer_row[1] else None,
        }

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))


# ─── ADMIN: approve / reject decision (final step in the workflow) ───────────

@app.post("/api/admin/applications/{application_id}/decision")
def set_application_decision(application_id: str, req: ApplicationDecisionRequest):
    if req.decision == "rejected" and not req.reason:
        raise HTTPException(status_code=400, detail="A reason is required to reject an application.")

    try:
        conn = get_conn()
        cursor = conn.cursor()

        # SetApplicationDecision is expected to set status to "approved" or
        # "rejected", stamp admin_decided_date, and store admin_id/reason.
        cursor.execute(
            "{CALL dbo.SetApplicationDecision (?, ?, ?, ?)}",
            (application_id, req.decision, req.reason, req.admin_id)
        )

        if cursor.rowcount == 0:
            conn.close()
            raise HTTPException(status_code=404, detail="Application not found")

        conn.commit()
        conn.close()

        return {"status": "success", "application_id": application_id, "decision": req.decision}

    except pyodbc.Error as db_error:
        raise HTTPException(status_code=500, detail=str(db_error))