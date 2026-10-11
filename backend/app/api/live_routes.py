"""The console's live update stream. See app/runtime/live.py."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.auth.dependencies import CurrentUser
from app.models.user import UserRole
from app.runtime import live, streams

router = APIRouter(tags=["live"])


@router.get("/live")
async def live_stream(request: Request, current_user: CurrentUser) -> StreamingResponse:
    """
    Server-sent `change` events whenever one of the caller's deployments
    moves — or anyone's, for an administrator. Each says which app and
    deployment changed; the page re-reads them.
    """
    channel = live.ALL_CHANNEL if current_user.role == UserRole.ADMIN else live.user_channel(current_user.id)
    return StreamingResponse(
        live.stream(channel, request.is_disconnected),
        media_type="text/event-stream",
        # no-transform: a compressing proxy (Next.js in front of the API,
        # ngrok) would otherwise hold the stream back to compress it.
        headers=streams.SSE_HEADERS,
    )
