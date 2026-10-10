"""record GitHub Actions builds

Revision ID: d41a7c2e9b10
Revises: c8e42f1a97b3
Create Date: 2026-10-10 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d41a7c2e9b10"
down_revision: Union[str, None] = "c8e42f1a97b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("deployments", sa.Column("ci_run_id", sa.BigInteger(), nullable=True))
    op.add_column("deployments", sa.Column("ci_run_url", sa.Text(), nullable=True))
    op.add_column(
        "deployments", sa.Column("ci_trigger", sa.String(length=32), nullable=True)
    )
    op.add_column(
        "deployments",
        sa.Column(
            "built_on_actions", sa.Boolean(), server_default="false", nullable=False
        ),
    )


def downgrade() -> None:
    op.drop_column("deployments", "built_on_actions")
    op.drop_column("deployments", "ci_trigger")
    op.drop_column("deployments", "ci_run_url")
    op.drop_column("deployments", "ci_run_id")
