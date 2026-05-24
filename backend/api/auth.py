from fastapi import APIRouter

router = APIRouter(prefix="/api/auth", tags=["auth"])

netease = None


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
    return await netease.login_status()
