import type { HealthStatus } from "./use-health-check";

interface ConnectionStatusProps {
  status: HealthStatus;
}

const STATUS_LABEL: Record<HealthStatus, string> = {
  checking: "確認中...",
  connected: "接続 OK",
  disconnected: "サーバー未接続",
};

function ConnectionStatus({ status }: ConnectionStatusProps) {
  return <span>{STATUS_LABEL[status]}</span>;
}

export default ConnectionStatus;
