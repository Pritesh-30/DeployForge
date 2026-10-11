"use client";

import { useParams } from "next/navigation";

import DeploymentDetail from "@/components/app/DeploymentDetail";
import { ownerApi } from "@/lib/appApi";

export default function DeploymentPage() {
  const { id } = useParams<{ id: string }>();
  return <DeploymentDetail id={id} api={ownerApi} />;
}
