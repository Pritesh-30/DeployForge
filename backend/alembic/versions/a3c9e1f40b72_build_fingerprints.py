"""Remember what each image was built from, so identical builds are skipped.

Revision ID: a3c9e1f40b72
Revises: f7b2d04e8a61
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "a3c9e1f40b72"
down_revision = "f7b2d04e8a61"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("deployments", sa.Column("build_fingerprint", sa.String(length=64), nullable=True))
    op.add_column("deployments", sa.Column("reused_from_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_index(
        "ix_deployments_repository_commit", "deployments", ["repository_id", "commit_sha"]
    )


def downgrade() -> None:
    op.drop_index("ix_deployments_repository_commit", table_name="deployments")
    op.drop_column("deployments", "reused_from_id")
    op.drop_column("deployments", "build_fingerprint")
