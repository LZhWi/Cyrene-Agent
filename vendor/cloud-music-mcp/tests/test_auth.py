import os
import tempfile
import pytest
from cloud_music_mcp import auth


@pytest.fixture(autouse=True)
def tmp_storage(monkeypatch):
    d = tempfile.mkdtemp()
    monkeypatch.setenv("CYRENE_MUSIC_STORAGE_DIR", d)
    auth._reset_for_tests()
    yield d


def test_begin_login_returns_session_and_qr_text():
    # monkey-patch the pyncm call so test does not require network
    auth.apis.login.LoginQrcodeUnikey = lambda dtype=1: {"code": 200, "unikey": "abc-unikey"}
    out = auth.begin_login()
    assert "loginSessionId" in out
    assert out["qrContent"] == "https://music.163.com/login?codekey=abc-unikey"
    assert out["pollIntervalMs"] == 2000
    assert out["expiresAt"] > 0


def test_begin_login_when_already_active_returns_login_already_active():
    auth.apis.login.LoginQrcodeUnikey = lambda dtype=1: {"code": 200, "unikey": "u1"}
    first = auth.begin_login()
    auth.apis.login.LoginQrcodeUnikey = lambda dtype=1: {"code": 200, "unikey": "u2"}
    second = auth.begin_login()
    assert second["status"] == "login_already_active"
    assert second["activeSessionId"] == first["loginSessionId"]


def test_check_login_maps_pyncm_codes():
    auth.apis.login.LoginQrcodeUnikey = lambda dtype=1: {"code": 200, "unikey": "u3"}
    begin = auth.begin_login()
    sid = begin["loginSessionId"]

    auth.apis.login.LoginQrcodeCheck = lambda unikey, type=1: {"code": 801}
    assert auth.check_login(sid)["status"] == "waiting_scan"

    auth.apis.login.LoginQrcodeCheck = lambda unikey, type=1: {"code": 802}
    assert auth.check_login(sid)["status"] == "waiting_confirm"

    auth.apis.login.LoginQrcodeCheck = lambda unikey, type=1: {"code": 800}
    out = auth.check_login(sid)
    assert out["status"] == "expired"


def test_check_login_authorized_returns_credential_revision_and_persists():
    auth.apis.login.LoginQrcodeUnikey = lambda dtype=1: {"code": 200, "unikey": "u4"}
    begin = auth.begin_login()
    sid = begin["loginSessionId"]

    auth.apis.login.LoginQrcodeCheck = lambda unikey, type=1: {"code": 803, "cookie": "a=1; b=2"}
    auth.apis.login.WriteLoginInfo = lambda c: None
    auth.apis.login.GetCurrentLoginStatus = lambda: {"code": 200, "profile": {"nickname": "alice", "userId": 42}}
    out = auth.check_login(sid)
    assert out["status"] == "authorized"
    assert out["credentialsPersisted"] is True
    assert out["credentialRevision"] >= 1
    assert out["profile"]["nickname"] == "alice"


def test_cancel_login_is_idempotent():
    auth.apis.login.LoginQrcodeUnikey = lambda dtype=1: {"code": 200, "unikey": "u5"}
    begin = auth.begin_login()
    sid = begin["loginSessionId"]
    auth.cancel_login(sid)
    auth.cancel_login(sid)  # must not raise
    auth.apis.login.LoginQrcodeCheck = lambda unikey, type=1: {"code": 801}
    assert auth.check_login(sid)["status"] in ("expired", "cancelled")
