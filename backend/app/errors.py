"""The error envelope — Contract 8.

Every non-2xx response body, from every endpoint, without exception, is
``{"error": "<a complete, user-showable sentence.>"}``. There is no ``detail``
key anywhere: FastAPI's default envelope is overridden below, including for
request-validation failures, which is the one FastAPI emits without asking.
"""

import logging
from typing import Any, Dict

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("taskflow.errors")

#: 500s never leak internals (Contract 8).
INTERNAL_ERROR_MESSAGE = "Something went wrong on our end."

#: Fallbacks for statuses raised without an explicit sentence.
_DEFAULT_MESSAGES: Dict[int, str] = {
    status.HTTP_400_BAD_REQUEST: "The request was malformed.",
    status.HTTP_401_UNAUTHORIZED: "Not authenticated.",
    status.HTTP_403_FORBIDDEN: "You do not have access to that.",
    status.HTTP_404_NOT_FOUND: "Not found.",
    status.HTTP_405_METHOD_NOT_ALLOWED: "That method is not allowed here.",
    status.HTTP_409_CONFLICT: "That conflicts with the current state.",
    status.HTTP_422_UNPROCESSABLE_ENTITY: "The request was invalid.",
}


class APIError(HTTPException):
    """An HTTPException whose detail is already a user-showable sentence."""

    def __init__(self, status_code: int, message: str, headers: Any = None) -> None:
        super().__init__(status_code=status_code, detail=message, headers=headers)


def error_response(status_code: int, message: str, headers: Any = None) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": message}, headers=headers)


def _sentence_for_validation_error(exc: RequestValidationError) -> str:
    """Turn FastAPI's structured validation error into one showable sentence.

    Routes raise :class:`APIError` with the exact wording Contract 1-5 specify
    for the validation failures those contracts name. This handler only catches
    what is left: a malformed body, a wrong JSON type, a missing field on a
    request our own client would never send.
    """
    errors = exc.errors()
    if not errors:
        return _DEFAULT_MESSAGES[status.HTTP_422_UNPROCESSABLE_ENTITY]

    first = errors[0]
    location = [str(part) for part in first.get("loc", ()) if part not in ("body", "query", "path")]
    field = location[-1] if location else None
    kind = first.get("type", "")

    if field and kind == "missing":
        return "{} is required.".format(field.replace("_", " ").capitalize())
    if field:
        return "{} is not valid.".format(field.replace("_", " ").capitalize())
    if kind in ("json_invalid", "value_error.jsondecode"):
        return "The request body could not be read as JSON."
    return _DEFAULT_MESSAGES[status.HTTP_422_UNPROCESSABLE_ENTITY]


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail
        if isinstance(detail, str) and detail:
            message = detail
        else:
            message = _DEFAULT_MESSAGES.get(exc.status_code, INTERNAL_ERROR_MESSAGE)
        headers = getattr(exc, "headers", None)
        return error_response(exc.status_code, message, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # Contract 8: validation failures are 422 with a sentence, not FastAPI's
        # default 422 with a `detail` array.
        return error_response(
            status.HTTP_422_UNPROCESSABLE_ENTITY, _sentence_for_validation_error(exc)
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return error_response(status.HTTP_500_INTERNAL_SERVER_ERROR, INTERNAL_ERROR_MESSAGE)
