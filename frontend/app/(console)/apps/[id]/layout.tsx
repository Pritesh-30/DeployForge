"use client";

import { useParams } from "next/navigation";

import AppFrame from "@/components/app/AppFrame";
import { ownerApi } from "@/lib/appApi";

/** A student's app: one frame, one load, shared by every tab beneath it. */
export default function OwnerAppLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  return <AppFrame id={id} api={ownerApi}>{children}</AppFrame>;
}
