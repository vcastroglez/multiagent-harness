#!/usr/bin/env python3
"""Authenticate a local Linux account through PAM.

Protocol: one JSON object on stdin: {"username": "...", "password": "..."}
Exit codes: 0 = authenticated, 1 = rejected, 2 = backend/usage error.

The password never appears in argv, environment, logs, or stdout. PAM's
conversation callback receives it in memory. Uses the system PAM stack, so
account expiry / nologin / fail-delay policies apply exactly as for `login`.
"""
import ctypes
import json
import os
import re
import sys
from ctypes import CFUNCTYPE, POINTER, Structure, byref, c_char_p, c_int, c_size_t, c_void_p, cast

PAM_SUCCESS = 0
PAM_PROMPT_ECHO_OFF = 1
PAM_PROMPT_ECHO_ON = 2
PAM_ERROR_MSG = 3
PAM_TEXT_INFO = 4

MAX_USER = 64
MAX_PASS = 1024


class PamMessage(Structure):
    _fields_ = [("msg_style", c_int), ("msg", c_char_p)]


class PamResponse(Structure):
    _fields_ = [("resp", c_void_p), ("resp_retcode", c_int)]


CONV_FUNC = CFUNCTYPE(
    c_int,
    c_int,
    POINTER(POINTER(PamMessage)),
    POINTER(POINTER(PamResponse)),
    c_void_p,
)


class PamConv(Structure):
    _fields_ = [("conv", CONV_FUNC), ("appdata_ptr", c_void_p)]


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_PASS + MAX_USER + 512)
        payload = json.loads(raw.decode("utf-8"))
        username = payload.get("username")
        password = payload.get("password")
    except Exception:
        return 2

    if not isinstance(username, str) or not re.fullmatch(r"[A-Za-z0-9._@-]{1,64}", username):
        return 2
    if username.startswith("-"):
        return 2
    if not isinstance(password, str) or not password or len(password) > MAX_PASS:
        return 1

    service = os.environ.get("DASHBOARD_PAM_SERVICE", "login")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", service):
        return 2

    libpam = ctypes.CDLL("libpam.so.0")
    libc = ctypes.CDLL("libc.so.6")
    libc.strdup.argtypes = [c_char_p]
    libc.strdup.restype = c_void_p
    libc.calloc.argtypes = [c_size_t, c_size_t]
    libc.calloc.restype = c_void_p

    user_b = username.encode("utf-8")
    pass_b = password.encode("utf-8")
    state = {"username": user_b, "password": pass_b}

    def conversation(num_msg, msg, resp, _appdata):
        out = cast(libc.calloc(num_msg, ctypes.sizeof(PamResponse)), POINTER(PamResponse))
        if not out:
            return 5  # PAM_BUF_ERR
        for i in range(num_msg):
            style = msg[i].contents.msg_style
            if style == PAM_PROMPT_ECHO_OFF:
                text = state["password"]
            elif style == PAM_PROMPT_ECHO_ON:
                text = state["username"]
            else:
                text = b""
            out[i].resp = libc.strdup(text)
            out[i].resp_retcode = 0
        resp[0] = out
        return PAM_SUCCESS

    callback = CONV_FUNC(conversation)
    conv = PamConv(callback, None)
    pamh = c_void_p()

    libpam.pam_start.argtypes = [c_char_p, c_char_p, POINTER(PamConv), POINTER(c_void_p)]
    libpam.pam_start.restype = c_int
    libpam.pam_authenticate.argtypes = [c_void_p, c_int]
    libpam.pam_authenticate.restype = c_int
    libpam.pam_acct_mgmt.argtypes = [c_void_p, c_int]
    libpam.pam_acct_mgmt.restype = c_int
    libpam.pam_end.argtypes = [c_void_p, c_int]
    libpam.pam_end.restype = c_int

    rc = libpam.pam_start(service.encode("utf-8"), user_b, byref(conv), byref(pamh))
    if rc != PAM_SUCCESS:
        return 2

    rc = libpam.pam_authenticate(pamh, 0)
    if rc == PAM_SUCCESS:
        rc = libpam.pam_acct_mgmt(pamh, 0)
    libpam.pam_end(pamh, rc)

    if os.environ.get("PAM_AUTH_DEBUG") == "1" and rc != PAM_SUCCESS:
        # Never log the password; numeric code only.
        sys.stderr.write("pam_auth: rejected (rc=%d)\n" % rc)
    return 0 if rc == PAM_SUCCESS else 1


if __name__ == "__main__":
    sys.exit(main())
