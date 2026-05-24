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
    profile = (
        status.get("data", {}).get("profile")
        or status.get("profile")
        or {}
    )
    uid = profile.get("userId")
    if uid and store:
        await store.save_auth_account(str(uid), profile)
    return status


@router.post("/refresh")
async def refresh_login():
    return await netease.login_refresh()
