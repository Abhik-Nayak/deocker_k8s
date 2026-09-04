from pydantic import BaseModel, EmailStr, Field


class RegisterInput(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6)


class LoginInput(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: EmailStr


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
