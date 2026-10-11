"""
AuditEvent — who did what to whom, platform-wide.

`DeploymentEvent` is a deployment's own timeline. This is the platform's: an
administrator stopping a student's app, suspending a project, changing a
quota, revoking deploy rights. On a machine shared by a whole class, "who
stopped my app?" deserves an answer that does not depend on anyone's memory.

Append-only. The actor's email is copied in rather than only referenced, so
the record still says who acted after that account is deleted.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class AuditEvent(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "audit_events"
    __table_args__ = (Index("ix_audit_events_created_at", "created_at"),)

    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    actor_email: Mapped[str] = mapped_column(String(320), nullable=False)
    actor_role: Mapped[str] = mapped_column(String(16), nullable=False)
    # Dotted verb, e.g. "app.stop", "app.suspend", "user.quota".
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    target_type: Mapped[str] = mapped_column(String(32), nullable=False)
    target_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    target_label: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # The owner of what was acted on, so a student can be shown what an
    # administrator did to their things.
    subject_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    detail: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    def __repr__(self) -> str:
        return f"<AuditEvent {self.action} by {self.actor_email}>"
