import { LiveDashboard } from "@/components/live-dashboard";
import { formatSnapshotError, getPageData } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

export default async function Page() {
  try {
    const initialData = await getPageData();
    return (
      <LiveDashboard
        initialDashboard={initialData.dashboard}
        initialScanner={initialData.scanner}
      />
    );
  } catch (error) {
    const message = formatSnapshotError(error);
    return (
      <LiveDashboard
        initialDashboard={null}
        initialScanner={null}
        initialError={message}
      />
    );
  }
}
