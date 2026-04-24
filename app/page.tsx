import { LiveDashboard } from "@/components/live-dashboard";
import { formatSnapshotError, getScannerData } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

export default async function Page() {
  try {
    const initialScanner = await getScannerData();
    return <LiveDashboard initialScanner={initialScanner} />;
  } catch (error) {
    const message = formatSnapshotError(error);
    return <LiveDashboard initialScanner={null} initialError={message} />;
  }
}
