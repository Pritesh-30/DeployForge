"use client";

import { useEffect, useState } from "react";

import { useApp } from "@/components/app/AppFrame";
import { ActivityList } from "@/components/app/ActivityList";
import { Skeleton } from "@/components/ui";
import type { Activity } from "@/lib/apps";

/** Everything that happened to this app, newest first. */
export default function AppActivity() {
  const { app, api } = useApp();
  const [items, setItems] = useState<Activity[] | null>(null);

  useEffect(() => {
    let active = true;
    api.activity(app.id).then((a) => active && setItems(a)).catch(() => active && setItems([]));
    return () => {
      active = false;
    };
  }, [api, app.id, app.updated_at, app.current?.status]);

  if (!items) return <Skeleton className="h-96" />;
  return <ActivityList items={items} showApp={false} deploymentHref={api.deploymentHref} />;
}
