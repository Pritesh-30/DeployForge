"""Recording what administrators do to other people's things."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditEvent
from app.models.user import User


async def audit(
    db: AsyncSession,
    actor: User,
    action: str,
    *,
    target_type: str,
    target_id: object | None = None,
    target_label: str | None = None,
    subject_user_id: uuid.UUID | None = None,
    detail: dict[str, Any] | None = None,
    commit: bool = True,
) -> AuditEvent:
    """Append one entry. Never edited or deleted afterwards."""
    event = AuditEvent(
        actor_id=actor.id,
        actor_email=actor.email,
        actor_role=actor.role.value,
        action=action,
        target_type=target_type,
        target_id=str(target_id) if target_id is not None else None,
        target_label=target_label,
        subject_user_id=subject_user_id,
        detail=detail,
    )
    db.add(event)
    if commit:
        await db.commit()
    return event
