"""Record which environment each deployment was started with.

Revision ID: b8d2f6a1c934
Revises: a3c9e1f40b72
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "b8d2f6a1c934"
down_revision = "a3c9e1f40b72"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("deployments", sa.Column("runtime_env", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("deployments", "runtime_env")
