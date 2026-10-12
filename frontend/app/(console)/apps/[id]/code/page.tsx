"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";

import CodeBrowser from "@/components/code/CodeBrowser";
import { Skeleton } from "@/components/ui";

export default function CodePage() {
  const { id } = useParams<{ id: string }>();
  // The browser keeps its place in the URL, which needs a Suspense boundary.
  return (
    <Suspense fallback={<Skeleton className="h-[32rem]" />}>
      <CodeBrowser appId={id} />
    </Suspense>
  );
}
