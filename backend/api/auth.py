from fastapi import APIRouter

router = APIRouter(prefix="/api/auth", tags=["auth"])

netease = None
store = None


@router.get("/qr/key")
async def get_qr_key():
    return await netease.qr_key()


@router.get("/qr/create")
async def create_qr(key: str):
    return await netease.qr_create(key)


@router.get("/qr/check")
async def check_qr(key: str):
    return await netease.qr_check(key)


@router.get("/status")
async def login_status():
    status = await netease.login_status()
    if not isinstance(status, dict):
        return {"data": {"code": -1, "account": None, "profile": None}}

    profile = _extract_profile(status)
    uid = profile.get("userId")
    if uid and store:
        try:
            await store.save_auth_account(str(uid), profile)
        except Exception:
            pass
    return status


@router.post("/refresh")
async def refresh_login():
    return await netease.login_refresh()


def _extract_profile(status: dict) -> dict:
    data = status.get("data")
    profile = data.get("profile") if isinstance(data, dict) else None
    if not isinstance(profile, dict):
        fallback = status.get("profile")
        profile = fallback if isinstance(fallback, dict) else {}
    return profile
