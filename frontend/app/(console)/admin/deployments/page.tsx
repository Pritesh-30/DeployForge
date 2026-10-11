import { redirect } from "next/navigation";

/** Projects became Apps: one row per app, its deployments inside it. */
export default function AdminDeploymentsPage() {
  redirect("/admin/apps");
}
