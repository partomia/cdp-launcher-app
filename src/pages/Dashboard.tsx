import { Link } from "react-router-dom";
import { PlusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Dashboard() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <PlusCircle className="h-7 w-7 text-muted-foreground" />
        </div>
        <h2 className="text-[18px] font-semibold mb-2">No clusters yet</h2>
        <p className="text-[14px] text-muted-foreground mb-6">
          Click 'New Install' to create your first CDP cluster.
        </p>
        <Button asChild>
          <Link to="/install">
            <PlusCircle className="h-4 w-4" />
            New Install
          </Link>
        </Button>
      </div>
    </div>
  );
}
