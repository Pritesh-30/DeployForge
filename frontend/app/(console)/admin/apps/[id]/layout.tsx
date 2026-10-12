"use client";

import { useParams } from "next/navigation";

import AppFrame from "@/components/app/AppFrame";
import { adminApi } from "@/lib/appApi";

/**
 * A student's app as an administrator sees it: the same screens its owner
 * has, with the controls an administrator holds — and without the code,
 * which would mean reading it with the student's own GitHub token.
 */
export default function AdminAppLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  return <AppFrame id={id} api={adminApi}>{children}</AppFrame>;
}
