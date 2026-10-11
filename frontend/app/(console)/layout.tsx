import { ConsoleSession } from "@/components/Session";

/**
 * Every signed-in page: the session is resolved once here and the shell stays
 * mounted while the student or administrator moves between pages.
 */
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleSession>{children}</ConsoleSession>;
}
