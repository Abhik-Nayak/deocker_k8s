from fastapi import APIRouter, Depends, HTTPException, status

from app.repositories import users
from app.schemas import LoginInput, RegisterInput, TokenOut, UserOut
from app.security import (
    create_access_token,
    get_current_user,
    hash_password,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterInput):
    if await users.find_by_email(body.email):
        raise HTTPException(status_code=409, detail="Email already registered")

    user = await users.create(body.email, hash_password(body.password))
    user_id = str(user["id"])

    return TokenOut(
        access_token=create_access_token(user_id, user["email"]),
        user=UserOut(id=user_id, email=user["email"]),
    )


@router.post("/login", response_model=TokenOut)
async def login(body: LoginInput):
    user = await users.find_by_email(body.email)
    if not user or not verify_password(body.password, user["password"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    user_id = str(user["id"])

    return TokenOut(
        access_token=create_access_token(user_id, user["email"]),
        user=UserOut(id=user_id, email=user["email"]),
    )


@router.get("/me", response_model=UserOut)
async def me(current=Depends(get_current_user)):
    return UserOut(id=current["id"], email=current["email"])
