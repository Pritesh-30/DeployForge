"""Audit log, and turning push deploys off per app.

Revision ID: e5a19c3d7f20
Revises: d41a7c2e9b10

`audit_events` records what administrators do to students' things, so "who
stopped my app?" has an answer. `repositories.auto_deploy` lets a student push
without redeploying, for when the branch is mid-way through something broken.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "e5a19c3d7f20"
down_revision = "d41a7c2e9b10"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "repositories",
        sa.Column("auto_deploy", sa.Boolean(), nullable=False, server_default="true"),
    )
    op.create_table(
        "audit_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("actor_email", sa.String(320), nullable=False),
        sa.Column("actor_role", sa.String(16), nullable=False),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("target_type", sa.String(32), nullable=False),
        sa.Column("target_id", sa.String(64), nullable=True),
        sa.Column("target_label", sa.String(512), nullable=True),
        sa.Column("subject_user_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("detail", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_audit_events_created_at", "audit_events", ["created_at"])
    op.create_index("ix_audit_events_actor_id", "audit_events", ["actor_id"])
    op.create_index("ix_audit_events_action", "audit_events", ["action"])
    op.create_index("ix_audit_events_subject_user_id", "audit_events", ["subject_user_id"])


def downgrade() -> None:
    op.drop_table("audit_events")
    op.drop_column("repositories", "auto_deploy")
