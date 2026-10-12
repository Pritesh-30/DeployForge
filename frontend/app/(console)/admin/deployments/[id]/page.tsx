"use client";

import { useParams } from "next/navigation";

import DeploymentDetail from "@/components/app/DeploymentDetail";
import { adminApi } from "@/lib/appApi";

export default function AdminDeploymentPage() {
  const { id } = useParams<{ id: string }>();
  return <DeploymentDetail id={id} api={adminApi} />;
}
