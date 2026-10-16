"""Shared request shapes and stable, plain-language errors."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateRecord(StrictModel):
    data: dict[str, Any]


class UpdateRecord(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)
    data: dict[str, Any]


class PreferencesUpdate(StrictModel):
    expected_revision: int = Field(ge=0, strict=True)
    data: dict[str, Any]


class ReviewFact(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)
    decision: str = Field(pattern="^(confirmed|rejected)$")
    note: str = Field(default="", max_length=4000)


class Registration(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=256)
    display_name: str = Field(min_length=1, max_length=120)


class Login(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)
