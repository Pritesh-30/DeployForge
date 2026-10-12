"""Store Claude's explanation of a failed deployment.

Revision ID: f7b2d04e8a61
Revises: e5a19c3d7f20
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "f7b2d04e8a61"
down_revision = "e5a19c3d7f20"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("deployments", sa.Column("ai_diagnosis", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("deployments", "ai_diagnosis")
