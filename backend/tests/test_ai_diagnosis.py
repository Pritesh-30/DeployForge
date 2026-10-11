"""
AI diagnosis: asked for, stored, and never a requirement.

The Anthropic client is replaced with a recording fake — these tests check
what DeployForge sends and does with the answer, and must never spend money.
"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace

import pytest

from app.builder import ai_diagnosis
from app.models.deployment import BuildMethod, Deployment, DeploymentStatus
from app.models.repository import DetectedType, Repository


class FakeMessages:
    def __init__(self, answer=None, stop_reason="end_turn"):
        self.calls = []
        self.answer = answer or {"summary": "Missing module.", "cause": "react not installed",
                                 "fix": "npm install react", "confidence": "high"}
        self.stop_reason = stop_reason

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            stop_reason=self.stop_reason,
            model=kwargs["model"],
            content=[SimpleNamespace(type="text", text=json.dumps(self.answer))],
        )


@pytest.fixture
def claude(monkeypatch):
    messages = FakeMessages()
    monkeypatch.setattr(ai_diagnosis.settings, "anthropic_api_key", "sk-test")
    monkeypatch.setattr(ai_diagnosis, "_client",
                        lambda: SimpleNamespace(beta=SimpleNamespace(messages=messages)))
    return messages


async def test_unconfigured_means_unavailable(monkeypatch):
    monkeypatch.setattr(ai_diagnosis.settings, "anthropic_api_key", "")
    assert ai_diagnosis.available() is False
    with pytest.raises(ai_diagnosis.DiagnosisUnavailableError):
        await ai_diagnosis.explain("log", {})


async def test_the_request_is_structured_and_bounded(claude):
    answer = await ai_diagnosis.explain("x" * 50_000 + "Cannot find module 'react'", {"framework": "nextjs"})
    sent = claude.calls[0]
    assert sent["output_config"]["format"]["type"] == "json_schema"
    assert sent["fallbacks"] == "default"
    content = sent["messages"][0]["content"]
    assert "Cannot find module 'react'" in content
    assert len(content) < 20_000, "the whole log was sent, not its tail"
    assert answer["confidence"] == "high"


async def test_a_refusal_is_reported_not_crashed_on(claude):
    claude.stop_reason = "refusal"
    with pytest.raises(ai_diagnosis.DiagnosisUnavailableError):
        await ai_diagnosis.explain("log", {})


async def test_diagnosis_is_stored_and_not_paid_for_twice(client, db_session, user_credentials, claude, tmp_path):
    res = await client.post("/auth/signup", json=user_credentials)
    headers = {"Authorization": f"Bearer {res.json()['access_token']}"}
    user_id = uuid.UUID(res.json()["user"]["id"])
    repo = Repository(user_id=user_id, github_repo_id=9, name="r", full_name="o/r", default_branch="main",
                      clone_url="https://x", detected_type=DetectedType.FRAMEWORK, detected_framework="nextjs")
    db_session.add(repo)
    await db_session.flush()
    log = tmp_path / "build.log"
    log.write_bytes(b"step\nError: Cannot find module 'react'\n")
    dep = Deployment(repository_id=repo.id, user_id=user_id, status=DeploymentStatus.FAILED,
                     build_method=BuildMethod.BUILDPACK, logs_ref=str(log))
    db_session.add(dep)
    await db_session.commit()

    first = await client.post(f"/deployments/{dep.id}/diagnose", headers=headers)
    second = await client.post(f"/deployments/{dep.id}/diagnose", headers=headers)
    assert first.status_code == 200
    assert first.json()["summary"] == "Missing module."
    assert second.json() == first.json()
    assert len(claude.calls) == 1

    shown = (await client.get(f"/deployments/{dep.id}", headers=headers)).json()
    assert shown["ai_diagnosis"]["fix"] == "npm install react"


async def test_only_failures_are_diagnosed(client, db_session, user_credentials, claude):
    res = await client.post("/auth/signup", json=user_credentials)
    headers = {"Authorization": f"Bearer {res.json()['access_token']}"}
    user_id = uuid.UUID(res.json()["user"]["id"])
    repo = Repository(user_id=user_id, github_repo_id=10, name="r", full_name="o/r", default_branch="main",
                      clone_url="https://x", detected_type=DetectedType.DOCKER)
    db_session.add(repo)
    await db_session.flush()
    dep = Deployment(repository_id=repo.id, user_id=user_id, status=DeploymentStatus.RUNNING)
    db_session.add(dep)
    await db_session.commit()

    assert (await client.post(f"/deployments/{dep.id}/diagnose", headers=headers)).status_code == 409
    assert claude.calls == []


async def test_meta_reports_whether_ai_is_available(client, monkeypatch):
    monkeypatch.setattr(ai_diagnosis.settings, "anthropic_api_key", "")
    assert (await client.get("/meta")).json()["ai_diagnosis"] is False
