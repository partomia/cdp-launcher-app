import { useParams } from "react-router-dom";

export default function ClusterDetail() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="p-8">
      <p className="text-[14px] text-muted-foreground">
        Cluster {id} — coming in prompt 6
      </p>
    </div>
  );
}
